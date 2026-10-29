/**
 * lib/snapshot.js
 *
 * Pre-submit form screenshot capture for audit trail (audit §2.1).
 *
 * WARNING: snapshots contain PII. The logs/snapshots/ directory is listed in
 * .gitignore and must never be committed.
 */

const path = require('path');
const fs = require('fs');
const { mkdirPrivate, chmodPrivate } = require('./private-fs');
const { resolvePaths } = require('./paths');

const SNAPSHOT_DIR = resolvePaths().snapshots;

/**
 * Return the full path where a snapshot for `brokerName` at `timestamp` will
 * be written. The broker name is sanitised so it is safe to use as part of a
 * filename.
 *
 * @param {string} brokerName
 * @param {Date}   [timestamp=new Date()]
 * @returns {string}
 */
function snapshotPath(brokerName, timestamp = new Date()) {
  const safeName = brokerName.replace(/[^a-z0-9_-]/gi, '_');
  const iso = timestamp.toISOString().replace(/[:.]/g, '-');
  return path.join(SNAPSHOT_DIR, `${safeName}-${iso}.png`);
}

/**
 * Capture a full-page screenshot of `page` and write it to
 * `<dir>/<brokerName>-<ISO>.png`.
 *
 * Returns the absolute path of the written file, or `null` if the screenshot
 * fails (e.g. page is already closing). Never throws.
 *
 * @param {import('playwright').Page} page
 * @param {string} brokerName
 * @param {object} [opts]
 * @param {string} [opts.dir]        - Override output directory (default: SNAPSHOT_DIR)
 * @param {Date}   [opts.timestamp]  - Override timestamp (default: new Date())
 * @param {object} [opts._fs]        - Override fs module (for testing)
 * @returns {Promise<string|null>}
 */
async function captureSubmitSnapshot(page, brokerName, opts = {}) {
  const { dir = SNAPSHOT_DIR, timestamp = new Date(), _fs = fs } = opts;
  const safeName = brokerName.replace(/[^a-z0-9_-]/gi, '_');
  const iso = timestamp.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${safeName}-${iso}.png`);
  try {
    // The screenshot is the filled form, PII included. Playwright writes the
    // file itself with the process umask (0644), so the directory is made
    // owner-only first and the file is tightened after (CFG-10).
    mkdirPrivate(dir, { fs: _fs });
    await page.screenshot({ path: file, fullPage: true });
    chmodPrivate(file, { fs: _fs });
    return file;
  } catch (_err) {
    return null;
  }
}

module.exports = { captureSubmitSnapshot, snapshotPath, SNAPSHOT_DIR };
