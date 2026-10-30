/**
 * test/config-parent-dir.test.js
 *
 * With AIDR_HOME pointing at a directory that does not exist yet (a fresh Docker
 * volume path, a new NAS share), `aidr setup` died with ENOENT on its first write
 * because the atomic writer opened <target>.tmp in a directory nobody had made.
 * The writer now creates the missing parent owner-only (0700), the directory
 * holding config and state being as private as the files in it, and leaves a
 * directory that already exists alone: it may belong to someone else's mount.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../lib/config');

const mode = (p) => fs.statSync(p).mode & 0o777;

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-parent-')));
}

test('writeJsonAtomic creates a missing parent directory 0700 and the file 0600', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  try {
    const target = path.join(root, 'aidr-home', 'config.json');
    config.writeJsonAtomic(target, { persons: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { persons: [] });
    assert.equal(mode(path.dirname(target)), 0o700);
    assert.equal(mode(target), 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic creates several missing levels', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  try {
    const target = path.join(root, 'a', 'b', 'state.json');
    config.writeJsonAtomic(target, { optOuts: {} });
    assert.equal(mode(path.join(root, 'a')), 0o700);
    assert.equal(mode(path.join(root, 'a', 'b')), 0o700);
    assert.ok(fs.existsSync(target));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic leaves the mode of a directory that already exists alone', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  try {
    const dir = path.join(root, 'shared');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    config.writeJsonAtomic(path.join(dir, 'config.json'), {});
    assert.equal(mode(dir), 0o755, 'not our directory to tighten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no temp file is left behind in the new directory', () => {
  const root = tmp();
  try {
    config.writeJsonAtomic(path.join(root, 'home', 'config.json'), {});
    assert.deepEqual(fs.readdirSync(path.join(root, 'home')), ['config.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
