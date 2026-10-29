'use strict';
/*
 * dashboard/safe-write.js - durable, private writes for the files the dashboard
 * edits (config.json, config.json.enc, state.json, .auth.json) and the backups
 * it keeps of them.
 *
 * Free of express so the top-level test run can cover it.
 */

const fs = require('fs');
const crypto = require('crypto');

const OWNER_ONLY = 0o600;

// rename() onto a Docker single-file bind mount fails with EBUSY, across devices
// with EXDEV, and on some shared filesystems with EPERM. Same set lib/config.js
// falls back on for state.json; anything else (EACCES, ENOSPC...) is a real fault.
const RENAME_FALLBACK_CODES = new Set(['EBUSY', 'EXDEV', 'EPERM']);

function bestEffort(fn) {
  try { fn(); } catch (_) { /* cleanup must never mask the original error */ }
}

/**
 * Write `data` to `file` via a sibling temp file and rename.
 *
 * The temp file holds the full plaintext, so it is created 0600 and removed on
 * EVERY exit path. It used to be stranded next to the config whenever the
 * rename failed, leaving a second copy of the PII on disk.
 *
 * When rename cannot work the target is rewritten in place. That loses
 * atomicity (a kill mid-write can truncate it), but persisting non-atomically
 * beats a 500 on every save for the documented single-file mount.
 *
 * @param {string} file
 * @param {string|Buffer} data
 * @param {number} [mode=0o600]
 */
function writeFileAtomic(file, data, mode = OWNER_ONLY) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', mode);
      fs.writeSync(fd, data);
      bestEffort(() => fs.fsyncSync(fd)); // some filesystems have no fsync
    } finally {
      if (fd !== undefined) bestEffort(() => fs.closeSync(fd));
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      if (!RENAME_FALLBACK_CODES.has(err.code)) throw err;
      fs.writeFileSync(file, data, { mode });
      bestEffort(() => fs.unlinkSync(tmp));
    }
    // mode only applies when a file is created: tighten one that already existed.
    bestEffort(() => fs.chmodSync(file, mode));
  } catch (err) {
    bestEffort(() => fs.unlinkSync(tmp));
    throw err;
  }
}

/**
 * @param {string} file
 * @param {*} obj
 * @param {number} [mode=0o600]
 */
function writeJsonAtomic(file, obj, mode = OWNER_ONLY) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

/**
 * Copy `file` byte-for-byte to `<file><suffix>` (default ".bak") at mode 0600.
 *
 * Called before every replace of the config. Bytes, not parsed JSON: the file
 * most worth keeping is the one the dashboard could not read (wrong passphrase,
 * truncated write), and that must survive exactly as it was.
 *
 * @param {string} file
 * @param {{ suffix?: string }} [opts]
 * @returns {string|null} the backup path, or null when there was nothing to copy
 */
function backupFile(file, opts = {}) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const bak = file + (opts.suffix || '.bak');
  writeFileAtomic(bak, bytes, OWNER_ONLY);
  return bak;
}

module.exports = { writeFileAtomic, writeJsonAtomic, backupFile, OWNER_ONLY };
