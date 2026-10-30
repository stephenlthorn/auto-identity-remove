/**
 * test/scheduler-carried-home.test.js
 *
 * R0 added AIDR_HOME (and AIDR_LOG_DIR / AIDR_DATA_DIR) as the way to move every
 * runtime file. A scheduled job starts with a bare environment, so a variable the
 * installer does not carry is a variable the job never sees: it then ran against
 * the app directory's empty config, or wrote its logs somewhere the user does not
 * look. The passphrase itself must still never be carried.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');

const { buildPlist, buildSystemdUnits, buildCronLine, carriedEnvironment, installScheduleForPlatform, getScheduleStatus } = require('../lib/scheduler');

const ENV = {
  AIDR_HOME: '/srv/aidr-home',
  AIDR_LOG_DIR: '/srv/logs',
  AIDR_DATA_DIR: '/srv/data',
  AIDR_PASSPHRASE: 'hunter2-secret',
};

test('carriedEnvironment carries AIDR_HOME, AIDR_LOG_DIR and AIDR_DATA_DIR as absolute paths, and never the passphrase', () => {
  const names = carriedEnvironment(ENV).map(([name]) => name);
  for (const name of ['AIDR_HOME', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR']) assert.ok(names.includes(name), `${name} should be carried`);
  assert.ok(!names.includes('AIDR_PASSPHRASE'));

  const rel = carriedEnvironment({ AIDR_HOME: 'aidr-home' }).find(([name]) => name === 'AIDR_HOME');
  assert.equal(rel[1], path.resolve('aidr-home'), 'a relative path is anchored at install time');
});

test('the plist carries them into the job', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: ENV });
  for (const name of ['AIDR_HOME', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR']) assert.ok(xml.includes(`<key>${name}</key>`), `${name} missing from the plist`);
  assert.ok(!xml.includes('hunter2-secret'));
});

test('the systemd service carries them into the job', () => {
  const { service } = buildSystemdUnits('/s/run.sh', '/s/logs', { env: ENV });
  for (const name of ['AIDR_HOME', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR']) assert.ok(service.includes(name), `${name} missing from the service`);
  assert.ok(!service.includes('hunter2-secret'));
});

test('the cron line carries them into the job', () => {
  const line = buildCronLine('/s/run.sh', '/s/logs', { env: ENV });
  for (const name of ['AIDR_HOME', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR']) assert.ok(line.includes(name), `${name} missing from the cron line`);
  assert.ok(!line.includes('hunter2-secret'));
});

test('a status read of a plist that carries them reports them', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: ENV });
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-home-'));
  try {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'com.auto-identity-remove.plist'), xml);
    const status = getScheduleStatus({
      platform: 'macos',
      homeDir: home,
      heartbeatPath: path.join(home, 'last-run.json'),
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(status.installed, true);
    assert.equal(status.env.AIDR_HOME, '/srv/aidr-home');
    assert.equal(status.env.AIDR_LOG_DIR, '/srv/logs');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a Windows task cannot carry them, so the note names whichever is set', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => Buffer.from('');
  try {
    const result = installScheduleForPlatform({
      platform: 'windows',
      scriptPath: 'C:\\aidr\\run.sh',
      logDir: 'C:\\aidr\\logs',
      env: { AIDR_HOME: 'C:\\aidr-home' },
    });
    assert.match(result.detail, /setx AIDR_HOME/);
  } finally {
    childProcess.execFileSync = original;
  }
});

test('a Windows task with nothing to carry gets no note', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => Buffer.from('');
  try {
    const result = installScheduleForPlatform({ platform: 'windows', scriptPath: 'C:\\aidr\\run.sh', logDir: 'C:\\aidr\\logs', env: {} });
    assert.doesNotMatch(result.detail, /setx/);
  } finally {
    childProcess.execFileSync = original;
  }
});
