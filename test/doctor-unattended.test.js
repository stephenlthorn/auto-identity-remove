'use strict';
/**
 * test/doctor-unattended.test.js
 *
 * R4: an encrypted config needs its passphrase from somewhere when nobody is at
 * the keyboard. run.sh refuses to start an encrypted config with neither
 * AIDR_PASSPHRASE nor AIDR_PASSPHRASE_FILE, so a monthly job installed without
 * one fails every month, quietly. Doctor checks the variable is carried in the
 * INSTALLED JOB (not just set in the shell running doctor) and that the file it
 * names is one config loading will accept.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkUnattendedPassphrase } = require('../lib/doctor');

const SECRET = 'correct horse battery staple';
const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-pass-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function passFile(content = SECRET + '\n', mode = 0o600) {
  const file = path.join(tmpDir(), 'pass');
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const installed = (env, extra = {}) => ({
  installed: true, kind: 'cron', schedule: 'monthly, day 1 at 09:00', target: '/opt/aidr/run.sh',
  active: true, env, envVisible: true, plaintextPassphrase: false, ...extra,
});
const NOT_INSTALLED = { installed: false, kind: null, env: {}, plaintextPassphrase: false };

function check(args) {
  return checkUnattendedPassphrase({ platform: 'linux', env: {}, ...args });
}

describe('checkUnattendedPassphrase', () => {
  it('is a skip when the config is not encrypted: there is nothing to unlock', () => {
    const r = check({ encrypted: false, status: installed({}) });
    assert.equal(r.ok, true);
    assert.match(r.hint, /skipped/);
    assert.match(r.hint, /not encrypted/);
  });

  it('is a skip when no schedule is installed, naming what a scheduled run will need', () => {
    const r = check({ encrypted: true, status: NOT_INSTALLED });
    assert.equal(r.ok, true);
    assert.match(r.hint, /skipped/);
    assert.match(r.hint, /AIDR_PASSPHRASE_FILE/);
  });

  it('is ok when the installed job carries a passphrase file that config loading will accept', () => {
    const file = passFile();
    const r = check({ encrypted: true, status: installed({ AIDR_PASSPHRASE_FILE: file }) });
    assert.equal(r.ok, true, r.hint);
    assert.ok(!r.warn);
    assert.ok(r.hint.includes(file));
    assert.ok(!r.hint.includes(SECRET), 'the passphrase must never be printed');
  });

  it('fails when the job carries no passphrase source at all: run.sh will refuse to start', () => {
    const r = check({ encrypted: true, status: installed({ AIDR_STATE_PATH: '/data/state.json' }) });
    assert.equal(r.ok, false);
    assert.match(r.hint, /AIDR_PASSPHRASE_FILE/);
    assert.match(r.hint, /aidr schedule install/);
  });

  it('does not count a passphrase variable set only in the shell running doctor', () => {
    const file = passFile();
    const r = check({ encrypted: true, status: installed({}), env: { AIDR_PASSPHRASE_FILE: file, AIDR_PASSPHRASE: SECRET } });
    assert.equal(r.ok, false, 'the scheduled job does not inherit this shell');
  });

  it('fails when the file the job names does not exist', () => {
    const missing = path.join(tmpDir(), 'gone');
    const r = check({ encrypted: true, status: installed({ AIDR_PASSPHRASE_FILE: missing }) });
    assert.equal(r.ok, false);
    assert.match(r.hint, /does not exist/);
    assert.ok(r.hint.includes(missing));
  });

  it('fails when the file is empty', () => {
    const r = check({ encrypted: true, status: installed({ AIDR_PASSPHRASE_FILE: passFile('\n') }) });
    assert.equal(r.ok, false);
    assert.match(r.hint, /empty/);
  });

  it('fails when other accounts can read the file: config loading refuses it, so the job would fail', { skip: process.platform === 'win32' }, () => {
    const file = passFile(SECRET + '\n', 0o644);
    const r = check({ encrypted: true, status: installed({ AIDR_PASSPHRASE_FILE: file }) });
    assert.equal(r.ok, false);
    assert.match(r.hint, /readable by other/);
    assert.match(r.hint, /chmod 600/);
    assert.ok(!r.hint.includes(SECRET));
  });

  it('is ok but warns when the passphrase itself is written into the job definition', () => {
    const r = check({ encrypted: true, status: installed({}, { plaintextPassphrase: true }) });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.hint, /AIDR_PASSPHRASE/);
    assert.match(r.hint, /readable by other accounts/);
  });

  describe('where a job cannot carry an environment (Task Scheduler)', () => {
    const task = { ...installed({}), kind: 'schtasks', envVisible: false };

    it('is ok when the user environment has AIDR_PASSPHRASE_FILE (setx), checking the file', () => {
      const file = passFile();
      const r = check({ encrypted: true, status: task, env: { AIDR_PASSPHRASE_FILE: file }, platform: 'windows' });
      assert.equal(r.ok, true, r.hint);
      assert.match(r.hint, /Task Scheduler/);
    });

    it('warns, rather than fails, when it cannot see one: it cannot know what the task inherits', () => {
      const r = check({ encrypted: true, status: task, env: {}, platform: 'windows' });
      assert.equal(r.ok, true);
      assert.equal(r.warn, true);
      assert.match(r.hint, /setx AIDR_PASSPHRASE_FILE/);
    });
  });
});
