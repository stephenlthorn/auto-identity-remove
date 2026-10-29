/**
 * test/lock-hardening.test.js
 *
 * CORE-12 / CFG-5: the lock identified its holder by pid alone.
 *   - A leftover lock whose pid equals OUR pid (container restarts reuse low
 *     pids) counted as "another live holder", wedging every future run.
 *   - Stale takeover was a plain overwrite, so two processes that both saw a
 *     dead pid both "won".
 *   - A lock whose pid had been recycled by an unrelated process (reboot) was
 *     held forever: there was no age limit.
 *   - Freeze mode calls process.exit() inside its try, so the finally never
 *     released.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const lock = require('../lib/lock');
const { acquire, release, isAlive } = lock;

const HOUR = 60 * 60 * 1000;
const LOCK_MODULE = path.resolve(__dirname, '..', 'lib', 'lock.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-lock-'));
}

function writeLock(lockPath, fields) {
  fs.writeFileSync(lockPath, JSON.stringify(fields));
}

function readLock(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function ageFile(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

function assertLockError(fn, pattern) {
  assert.throws(fn, err => {
    assert.match(err.message, /^LockError: held by pid /);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

// ─── CORE-12: our own pid is never "another live holder" ─────────────────────

test('a leftover lock carrying our own pid (no host recorded) is acquirable', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: process.pid, ts: new Date().toISOString() });
    assert.doesNotThrow(() => acquire(lockPath));
    assert.equal(readLock(lockPath).pid, process.pid);
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a leftover lock carrying our pid and our host is acquirable (container restart)', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: process.pid, host: os.hostname(), ts: new Date().toISOString() });
    assert.doesNotThrow(() => acquire(lockPath));
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh lock with our pid but ANOTHER host is a different container and stays held', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: process.pid, host: 'some-other-container', ts: new Date().toISOString() });
    assertLockError(() => acquire(lockPath), /some-other-container/);
    assert.equal(readLock(lockPath).host, 'some-other-container', 'the other holder\'s lock must survive');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquiring a lock this process already holds is still refused', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    acquire(lockPath);
    assertLockError(() => acquire(lockPath), new RegExp(String(process.pid)));
    release(lockPath);
    assert.doesNotThrow(() => acquire(lockPath), 'after release it can be taken again');
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── what the lock records ───────────────────────────────────────────────────

test('the lock records pid, hostname and start time', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    const before = Date.now();
    acquire(lockPath);
    const rec = readLock(lockPath);
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.host, os.hostname());
    assert.ok(Date.parse(rec.ts) >= before - 1000, 'ts is when the lock was taken');
    assert.ok(Date.parse(rec.startedAt) <= Date.now(), 'startedAt is when this process started');
    assert.ok(Date.parse(rec.startedAt) < before + 1, 'startedAt precedes the acquire');
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── liveness and age ────────────────────────────────────────────────────────

test('a live holder on this host with a recent lock is respected', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    assertLockError(() => acquire(lockPath, { isAlive: () => true }), /4242/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a dead holder on this host is reclaimed', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    acquire(lockPath, { isAlive: () => false });
    assert.equal(readLock(lockPath).pid, process.pid);
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lock older than the max age is stale even if its pid is alive (pid reused after a reboot)', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(7 * HOUR) });
    acquire(lockPath, { isAlive: () => true });
    assert.equal(readLock(lockPath).pid, process.pid);
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default max age is 6 hours: a 5 hour old live lock is still held', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(5 * HOUR) });
    assertLockError(() => acquire(lockPath, { isAlive: () => true }));
    assert.equal(lock.DEFAULT_MAX_AGE_MS, 6 * HOUR);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the max age is configurable through opts.maxAgeMs', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(2 * HOUR) });
    assertLockError(() => acquire(lockPath, { isAlive: () => true, maxAgeMs: 3 * HOUR }));
    acquire(lockPath, { isAlive: () => true, maxAgeMs: 1 * HOUR });
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the max age is configurable through AIDR_LOCK_MAX_AGE_HOURS', () => {
  const dir = tmpDir();
  const saved = process.env.AIDR_LOCK_MAX_AGE_HOURS;
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(2 * HOUR) });
    process.env.AIDR_LOCK_MAX_AGE_HOURS = '1';
    acquire(lockPath, { isAlive: () => true });
    release(lockPath);
  } finally {
    if (saved === undefined) delete process.env.AIDR_LOCK_MAX_AGE_HOURS;
    else process.env.AIDR_LOCK_MAX_AGE_HOURS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock from another host cannot be judged by pid, only by age', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: 'other-container', ts: isoAgo(HOUR) });
    assertLockError(() => acquire(lockPath, { isAlive: () => false }), /other-container/);

    writeLock(lockPath, { pid: 4242, host: 'other-container', ts: isoAgo(7 * HOUR) });
    acquire(lockPath, { isAlive: () => false });
    assert.equal(readLock(lockPath).host, os.hostname());
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lock with no timestamp is aged by the file modification time', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname() });
    assertLockError(() => acquire(lockPath, { isAlive: () => true }));
    ageFile(lockPath, 7 * HOUR);
    acquire(lockPath, { isAlive: () => true });
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable lock file that was only just written is treated as held (writer mid-write)', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    fs.writeFileSync(lockPath, '');
    assertLockError(() => acquire(lockPath));
    ageFile(lockPath, 10 * 1000);
    acquire(lockPath);
    assert.equal(readLock(lockPath).pid, process.pid, 'an old unreadable lock is just debris');
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the error names the holder and how to clear a lock you know is dead', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    assertLockError(() => acquire(lockPath, { isAlive: () => true }), new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── takeover leaves nothing behind ──────────────────────────────────────────

test('a takeover leaves no guard file behind', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    acquire(lockPath, { isAlive: () => false });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['state.lock']);
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a takeover guard abandoned by a crashed process does not block takeover forever', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    fs.writeFileSync(`${lockPath}.takeover`, '999');
    ageFile(`${lockPath}.takeover`, 5 * 60 * 1000);
    acquire(lockPath, { isAlive: () => false });
    assert.equal(readLock(lockPath).pid, process.pid);
    release(lockPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a takeover must not overwrite a lock another process created after we judged it stale', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 9999999, host: os.hostname(), ts: isoAgo(HOUR) });

    // Deterministic interleaving: while we are deciding the lock is stale (the
    // liveness probe), process B replaces it with its own live lock. A plain
    // overwrite would then clobber B and both would believe they hold it.
    let rivalHasWon = false;
    const isAliveProbe = pid => {
      if (!rivalHasWon) {
        rivalHasWon = true;
        writeLock(lockPath, { pid: 777, host: os.hostname(), ts: new Date().toISOString() });
        return false;
      }
      return pid === 777;
    };

    assertLockError(() => acquire(lockPath, { isAlive: isAliveProbe }), /777/);
    assert.equal(readLock(lockPath).pid, 777, 'the rival\'s lock must be left alone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh takeover guard means another process is mid-takeover: back off, do not steal', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 4242, host: os.hostname(), ts: isoAgo(HOUR) });
    fs.writeFileSync(`${lockPath}.takeover`, '999');
    assertLockError(() => acquire(lockPath, { isAlive: () => false }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── release ownership ───────────────────────────────────────────────────────

test('release does not remove a lock held by another host even when the pid matches ours', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: process.pid, host: 'some-other-container', ts: new Date().toISOString() });
    release(lockPath);
    assert.ok(fs.existsSync(lockPath));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── isAlive ─────────────────────────────────────────────────────────────────

test('isAlive treats a process owned by another user (EPERM) as alive', () => {
  // pid 1 always exists; unprivileged users get EPERM from kill(1, 0).
  assert.equal(isAlive(1), true);
  assert.equal(isAlive(9999999), false);
});

// ─── real processes ──────────────────────────────────────────────────────────

function runChild(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, out, err, child }));
  });
}

test('process.exit() inside a locked section still releases the lock', async () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    const source = `
      const { acquire, release } = require(${JSON.stringify(LOCK_MODULE)});
      const lockPath = process.argv[1];
      acquire(lockPath);
      try { process.exit(1); } finally { release(lockPath); }
    `;
    const r = await runChild(source, [lockPath]);
    assert.equal(r.code, 1, r.err);
    assert.equal(fs.existsSync(lockPath), false, 'the lock must not outlive the process');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exactly one of several processes racing for a stale lock wins', async () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.lock');
    writeLock(lockPath, { pid: 9999999, host: os.hostname(), ts: isoAgo(HOUR) });

    const RACERS = 8;
    const startAt = Date.now() + 1500;
    // Each racer waits for the same instant, then reports WON or LOST and keeps
    // holding until the parent closes its stdin, so no racer can win "after the
    // winner finished" on a slow machine.
    const source = `
      const { acquire, release } = require(${JSON.stringify(LOCK_MODULE)});
      const [lockPath, startAt] = [process.argv[1], Number(process.argv[2])];
      const wait = startAt - Date.now();
      if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      let verdict = 'WON';
      try { acquire(lockPath); } catch (err) { verdict = 'LOST'; }
      process.stdout.write(verdict + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => { try { release(lockPath); } catch (e) {} process.exit(0); });
    `;

    const verdicts = [];
    const children = [];
    const exited = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('racers did not all report: ' + JSON.stringify(verdicts))), 30000);
      for (let i = 0; i < RACERS; i++) {
        const child = spawn(process.execPath, ['-e', source, lockPath, String(startAt)], { stdio: ['pipe', 'pipe', 'inherit'] });
        children.push(child);
        exited.push(new Promise(res => child.on('exit', res)));
        child.stdout.on('data', chunk => {
          verdicts.push(String(chunk).trim());
          if (verdicts.length === RACERS) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
      }
    });
    for (const child of children) child.stdin.end();
    await Promise.all(exited);

    assert.equal(verdicts.filter(v => v === 'WON').length, 1, `verdicts: ${verdicts.join(',')}`);
    assert.equal(verdicts.filter(v => v === 'LOST').length, RACERS - 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
