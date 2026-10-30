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
 *   opts.refreshMs: how often the holder promises to refresh the lock (recorded in
 *                   it). A lock from ANOTHER host that has been quiet for three of
 *                   these is stale: its pid cannot be checked from here, and a
 *                   killed container's successor has a new hostname, so without
 *                   this the old lock blocked --resume for the whole max age.
 *
 * refresh(lockPath) / startRefresh(lockPath, opts):
 *   - A live run re-stamps the lock's `ts` every few minutes, so the age limit never
 *     hits a run that is still going (a full run can outlast six hours). Only a lock
 *     this process holds is touched, and a lock that was removed is never recreated.
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
// How often a live run re-stamps its lock; the age limit is hours, so a few minutes is plenty.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// A holder on another host that has missed this many refreshes in a row is gone.
const MISSED_REFRESHES = 3;
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

function buildPayload(host, refreshMs) {
  return JSON.stringify({
    pid: process.pid,
    host,
    // When this process started, so a holder can be told apart from a later
    // process that happens to reuse the pid.
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    // When the lock was taken or last refreshed; the age limit counts from here.
    ts: new Date().toISOString(),
    ...(Number.isFinite(refreshMs) && refreshMs > 0 ? { refreshMs } : {}),
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

/**
 * The lock is held by someone else. Carries the holder so a caller can say who,
 * and a code so it can tell this apart from an error that is NOT "another
 * instance": a read-only state directory, a path whose parent is a file, a full
 * disk. The message keeps its historic "LockError: held by pid ..." wording.
 */
class LockError extends Error {
  constructor(holder, lockPath) {
    const pid = holder && Number(holder.pid) > 0 ? Number(holder.pid) : null;
    const where = holder && holder.host ? ` on ${holder.host}` : '';
    const since = holder && holder.ts ? ` since ${holder.ts}` : '';
    super(`LockError: held by pid ${pid === null ? '?' : pid}${where}${since}. If you are sure no other run is active, delete ${lockPath}`);
    this.code = 'ELOCKED';
    this.pid = pid;
    this.holder = holder || null;
    this.lockPath = lockPath;
  }
}

function lockError(holder, lockPath) {
  return new LockError(holder, lockPath);
}

/**
 * What to tell the user when acquire() threw. Only a LockError means another run
 * holds the lock; anything else (EACCES, ENOTDIR, ENOSPC, EROFS ...) is reported
 * with its code and the lock path, because "Another instance is running, pid=?"
 * sends the user looking for a process that is not there (CLI2-9).
 *
 * @param {unknown} err
 * @param {string} lockPath
 * @returns {{ held: boolean, message: string }}
 */
function describeAcquireFailure(err, lockPath) {
  if (err instanceof LockError) {
    return { held: true, message: `Another instance is running, pid=${err.pid === null ? '?' : err.pid}. Exiting.` };
  }
  const code = err && err.code ? ` (${err.code})` : '';
  const why = err && err.message ? err.message : String(err);
  return {
    held: false,
    message: `Could not take the run lock ${lockPath}${code}: ${why}. Nothing was run. Check that its directory exists and is writable by this user.`,
  };
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
  if (!sameHost) {
    // The pid means nothing here, but a holder that promised to refresh and has
    // missed several refreshes is not running (a container killed with SIGKILL).
    const promised = Number(holder.refreshMs);
    const quiet = promised > 0 && age !== null && age > MISSED_REFRESHES * promised;
    return { stale: quiet, holder };
  }

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
  const payload = buildPayload(host, opts.refreshMs);

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

/** How often the watcher refreshes its lock: AIDR_LOCK_REFRESH_MS (a test knob), else REFRESH_INTERVAL_MS. */
function refreshIntervalMs(env = process.env) {
  const ms = Number(env && env.AIDR_LOCK_REFRESH_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : REFRESH_INTERVAL_MS;
}

/**
 * Re-stamp the lock's `ts` so a run that is still alive is never older than the max
 * age. Only a lock this process holds is touched (recorded pid AND host match), and
 * one that is gone or was taken over is left as it is: refreshing must never
 * resurrect a lock or overwrite another run's. The rewrite is a rename, so a reader
 * never sees a half-written file.
 *
 * @param {string} lockPath
 * @returns {boolean} true when the lock was refreshed
 */
function refresh(lockPath) {
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    return false;
  }
  if (!existing || typeof existing !== 'object' || Number(existing.pid) !== process.pid) return false;
  if (existing.host && existing.host !== os.hostname()) return false;

  const tmp = `${lockPath}.refresh-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...existing, ts: new Date().toISOString() }));
    fs.renameSync(tmp, lockPath);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* nothing to clean */ }
    return false;
  }
}

/**
 * Refresh the lock on an interval until the returned function is called. The timer
 * is unref'd: it must never be the reason a finished process stays alive.
 *
 * @param {string} lockPath
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void} stop
 */
function startRefresh(lockPath, opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : refreshIntervalMs();
  const timer = setInterval(() => { refresh(lockPath); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
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

module.exports = {
  acquire, release, refresh, startRefresh, refreshIntervalMs, isAlive,
  LockError, describeAcquireFailure, DEFAULT_MAX_AGE_MS, REFRESH_INTERVAL_MS,
};
