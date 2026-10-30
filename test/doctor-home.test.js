/**
 * test/doctor-home.test.js
 *
 * R0: AIDR_HOME is a directory the tool must write to at the END of a long run (state,
 * the journal, the log, the heartbeat). A mount that is read-only, owned by another
 * uid (the Docker image runs as 1001, and the files an install makes are 0600 and
 * owned by you), or simply not there, otherwise shows up as a failed write hours
 * after the run started. `aidr doctor` checks the home directory up front.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkHome, runDoctor } = require('../lib/doctor');

const posix = process.platform !== 'win32';
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-home-')));

test('an existing, writable, private home is ok', { skip: !posix }, () => {
  const home = tmp();
  try {
    fs.chmodSync(home, 0o700);
    const r = checkHome({ home, explicit: true });
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
    assert.ok(r.hint.includes(home));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a home that does not exist yet is fine but said so: the first write creates it', () => {
  const root = tmp();
  try {
    const r = checkHome({ home: path.join(root, 'not-yet'), explicit: true });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.hint, /does not exist yet/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a home that is a file is a failure', () => {
  const root = tmp();
  try {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'x');
    const r = checkHome({ home: file, explicit: true });
    assert.equal(r.ok, false);
    assert.match(r.hint, /not a directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a home this user cannot write to is a failure that names the uid and the Docker fix', { skip: !posix || (typeof process.getuid === 'function' && process.getuid() === 0) }, () => {
  const home = tmp();
  try {
    fs.chmodSync(home, 0o500);
    const r = checkHome({ home, explicit: true });
    assert.equal(r.ok, false);
    assert.match(r.hint, /not writable/);
    assert.match(r.hint, /uid \d+/);
    assert.match(r.hint, /1001/);
  } finally {
    fs.chmodSync(home, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit home readable by other users is a warning (it holds PII)', { skip: !posix }, () => {
  const home = tmp();
  try {
    fs.chmodSync(home, 0o755);
    const r = checkHome({ home, explicit: true });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.hint, /readable by other users/);
    assert.match(r.hint, /chmod 700/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the app directory itself is not nagged about its mode: only an AIDR_HOME the user chose is', { skip: !posix }, () => {
  const home = tmp();
  try {
    fs.chmodSync(home, 0o755);
    const r = checkHome({ home, explicit: false });
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runDoctor includes a home check, driven by AIDR_HOME', async () => {
  const home = tmp();
  try {
    fs.chmodSync(home, 0o700);
    const results = await runDoctor({
      printOutput: false,
      env: { AIDR_HOME: home },
      scheduleStatus: { installed: false, kind: null, kinds: [], schedule: null, target: null, active: null, env: {}, plaintextPassphrase: false, lastRun: null },
      requirePlaywright: () => ({ chromium: { executablePath: () => '/x' } }),
      fsExists: () => true,
      statePath: path.join(home, 'state.json'),
    });
    const homeCheck = results.find(r => r.name === 'home');
    assert.ok(homeCheck, 'the home check ran');
    assert.equal(homeCheck.ok, true);
    assert.ok(homeCheck.hint.includes(home));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
