// test/complaint-files-private.test.js
/**
 * codex #1: complaint files carry the user's name, address, email and phone,
 * so the directory is 0700 and every TXT/PDF is 0600 regardless of umask, and
 * even when an older run already created them world-readable.
 *
 * NET-8 / codex #10: filenames include the person, so person B's complaint no
 * longer overwrites person A's for the same broker and agency.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeComplaintFiles } = require('../lib/complaint');

const posix = process.platform !== 'win32';
const mode = (p) => fs.statSync(p).mode & 0o777;

function withTmp(fn) {
  return async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-complaint-'));
    const oldUmask = process.umask(0o022);
    try { await fn(base); } finally {
      process.umask(oldUmask);
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

const complaints = (who) => [
  { agency: 'CA_AG', subject: 'S', body: `CA AG body for ${who}` },
  { agency: 'FTC', subject: 'S', body: `FTC body for ${who}` },
];

const stubPage = () => async () => ({
  setContent: async () => {},
  pdf: async (opts) => { fs.writeFileSync(opts.path, '%PDF-1.4 stub'); },
  close: async () => {},
});

test('codex #1: a new complaints dir is 0700 and its TXT and PDF files are 0600', { skip: !posix }, withTmp(async (base) => {
  const outDir = path.join(base, 'logs', 'complaints');
  const { written } = await writeComplaintFiles({
    outDir,
    entries: [{ broker: 'Spokeo', complaints: complaints('Jane') }],
    newPage: stubPage(),
  });

  assert.equal(mode(outDir), 0o700);
  assert.ok(written.some(p => p.endsWith('.pdf')) && written.some(p => p.endsWith('.txt')));
  for (const p of written) assert.equal(mode(p), 0o600, `${path.basename(p)} must be owner-only`);
}));

test('codex #1: a dir and files left world-readable by an older run are tightened', { skip: !posix }, withTmp(async (base) => {
  const outDir = path.join(base, 'complaints');
  fs.mkdirSync(outDir, { mode: 0o755 });
  fs.chmodSync(outDir, 0o755);
  const old = path.join(outDir, 'Spokeo-CA_AG.txt');
  fs.writeFileSync(old, 'old body');
  fs.chmodSync(old, 0o644);

  const { written } = await writeComplaintFiles({
    outDir,
    entries: [{ broker: 'Spokeo', complaints: complaints('Jane') }],
    newPage: stubPage(),
  });

  assert.equal(mode(outDir), 0o700);
  assert.equal(fs.readFileSync(old, 'utf8'), 'CA AG body for Jane');
  for (const p of written) assert.equal(mode(p), 0o600);
}));

test('NET-8 / codex #10: two persons, one broker, two agencies -> four distinct files', withTmp(async (base) => {
  const { written } = await writeComplaintFiles({
    outDir: base,
    entries: [
      { broker: 'Spokeo', person: 'Alice Adams', complaints: complaints('Alice') },
      { broker: 'Spokeo', person: 'Bob Brown', complaints: complaints('Bob') },
    ],
  });

  assert.equal(new Set(written).size, 4);
  const bodies = written.map(p => fs.readFileSync(p, 'utf8')).sort();
  assert.deepEqual(bodies, [
    'CA AG body for Alice', 'CA AG body for Bob', 'FTC body for Alice', 'FTC body for Bob',
  ]);
  assert.ok(written.every(p => /Alice-Adams|Bob-Brown/.test(path.basename(p))), 'person slug is in the name');
}));

test('NET-8: the person slug cannot escape the directory', withTmp(async (base) => {
  const outDir = path.join(base, 'out');
  const { written } = await writeComplaintFiles({
    outDir,
    entries: [{ broker: '../evil', person: '../../Mallory/..', complaints: complaints('M') }],
  });
  for (const p of written) assert.equal(path.dirname(p), outDir);
}));

test('NET-8: a name with no filename-safe characters still yields a distinct, non-empty slug', withTmp(async (base) => {
  const { written } = await writeComplaintFiles({
    outDir: base,
    entries: [
      { broker: 'Spokeo', person: '李小龍', complaints: complaints('A') },
      { broker: 'Spokeo', person: '王小明', complaints: complaints('B') },
    ],
  });
  assert.equal(new Set(written).size, 4, 'neither person overwrites the other');
}));

test('codex #10: entries that collide anyway get a unique suffix instead of overwriting', withTmp(async (base) => {
  const { written } = await writeComplaintFiles({
    outDir: base,
    entries: [
      { broker: 'Spokeo', complaints: complaints('first') },
      { broker: 'Spokeo', complaints: complaints('second') },
    ],
  });
  assert.equal(new Set(written).size, 4);
  assert.deepEqual(
    written.map(p => fs.readFileSync(p, 'utf8')).sort(),
    ['CA AG body for first', 'CA AG body for second', 'FTC body for first', 'FTC body for second']
  );
}));

test('a single-person run without a person label keeps the legacy Broker-Agency filename', withTmp(async (base) => {
  const { written } = await writeComplaintFiles({
    outDir: base,
    entries: [{ broker: 'Spokeo', complaints: complaints('Jane') }],
  });
  assert.deepEqual(written.map(p => path.basename(p)).sort(), ['Spokeo-CA_AG.txt', 'Spokeo-FTC.txt']);
}));
