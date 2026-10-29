/**
 * test/audit-private-write.test.js
 *
 * logs/audit-*.md names the user, their email and every broker that holds their
 * data. It was written with the process umask (0644) into a directory created
 * the same way (CORE-9 / CFG-10 / codex #1).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditFile } = require('../lib/audit');

const SKIP_ON_WINDOWS = process.platform === 'win32';

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

test('writeAuditFile writes the report owner-only', { skip: SKIP_ON_WINDOWS }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-audit-'));
  const logsDir = path.join(root, 'logs');
  const prev = process.umask(0);
  let file;
  try {
    file = writeAuditFile(logsDir, '# audit\n', '2026-05-19T10:00:00.000Z');
  } finally {
    process.umask(prev);
  }
  assert.equal(modeOf(file) & 0o077, 0, `audit file is ${modeOf(file).toString(8)}; group/other must have no access`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeAuditFile creates the logs directory owner-only', { skip: SKIP_ON_WINDOWS }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-audit-'));
  const logsDir = path.join(root, 'logs');
  const prev = process.umask(0);
  try {
    writeAuditFile(logsDir, '# audit\n', '2026-05-19T10:00:00.000Z');
  } finally {
    process.umask(prev);
  }
  assert.equal(modeOf(logsDir) & 0o077, 0, `logs dir is ${modeOf(logsDir).toString(8)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rewriting an audit left 0644 by an older version tightens it', { skip: SKIP_ON_WINDOWS }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-audit-'));
  const stamp = '2026-05-19T10:00:00.000Z';
  const old = path.join(root, 'audit-2026-05-19T10-00-00.md');
  fs.writeFileSync(old, 'old', { mode: 0o644 });
  fs.chmodSync(old, 0o644);

  const file = writeAuditFile(root, 'new', stamp);

  assert.equal(file, old);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(modeOf(file) & 0o077, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
