/**
 * test/lock-failure-message.test.js
 *
 * CLI2-9: acquireRunLock caught EVERY error from lock.acquire and reported it as
 * "Another instance is running, pid=?". A state directory that is read-only (a NAS
 * mount with a uid mismatch, a 0500 directory, a path whose parent is a file) is not
 * another instance: the user went looking for a process that was never there while
 * the real problem was a permission. Only a LockError means a holder exists; anything
 * else names its code and the lock path.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../lib/lock');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-lock-failure-'));
}

test('a lock held by a live process is a LockError carrying the holder\'s pid', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, 'state.json.lock');
    // Our own pid is "stale" by design (a restarted container), so pretend a stranger holds it.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, host: os.hostname(), ts: new Date().toISOString() }));
    let caught;
    try { lock.acquire(lockPath, { isAlive: () => true }); } catch (err) { caught = err; }
    assert.ok(caught instanceof lock.LockError);
    assert.equal(caught.code, 'ELOCKED');
    assert.equal(caught.pid, 4242);
    assert.match(caught.message, /^LockError: held by pid 4242/);
    assert.equal(caught.lockPath, lockPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describeAcquireFailure: a LockError says another instance is running, with its pid', () => {
  const err = new lock.LockError({ pid: 777, host: 'h' }, '/x/state.json.lock');
  const shown = lock.describeAcquireFailure(err, '/x/state.json.lock');
  assert.equal(shown.held, true);
  assert.equal(shown.message, 'Another instance is running, pid=777. Exiting.');
});

test('describeAcquireFailure: a holder with no usable pid still reads as another instance', () => {
  const shown = lock.describeAcquireFailure(new lock.LockError(null, '/x/l'), '/x/l');
  assert.equal(shown.held, true);
  assert.match(shown.message, /pid=\?/);
});

test('describeAcquireFailure: any other error names its code and the lock path, never "another instance"', () => {
  const err = Object.assign(new Error("EACCES: permission denied, open '/mnt/nas/state.json.lock'"), { code: 'EACCES' });
  const shown = lock.describeAcquireFailure(err, '/mnt/nas/state.json.lock');
  assert.equal(shown.held, false);
  assert.doesNotMatch(shown.message, /Another instance/);
  assert.match(shown.message, /EACCES/);
  assert.match(shown.message, /\/mnt\/nas\/state\.json\.lock/);
  assert.match(shown.message, /writable/);
});

test('a LockError is still an Error whose message starts with LockError: (older callers match on it)', () => {
  const err = new lock.LockError({ pid: 5, host: 'a', ts: '2026-10-01T00:00:00.000Z' }, '/l');
  assert.ok(err instanceof Error);
  assert.match(err.message, /^LockError: held by pid 5 on a since 2026-10-01T00:00:00.000Z\. If you are sure no other run is active, delete \/l$/);
});

test('a state location the lock cannot be created in is reported as that, not as another instance', async () => {
  const sandbox = createSandbox({ state: null });
  try {
    // The state path's parent is a regular file: creating the lock beside it fails
    // with ENOTDIR for every user, root included.
    const blocker = path.join(sandbox.dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const state = path.join(blocker, 'state.json');
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], { env: { AIDR_STATE_PATH: state } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /Another instance/);
    assert.match(r.stderr, /Could not take the run lock/);
    assert.match(r.stderr, /ENOTDIR/);
    assert.ok(r.stderr.includes(`${state}.lock`), 'it names the lock path');
    assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'launch'), [], 'nothing ran without the lock');
  } finally {
    sandbox.cleanup();
  }
});
