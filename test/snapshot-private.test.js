/**
 * test/snapshot-private.test.js
 *
 * logs/snapshots/*.png are full-page screenshots of the opt-out form after it
 * was filled: legal name, address, phone, email, rendered. Playwright writes
 * the file itself with the process umask (0644), into a directory created the
 * same way (CFG-10 / codex #1). The capture must lock both down.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { captureSubmitSnapshot } = require('../lib/snapshot');

const SKIP_ON_WINDOWS = process.platform === 'win32';

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

/** A page whose screenshot() writes the file the way Playwright does: default mode, caller's umask. */
function playwrightLikePage() {
  return {
    screenshot: async ({ path: p }) => {
      fs.writeFileSync(p, Buffer.from('png-bytes'));
      fs.chmodSync(p, 0o644);
    },
  };
}

test('a captured snapshot is owner-only even though Playwright wrote it 0644', { skip: SKIP_ON_WINDOWS }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-snap-'));
  const dir = path.join(root, 'logs', 'snapshots');

  const file = await captureSubmitSnapshot(playwrightLikePage(), 'Spokeo', { dir });

  assert.ok(file && fs.existsSync(file), 'the snapshot should have been written');
  assert.equal(modeOf(file) & 0o077, 0, `snapshot is ${modeOf(file).toString(8)}; group/other must have no access`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the snapshot directory is created owner-only', { skip: SKIP_ON_WINDOWS }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-snap-'));
  const dir = path.join(root, 'logs', 'snapshots');
  const prev = process.umask(0);
  try {
    await captureSubmitSnapshot(playwrightLikePage(), 'Spokeo', { dir });
  } finally {
    process.umask(prev);
  }
  assert.equal(modeOf(dir) & 0o077, 0, `snapshots dir is ${modeOf(dir).toString(8)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an existing snapshot directory left 0755 by an older version is tightened', { skip: SKIP_ON_WINDOWS }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-snap-'));
  const dir = path.join(root, 'snapshots');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);

  await captureSubmitSnapshot(playwrightLikePage(), 'Spokeo', { dir });

  assert.equal(modeOf(dir) & 0o077, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a failed screenshot still returns null and leaves nothing world-readable behind', { skip: SKIP_ON_WINDOWS }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-snap-'));
  const dir = path.join(root, 'snapshots');
  const page = { screenshot: async () => { throw new Error('page closed'); } };

  const result = await captureSubmitSnapshot(page, 'Spokeo', { dir });

  assert.equal(result, null);
  assert.equal(modeOf(dir) & 0o077, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
