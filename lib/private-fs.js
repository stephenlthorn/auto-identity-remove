/**
 * lib/private-fs.js
 *
 * Writers for files that hold PII: audit reports, run logs, form snapshots and
 * screenshots, complaints. config.js already writes config/state 0600; these
 * helpers give every other PII file the same treatment.
 *
 * Left to the process umask these were 0644, readable by every local account -
 * a real exposure on a NAS with family logins or a shared VPS (CFG-10 /
 * CORE-9 / codex #1).
 *
 * `mode` on open/mkdir only applies when the path is CREATED. A log written
 * 0644 by an older version keeps that mode through an overwrite, so both
 * helpers also chmod explicitly.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_MODE = 0o600;
const DIR_MODE  = 0o700;

// rename() onto a Docker single-file bind mount fails with EBUSY, across
// devices with EXDEV; same fallback set as lib/config.js.
const REWRITE_CODES = new Set(['EBUSY', 'EXDEV', 'EPERM']);

// Best-effort: some filesystems (exFAT, a Windows share, a bind mount) reject
// chmod entirely, and an injected fs may not implement it.
function chmodBestEffort(impl, target, mode) {
  try { impl.chmodSync(target, mode); } catch (_) { /* nothing more we can do */ }
}

function unlinkQuietly(impl, target) {
  try { impl.unlinkSync(target); } catch (_) { /* already gone */ }
}

/**
 * Atomically write `data` to `target` as an owner-only (0600) file.
 *
 * Writes a temp file created 0600, fsyncs it, then renames it over the target
 * so a kill mid-write never leaves a truncated file. When rename is refused
 * (single-file bind mount, cross-device) it rewrites in place instead -
 * persisting non-atomically beats not persisting. The parent directory must
 * already exist: use mkdirPrivate first.
 *
 * @param {string} target
 * @param {string|Buffer} data
 * @param {{ fs?: object }} [opts] fs override for tests
 * @returns {string} target
 */
function writePrivateFile(target, data, opts = {}) {
  const impl = opts.fs || fs;
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = impl.openSync(tmp, 'wx', FILE_MODE);
    impl.writeFileSync(fd, data);
    try { impl.fsyncSync(fd); } catch (_) { /* best-effort: not every FS has fsync */ }
    impl.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) { try { impl.closeSync(fd); } catch (_) { /* already closed */ } }
    unlinkQuietly(impl, tmp);
    throw err;
  }

  try {
    impl.renameSync(tmp, target);
  } catch (err) {
    if (!REWRITE_CODES.has(err.code)) {
      unlinkQuietly(impl, tmp);
      throw err;
    }
    impl.writeFileSync(target, data, { mode: FILE_MODE });
    unlinkQuietly(impl, tmp);
  }

  chmodBestEffort(impl, target, FILE_MODE);
  return target;
}

// Whether `p` exists. Treats an fs that cannot answer as "exists", so the
// caller never chmods an ancestor it cannot prove it created.
function existsOrUnknown(impl, p) {
  try { return impl.existsSync(p); } catch (_) { return true; }
}

/**
 * Create `dir` (and any missing parents) owner-only (0700), and tighten `dir`
 * itself if it already existed with a looser mode.
 *
 * Only directories this call created, plus `dir`, are chmod'd: a caller may
 * pass a path under a shared directory (for example a mounted /home/aidr) and
 * that ancestor is not ours to change.
 *
 * @param {string} dir
 * @param {{ fs?: object }} [opts] fs override for tests
 * @returns {string} dir
 */
function mkdirPrivate(dir, opts = {}) {
  const impl = opts.fs || fs;

  const created = [];
  for (let cur = path.resolve(dir); !existsOrUnknown(impl, cur); cur = path.dirname(cur)) {
    created.push(cur);
    if (path.dirname(cur) === cur) break;
  }

  impl.mkdirSync(dir, { recursive: true });

  for (const made of created) chmodBestEffort(impl, made, DIR_MODE);
  chmodBestEffort(impl, dir, DIR_MODE);
  return dir;
}

/**
 * chmod an existing file to 0600. For files another library writes itself
 * (Playwright screenshots), where the write cannot go through writePrivateFile.
 *
 * @param {string} target
 * @param {{ fs?: object }} [opts]
 */
function chmodPrivate(target, opts = {}) {
  chmodBestEffort(opts.fs || fs, target, FILE_MODE);
}

module.exports = { writePrivateFile, mkdirPrivate, chmodPrivate, FILE_MODE, DIR_MODE };
