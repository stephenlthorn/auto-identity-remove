/**
 * test/lock-refresh.test.js
 *
 * A lock older than AIDR_LOCK_MAX_AGE_HOURS (default 6) is treated as stale WHOEVER
 * holds it, and nothing refreshed the timestamp while a run was alive: a full run
 * that takes longer than that (many persons x ~490 generic brokers, slow sites, a
 * person at a CAPTCHA) had its lock taken over by the next scheduled or manual run,
 * and two runs then wrote state.json and submitted forms at once.
 *
 * Now a live run refreshes its own lock every few minutes, and a lock written by
 * ANOTHER host (a container that was killed; its successor has a new hostname) is
 * judged stale as soon as a holder that promised to refresh has gone quiet for three
 * intervals, instead of blocking --resume for the full six hours.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lock = require('../lib/lock');

const HOUR = 60 * 60 * 1000;
const dirs = [];
function lockFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-lock-refresh-'));
  dirs.push(dir);
  return path.join(dir, 'state.json.lock');
}
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function backdate(file, ms) {
  const held = read(file);
  fs.writeFileSync(file, JSON.stringify({ ...held, ts: new Date(Date.now() - ms).toISOString() }));
}

// A second process, as the next scheduled run would be.
function tryAcquireElsewhere(file, extraEnv = {}) {
  const script = `
    const lock = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'lock'))});
    try { lock.acquire(${JSON.stringify(file)}); process.stdout.write('taken'); lock.release(${JSON.stringify(file)}); }
    catch (err) { process.stdout.write(err.code === 'ELOCKED' ? 'held' : 'error:' + err.message); }
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, ...extraEnv } }).stdout;
}

// ── refresh ──────────────────────────────────────────────────────────────────

test('refresh() stamps a new time on a lock this process holds and keeps who holds it', () => {
  const file = lockFile();
  lock.acquire(file, { refreshMs: 1000 });
  try {
    backdate(file, 7 * HOUR);
    const before = read(file);
    assert.equal(lock.refresh(file), true);
    const after = read(file);
    assert.ok(Date.now() - Date.parse(after.ts) < 5000, 'the timestamp is now');
    assert.equal(after.pid, before.pid);
    assert.equal(after.host, before.host);
    assert.equal(after.startedAt, before.startedAt);
    assert.equal(after.refreshMs, 1000);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f !== path.basename(file)), [], 'no temp file left behind');
  } finally {
    lock.release(file);
  }
});

test('a run that is alive past the max age keeps its lock: the next run is refused, not let in', () => {
  const file = lockFile();
  lock.acquire(file);
  try {
    backdate(file, 7 * HOUR); // a 7 hour run that never refreshed
    assert.equal(tryAcquireElsewhere(file), 'taken', 'without a refresh the lock is stale (the bug)');
  } finally {
    lock.release(file);
  }

  const second = lockFile();
  lock.acquire(second);
  try {
    backdate(second, 7 * HOUR);
    lock.refresh(second); // what the timer does every few minutes
    assert.equal(tryAcquireElsewhere(second), 'held', 'refreshed: a live run is never taken over');
  } finally {
    lock.release(second);
  }
});

test('refresh() never touches a lock another process holds, and never recreates a missing one', () => {
  const file = lockFile();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1, host: os.hostname(), ts: '2026-01-01T00:00:00.000Z' }));
  const stranger = fs.readFileSync(file, 'utf8');
  assert.equal(lock.refresh(file), false);
  assert.equal(fs.readFileSync(file, 'utf8'), stranger, "someone else's lock is left exactly as it was");

  fs.rmSync(file);
  assert.equal(lock.refresh(file), false);
  assert.equal(fs.existsSync(file), false, 'a lock that was taken away is not resurrected');

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'some-other-container', ts: '2026-01-01T00:00:00.000Z' }));
  assert.equal(lock.refresh(file), false, 'same pid on another host is another process');
});

test('refresh() is quiet about a lock it cannot read', () => {
  const file = lockFile();
  fs.writeFileSync(file, '{not json');
  assert.equal(lock.refresh(file), false);
  assert.equal(lock.refresh(path.join(path.dirname(file), 'no', 'such', 'dir.lock')), false);
});

// ── the timer ────────────────────────────────────────────────────────────────

test('startRefresh() refreshes on its interval until stopped, and never keeps the process alive', async () => {
  const file = lockFile();
  lock.acquire(file);
  const stop = lock.startRefresh(file, { intervalMs: 20 });
  try {
    backdate(file, 7 * HOUR);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(Date.now() - Date.parse(read(file).ts) < 2000, 'the timer refreshed it');

    stop();
    backdate(file, 7 * HOUR);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(Date.now() - Date.parse(read(file).ts) > 6 * HOUR, 'a stopped timer leaves it alone');
  } finally {
    stop();
    lock.release(file);
  }

  const child = spawnSync(process.execPath, ['-e', `
    const lock = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'lock'))});
    const file = ${JSON.stringify(lockFile())};
    lock.acquire(file);
    lock.startRefresh(file, { intervalMs: 1000 });
    lock.release(file);
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, 'the process exited on its own: the timer is unref\'d');
  assert.equal(child.signal, null);
});

test('refreshIntervalMs reads AIDR_LOCK_REFRESH_MS, else a few minutes, well inside the max age', () => {
  assert.equal(lock.refreshIntervalMs({ AIDR_LOCK_REFRESH_MS: '250' }), 250);
  assert.equal(lock.refreshIntervalMs({ AIDR_LOCK_REFRESH_MS: 'nonsense' }), lock.REFRESH_INTERVAL_MS);
  assert.equal(lock.refreshIntervalMs({}), lock.REFRESH_INTERVAL_MS);
  assert.ok(lock.REFRESH_INTERVAL_MS <= 10 * 60 * 1000 && lock.REFRESH_INTERVAL_MS >= 60 * 1000);
});

// ── a killed container's lock (another host) ─────────────────────────────────

function foreignLock(file, { refreshMs, ageMs, host = 'old-container-7f3a' }) {
  const body = { pid: 1, host, startedAt: new Date(Date.now() - ageMs - 1000).toISOString(), ts: new Date(Date.now() - ageMs).toISOString() };
  if (refreshMs) body.refreshMs = refreshMs;
  fs.writeFileSync(file, JSON.stringify(body));
}

test('a lock from another host that stopped refreshing is stale after three intervals, not six hours', () => {
  const file = lockFile();
  foreignLock(file, { refreshMs: 1000, ageMs: 10 * 1000 });
  lock.acquire(file); // would throw if it were judged held
  assert.equal(read(file).pid, process.pid);
  lock.release(file);
});

test('a lock from another host that is still refreshing is held', () => {
  const file = lockFile();
  foreignLock(file, { refreshMs: 60000, ageMs: 30 * 1000 });
  assert.throws(() => lock.acquire(file), (err) => err instanceof lock.LockError && /old-container-7f3a/.test(err.message));
});

test('a lock from another host that never promised to refresh keeps the old six hour rule', () => {
  const file = lockFile();
  foreignLock(file, { ageMs: 2 * HOUR });
  assert.throws(() => lock.acquire(file), lock.LockError);
});

test('on the same host the pid decides, refresh or not: a live holder is never judged quiet', () => {
  const file = lockFile();
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, host: os.hostname(), ts: new Date(Date.now() - HOUR).toISOString(), refreshMs: 1000 }));
  assert.throws(() => lock.acquire(file, { isAlive: () => true }), lock.LockError, 'a laptop that slept is still the holder');
});

test('acquire() records refreshMs only when asked to', () => {
  const file = lockFile();
  lock.acquire(file);
  assert.equal('refreshMs' in read(file), false);
  lock.release(file);
  lock.acquire(file, { refreshMs: 300000 });
  assert.equal(read(file).refreshMs, 300000);
  lock.release(file);
});
