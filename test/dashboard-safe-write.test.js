/**
 * test/dashboard-safe-write.test.js
 *
 * DASH-14 (rename fallback + no plaintext temp files left behind) and the
 * backup half of DASH-1 (a .bak copy, mode 0600, before every replace).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, backupFile } = require('../dashboard/safe-write');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-safe-write-'));
}

/** Run fn with fs[method] replaced; always restores. */
function withPatched(method, impl, fn) {
  const original = fs[method];
  fs[method] = impl;
  try { return fn(); } finally { fs[method] = original; }
}

const leftovers = dir => fs.readdirSync(dir).filter(n => /\.tmp-/.test(n));
const modeOf = file => fs.statSync(file).mode & 0o777;

test('writeJsonAtomic writes pretty JSON with a trailing newline at mode 0600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  writeJsonAtomic(file, { a: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
  assert.equal(modeOf(file), 0o600);
  assert.deepEqual(leftovers(dir), []);
});

test('writeJsonAtomic tightens an existing world-readable target to 0600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writeJsonAtomic(file, { a: 1 });
  assert.equal(modeOf(file), 0o600);
});

for (const code of ['EBUSY', 'EXDEV', 'EPERM']) {
  test(`DASH-14: ${code} on rename falls back to an in-place write and leaves no temp file`, () => {
    // A Docker single-file bind mount makes rename() onto the target fail with EBUSY.
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"old":true}');
    withPatched('renameSync', () => { throw Object.assign(new Error(code), { code }); }, () => {
      writeJsonAtomic(file, { fresh: 1 });
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { fresh: 1 });
    assert.deepEqual(leftovers(dir), [], 'the plaintext temp copy must be removed');
    assert.equal(modeOf(file), 0o600);
  });
}

test('DASH-14: any other rename error is rethrown and the temp file is removed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"old":true}');
  assert.throws(() => {
    withPatched('renameSync', () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); }, () => {
      writeJsonAtomic(file, { fresh: 1 });
    });
  }, /nope/);
  assert.deepEqual(leftovers(dir), [], 'a failed write must not strand the config in a temp file');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true }, 'the target is untouched');
});

test('DASH-14: a write that fails midway (disk full) removes the temp file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  assert.throws(() => {
    withPatched('writeSync', () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }, () => {
      writeJsonAtomic(file, { fresh: 1 });
    });
  }, /ENOSPC/);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(fs.existsSync(file), false);
});

test('DASH-14: when the in-place fallback write also fails the temp file is still removed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  const realWrite = fs.writeFileSync;
  assert.throws(() => {
    withPatched('renameSync', () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, () => {
      withPatched('writeFileSync', (...a) => {
        if (a[0] === file) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
        return realWrite(...a);
      }, () => writeJsonAtomic(file, { fresh: 1 }));
    });
  }, /EROFS/);
  assert.deepEqual(leftovers(dir), []);
});

// ---- backups ---------------------------------------------------------------

test('backupFile copies the exact bytes to <file>.bak at mode 0600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  // Not valid UTF-8 and not valid JSON: the unreadable file DASH-1 must not destroy.
  const garbled = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x00, 0x80]);
  fs.writeFileSync(file, garbled, { mode: 0o644 });
  const bak = backupFile(file);
  assert.equal(bak, file + '.bak');
  assert.ok(fs.readFileSync(bak).equals(garbled), 'bytes must be identical');
  assert.equal(modeOf(bak), 0o600);
});

test('backupFile returns null and creates nothing when there is no file to back up', () => {
  const dir = tmpDir();
  assert.equal(backupFile(path.join(dir, 'config.json')), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('backupFile replaces an older .bak with the latest copy', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, 'one');
  backupFile(file);
  fs.writeFileSync(file, 'two');
  backupFile(file);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), 'two');
});

test('backupFile with a suffix keeps a separate copy that later backups do not clobber', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json.enc');
  fs.writeFileSync(file, 'precious');
  const keep = backupFile(file, { suffix: '.unreadable-1.bak' });
  fs.writeFileSync(file, 'later');
  backupFile(file);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'precious');
  assert.equal(modeOf(keep), 0o600);
});
