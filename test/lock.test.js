/**
 * test/lock.test.js
 *
 * Tests for lib/lock.js:
 *   - acquire on fresh path creates lock file with pid + ts
 *   - second acquire on live pid throws LockError
 *   - acquire with dead pid reclaims (via isAliveOverride)
 *   - release removes file
 *   - release on missing file does not throw
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquire, release, isAlive } = require('../lib/lock');

function tmpLock() {
  return path.join(os.tmpdir(), `test-lock-${process.pid}-${Math.random().toString(36).slice(2)}.lock`);
}

test('isAlive: current process is alive', () => {
  assert.equal(isAlive(process.pid), true);
});

test('isAlive: dead pid returns false', () => {
  // pid 1 is almost always alive (init), but a very large pid is almost certainly dead
  // Use a pid that won't exist
  assert.equal(isAlive(9999999), false);
});

test('acquire: creates lock file on fresh path', () => {
  const lockPath = tmpLock();
  try {
    acquire(lockPath);
    assert.ok(fs.existsSync(lockPath), 'lock file should exist after acquire');
    const contents = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(contents.pid, process.pid);
    assert.ok(typeof contents.ts === 'string', 'ts should be a string');
    assert.ok(!isNaN(Date.parse(contents.ts)), 'ts should be a valid ISO date');
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test('acquire: second acquire with live pid throws LockError', () => {
  const lockPath = tmpLock();
  try {
    acquire(lockPath);
    assert.throws(
      () => acquire(lockPath),
      (err) => {
        assert.ok(err.message.startsWith('LockError:'), `expected LockError, got: ${err.message}`);
        assert.ok(err.message.includes(String(process.pid)), 'error should mention the pid');
        return true;
      }
    );
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test('acquire: stale lock (dead pid) is reclaimed via isAliveOverride', () => {
  const lockPath = tmpLock();
  try {
    // Write a lock file manually with a fake pid
    const stalePid = 9999999;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: stalePid, ts: new Date().toISOString() }));

    // acquire with override that says the pid is dead
    acquire(lockPath, { isAlive: () => false });

    // Should now hold the lock with our pid
    const contents = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(contents.pid, process.pid, 'lock should now have our pid');
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test('acquire: stale lock without override uses real isAlive (dead pid → reclaim)', () => {
  const lockPath = tmpLock();
  try {
    // Write a lock with a definitely-dead pid
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 9999999, ts: new Date().toISOString() }));

    // Should reclaim because pid 9999999 is (almost certainly) not alive
    acquire(lockPath);
    const contents = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(contents.pid, process.pid);
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test('release: removes the lock file', () => {
  const lockPath = tmpLock();
  acquire(lockPath);
  assert.ok(fs.existsSync(lockPath), 'lock should exist before release');
  release(lockPath);
  assert.ok(!fs.existsSync(lockPath), 'lock should be gone after release');
});

test('release: does not throw when file is missing', () => {
  const lockPath = tmpLock();
  assert.doesNotThrow(() => release(lockPath));
});
