/**
 * lib/lock.js
 *
 * Process-level lock file for watcher.js. Prevents two instances from racing
 * on state.json.
 *
 * acquire(lockPath, opts):
 *   - Writes {pid, ts} JSON to lockPath.
 *   - If lockPath already exists and the recorded pid is still alive, throws
 *     new Error('LockError: held by pid N').
 *   - If the recorded pid is dead (stale lock), overwrites with our pid.
 *   opts.isAlive: optional override fn(pid) => bool, for testability.
 *
 * release(lockPath):
 *   - Removes lockPath. Ignores ENOENT.
 *
 * isAlive(pid):
 *   - Returns true if the process is alive (process.kill(pid, 0) succeeds).
 */

const fs = require('fs');

/**
 * Check if a process is alive using signal 0 (no-op probe).
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock file.
 * @param {string} lockPath - path to the lock file
 * @param {{ isAlive?: (pid: number) => boolean }} opts
 */
function acquire(lockPath, opts = {}) {
  const checkAlive = opts.isAlive || isAlive;

  if (fs.existsSync(lockPath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      // Corrupt lock file - treat as stale
      existing = { pid: 0 };
    }
    const pid = Number(existing.pid);
    if (pid && checkAlive(pid)) {
      throw new Error(`LockError: held by pid ${pid}`);
    }
    // Stale lock - fall through to overwrite
  }

  const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
  fs.writeFileSync(lockPath, payload, { flag: 'w' });
}

/**
 * Release a lock file, ignoring ENOENT.
 * @param {string} lockPath
 */
function release(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { acquire, release, isAlive };
