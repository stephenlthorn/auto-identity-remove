/**
 * test/private-fs-modes.test.js
 *
 * Audit files, snapshots, screenshots, complaints and run logs hold a legal
 * name, an address and the URLs of every broker that has them. They were
 * written with the process umask (0644 on a default Linux or macOS box), so on
 * a NAS with family accounts or a shared VPS every local user could read them
 * (CFG-10 / CORE-9 / codex #1).
 *
 * `mode` only applies when a file is CREATED, so a log left 0644 by an older
 * version stays 0644 forever unless the writer chmods it too.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKIP_ON_WINDOWS = process.platform === 'win32';

const { writePrivateFile, mkdirPrivate } = require('../lib/private-fs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-privfs-'));
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

/** Run `fn` under a wide-open umask so a mode left to the default would show as 0666/0777. */
function withOpenUmask(fn) {
  const prev = process.umask(0);
  try {
    return fn();
  } finally {
    process.umask(prev);
  }
}

test('writePrivateFile creates a new file owner-only even under umask 0', { skip: SKIP_ON_WINDOWS }, () => {
  const dir = tmpdir();
  const target = path.join(dir, 'audit.md');
  withOpenUmask(() => writePrivateFile(target, '# audit\n'));
  assert.equal(fs.readFileSync(target, 'utf8'), '# audit\n');
  assert.equal(modeOf(target), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePrivateFile tightens a file that already exists at 0644', { skip: SKIP_ON_WINDOWS }, () => {
  // A run log written by a version that used the umask must not stay readable.
  const dir = tmpdir();
  const target = path.join(dir, 'run.json');
  fs.writeFileSync(target, 'old', { mode: 0o644 });
  fs.chmodSync(target, 0o644);

  writePrivateFile(target, 'new');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(modeOf(target), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePrivateFile accepts a Buffer and leaves no temp file behind', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'shot.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  writePrivateFile(target, bytes);

  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['shot.png']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed write leaves the previous content intact and no temp file', () => {
  // Atomic: the target is replaced by rename, never truncated in place.
  const dir = tmpdir();
  const target = path.join(dir, 'state-like.json');
  fs.writeFileSync(target, 'precious');

  assert.throws(() => writePrivateFile(target, { not: 'a string or buffer' }));

  assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
  assert.deepEqual(fs.readdirSync(dir), ['state-like.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePrivateFile falls back to an in-place write when rename hits EBUSY (Docker single-file mount)', { skip: SKIP_ON_WINDOWS }, () => {
  const dir = tmpdir();
  const target = path.join(dir, 'mounted.json');
  fs.writeFileSync(target, 'old', { mode: 0o644 });
  const busyFs = {
    ...fs,
    renameSync() {
      const e = new Error('rename: device or resource busy');
      e.code = 'EBUSY';
      throw e;
    },
  };

  writePrivateFile(target, 'new', { fs: busyFs });

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(modeOf(target), 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['mounted.json'], 'the temp file must be cleaned up');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePrivateFile does not swallow errors other than EBUSY/EXDEV/EPERM on rename', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'x.json');
  const brokenFs = {
    ...fs,
    renameSync() {
      const e = new Error('no space');
      e.code = 'ENOSPC';
      throw e;
    },
  };
  assert.throws(() => writePrivateFile(target, 'data', { fs: brokenFs }), /no space/);
  assert.deepEqual(fs.readdirSync(dir), [], 'the temp file must be cleaned up');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mkdirPrivate creates every missing directory owner-only even under umask 0', { skip: SKIP_ON_WINDOWS }, () => {
  const root = tmpdir();
  const leaf = path.join(root, 'logs', 'snapshots');

  withOpenUmask(() => mkdirPrivate(leaf));

  assert.equal(modeOf(path.join(root, 'logs')), 0o700);
  assert.equal(modeOf(leaf), 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mkdirPrivate tightens a directory that already exists at 0755', { skip: SKIP_ON_WINDOWS }, () => {
  const root = tmpdir();
  const dir = path.join(root, 'logs');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);

  mkdirPrivate(dir);

  assert.equal(modeOf(dir), 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mkdirPrivate never loosens or tightens an ancestor it did not create', { skip: SKIP_ON_WINDOWS }, () => {
  // The caller may pass a path under a shared directory such as /home/aidr;
  // only the directories this call created are ours to chmod.
  const root = tmpdir();
  fs.chmodSync(root, 0o755);

  mkdirPrivate(path.join(root, 'logs'));

  assert.equal(modeOf(root), 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mkdirPrivate is idempotent', () => {
  const root = tmpdir();
  const dir = path.join(root, 'a', 'b');
  mkdirPrivate(dir);
  mkdirPrivate(dir);
  assert.ok(fs.statSync(dir).isDirectory());
  fs.rmSync(root, { recursive: true, force: true });
});
