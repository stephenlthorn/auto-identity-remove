/**
 * test/history-files-private.test.js
 *
 * CFG2-12: data/serp-history.json and data/exposure-history.json (and its .bak)
 * were written with the process umask, 0644 on a default box. They record which
 * brokers list the user, for which person (a hash) and when: private files, like
 * the run logs. A directory the writer has to create is created 0700; one that
 * already exists is not ours to chmod (the default data/ also holds the datasets
 * that ship with the app).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skip = process.platform === 'win32' ? 'POSIX modes' : false;

const serp = require('../lib/serp-scan');
const exposure = require('../lib/exposure');

const mode = (p) => fs.statSync(p).mode & 0o777;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-hist-'));

function underUmask(value, fn) {
  const prev = process.umask(value);
  try { return fn(); } finally { process.umask(prev); }
}

const ROW = { personId: 'abc', broker: 'Spokeo', engine: 'ddg', rank: 1, hostname: 'spokeo.com', scannedAt: new Date().toISOString() };

test('serp history is created 0600 in a 0700 directory, whatever the umask', { skip }, () => {
  const base = tmp();
  const file = path.join(base, 'data', 'serp-history.json');
  underUmask(0o022, () => serp.appendManyToHistory([ROW], file));
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('an existing 0644 serp history is tightened, and an existing directory is left alone', { skip }, () => {
  const base = tmp();
  const dir = path.join(base, 'data');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, 'serp-history.json');
  fs.writeFileSync(file, JSON.stringify([ROW]), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  underUmask(0o022, () => serp.appendManyToHistory([ROW], file));
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o755, 'a directory that was already there keeps its mode');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2, 'history appended, not replaced');
  assert.deepEqual(fs.readdirSync(dir), ['serp-history.json'], 'no temp file left behind');
  fs.rmSync(base, { recursive: true, force: true });
});

test('exposure history and its .bak are 0600, whatever the umask', { skip }, () => {
  const base = tmp();
  const file = path.join(base, 'data', 'exposure-history.json');
  exposure.setTestExposureHistoryPath(file);
  try {
    underUmask(0o022, () => {
      exposure.snapshotExposure({ score: 10, breakdown: {}, listedCount: 1, serpHits: 0, breachWeight: 0 });
      exposure.snapshotExposure({ score: 20, breakdown: {}, listedCount: 2, serpHits: 0, breachWeight: 0 });
    });
  } finally {
    exposure.setTestExposureHistoryPath(null);
  }
  assert.equal(mode(file), 0o600);
  assert.equal(mode(file + '.bak'), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).length, 2, 'the backup is the file just written');
  fs.rmSync(base, { recursive: true, force: true });
});

test('an old 0644 exposure history and .bak are tightened on the next snapshot', { skip }, () => {
  const base = tmp();
  const file = path.join(base, 'exposure-history.json');
  for (const f of [file, file + '.bak']) { fs.writeFileSync(f, '[]', { mode: 0o644 }); fs.chmodSync(f, 0o644); }
  exposure.setTestExposureHistoryPath(file);
  try {
    underUmask(0o022, () => exposure.snapshotExposure({ score: 5, breakdown: {}, listedCount: 0, serpHits: 0, breachWeight: 0 }));
  } finally {
    exposure.setTestExposureHistoryPath(null);
  }
  assert.equal(mode(file), 0o600);
  assert.equal(mode(file + '.bak'), 0o600);
  fs.rmSync(base, { recursive: true, force: true });
});
