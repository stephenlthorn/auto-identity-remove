/**
 * lib/lock.js
 *
 * Process-level lock file for watcher.js. Prevents two instances from racing
 * on state.json.
 *
 * acquire(lockPath, opts):
 *   - Creates lockPath exclusively ('wx') holding {pid, host, startedAt, ts}.
 *   - If lockPath exists and is NOT stale, throws
 *     new Error('LockError: held by pid N ...').
 *   - A lock is stale when (CORE-12 / CFG-5):
 *       * its pid is our own and this process did not take it in this run
 *         (a container restart reuses low pids, so our pid is always "alive"),
 *       * or its pid is dead (only judged when the lock was written on THIS
 *         host: a pid from another container means nothing here),
 *       * or it is older than the max age, whoever holds it (a pid recycled by
 *         an unrelated process after a reboot would otherwise hold it forever).
 *   - A stale lock is replaced under a short-lived takeover guard
 *     (<lockPath>.takeover, itself an exclusive create): re-check that the lock
 *     is still the stale one, unlink it, exclusive-create ours. Two processes
 *     that both saw the same stale lock cannot both win.
 *   opts.isAlive:   optional fn(pid) => bool, for testability.
 *   opts.maxAgeMs:  stale age; default AIDR_LOCK_MAX_AGE_HOURS hours, else 6 hours.
 *   opts.hostname:  optional string, for testability.
 *
 * release(lockPath):
 *   - Removes lockPath if (and only if) this process holds it. Ignores ENOENT.
 *   - Locks still held when the process exits (process.exit() inside a locked
 *     section skips `finally`) are released by an 'exit' hook.
 *
 * isAlive(pid):
 *   - Returns true if the process exists (process.kill(pid, 0) succeeds, or
 *     fails with EPERM because it belongs to another user).
 */

const fs = require('fs');
const os = require('os');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// An unparseable lock this young is a writer between create and write, not debris.
const UNREADABLE_GRACE_MS = 2000;
// A takeover guard this old was left by a process that died mid-takeover.
const TAKEOVER_GUARD_STALE_MS = 30 * 1000;

// Lock paths this process took and has not released. Distinguishes "we hold it
// right now" (refuse a second acquire) from "a previous process with our pid
// left it behind" (stale).
const held = new Set();
let exitHookInstalled = false;

/**
 * Check if a process is alive using signal 0 (no-op probe).
 * EPERM means it exists but belongs to another user, so it is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function resolveMaxAgeMs(opts) {
  if (Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0) return opts.maxAgeMs;
  const hours = Number(process.env.AIDR_LOCK_MAX_AGE_HOURS);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return DEFAULT_MAX_AGE_MS;
}

function buildPayload(host) {
  return JSON.stringify({
    pid: process.pid,
    host,
    // When this process started, so a holder can be told apart from a later
    // process that happens to reuse the pid.
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    // When the lock was taken; the age limit counts from here.
    ts: new Date().toISOString(),
  });
}

function fileAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function unlinkQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function lockError(holder, lockPath) {
  const pid = holder && Number(holder.pid) > 0 ? Number(holder.pid) : '?';
  const where = holder && holder.host ? ` on ${holder.host}` : '';
  const since = holder && holder.ts ? ` since ${holder.ts}` : '';
  return new Error(
    `LockError: held by pid ${pid}${where}${since}. If you are sure no other run is active, delete ${lockPath}`
  );
}

function parseHolder(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock may be replaced.
 * @returns {{ stale: boolean, holder: object|null }}
 */
function assess(raw, lockPath, ctx) {
  const holder = parseHolder(raw);

  if (!holder) {
    const age = fileAgeMs(lockPath);
    return { stale: !(age !== null && age < UNREADABLE_GRACE_MS), holder: null };
  }

  const recordedAt = Date.parse(holder.ts);
  const age = Number.isNaN(recordedAt) ? fileAgeMs(lockPath) : Date.now() - recordedAt;
  if (age !== null && age > ctx.maxAgeMs) return { stale: true, holder };

  // Pids are only meaningful on the host that wrote them. Locks from before the
  // host field existed are treated as local.
  const sameHost = !holder.host || holder.host === ctx.host;
  if (!sameHost) return { stale: false, holder };

  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { stale: true, holder };
  if (pid === process.pid) return { stale: true, holder };
  if (!ctx.isAlive(pid)) return { stale: true, holder };
  return { stale: false, holder };
}

function tryCreate(lockPath, payload) {
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function claimGuard(guardPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(guardPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = fileAgeMs(guardPath);
      if (age === null || age < TAKEOVER_GUARD_STALE_MS) return false; // someone is mid-takeover
      unlinkQuietly(guardPath); // left behind by a crashed process; clear it and try once more
    }
  }
  return false;
}

/**
 * Replace a stale lock. Returns true only if WE now hold the lock.
 *
 * The guard serialises takeovers, and the stale content is re-read under it, so
 * a process that decided "stale" a moment ago cannot delete the fresh lock the
 * winner just created.
 */
function takeOver(lockPath, staleRaw, payload) {
  const guardPath = `${lockPath}.takeover`;
  if (!claimGuard(guardPath)) return false;
  try {
    let current = null;
    try {
      current = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current !== null && current !== staleRaw) return false; // already replaced by someone else
    if (current !== null) unlinkQuietly(lockPath);
    return tryCreate(lockPath, payload);
  } finally {
    unlinkQuietly(guardPath);
  }
}

function releaseAllHeld() {
  for (const lockPath of [...held]) {
    try {
      release(lockPath);
    } catch {
      // Exit hook: nothing useful left to do with an error.
    }
  }
}

function markHeld(lockPath) {
  held.add(lockPath);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', releaseAllHeld);
  }
}

/**
 * Acquire a lock file.
 * @param {string} lockPath - path to the lock file
 * @param {{ isAlive?: (pid: number) => boolean, maxAgeMs?: number, hostname?: string }} opts
 */
function acquire(lockPath, opts = {}) {
  const host = opts.hostname || os.hostname();
  const ctx = {
    host,
    isAlive: opts.isAlive || isAlive,
    maxAgeMs: resolveMaxAgeMs(opts),
  };
  const payload = buildPayload(host);

  if (held.has(lockPath)) {
    throw lockError({ pid: process.pid, host }, lockPath);
  }

  let last = null;
  // Twice: the second pass runs after losing a takeover race and sees the winner's lock.
  for (let pass = 0; pass < 2; pass++) {
    if (tryCreate(lockPath, payload)) {
      markHeld(lockPath);
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // vanished between EEXIST and read: just create it
      throw err;
    }

    const verdict = assess(raw, lockPath, ctx);
    last = verdict.holder;
    if (!verdict.stale) throw lockError(verdict.holder, lockPath);
    if (takeOver(lockPath, raw, payload)) {
      markHeld(lockPath);
      return;
    }
  }

  throw lockError(last, lockPath);
}

/**
 * Release a lock file only if it is ours (recorded pid AND host match).
 * Ignores ENOENT (already gone) and parse errors (treat as not owned).
 * @param {string} lockPath
 */
function release(lockPath) {
  held.delete(lockPath);

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return; // Already gone - fine.
    return; // Parse error - cannot verify ownership, do not unlink.
  }

  if (Number(existing.pid) !== process.pid) {
    // Not our lock - do not remove it.
    return;
  }
  if (existing.host && existing.host !== os.hostname()) {
    // Same pid, different container: someone else's lock.
    return;
  }

  unlinkQuietly(lockPath);
}

module.exports = { acquire, release, isAlive, DEFAULT_MAX_AGE_MS };
