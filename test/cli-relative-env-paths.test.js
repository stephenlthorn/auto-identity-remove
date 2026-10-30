/**
 * test/cli-relative-env-paths.test.js
 *
 * CLI2-12: a relative AIDR_* path meant two different files depending on how the
 * tool was started. run.sh anchors it to the directory the user launched it from;
 * the `aidr` dispatcher spawns the watcher with the repo root as its working
 * directory, so the same variable resolved against the repo root. Scheduled runs
 * (run.sh) and manual `aidr run` then read and wrote different state.json files,
 * and the same broker was submitted twice.
 *
 * The dispatcher now makes every AIDR_* path variable absolute against the user's
 * own directory before it spawns anything, which is what run.sh does.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { absolutizePathEnv, PATH_ENV_VARS } = require('../lib/cli-map');

const AIDR = path.resolve(__dirname, '..', 'bin', 'aidr.js');

test('PATH_ENV_VARS is the list run.sh anchors, plus the dashboard auth file', () => {
  const runSh = fs.readFileSync(path.resolve(__dirname, '..', 'run.sh'), 'utf8');
  const listed = runSh.match(/for var in ([A-Z_ ]+); do/)[1].trim().split(/\s+/);
  for (const name of listed) assert.ok(PATH_ENV_VARS.includes(name), `${name} is anchored by run.sh, so the dispatcher must anchor it too`);
  assert.ok(PATH_ENV_VARS.includes('AIDR_AUTH_FILE'));
});

test('a relative path is anchored at the directory the user ran the command from', () => {
  const env = absolutizePathEnv({ AIDR_STATE_PATH: 'data/state.json', AIDR_HOME: './home', AIDR_PASSPHRASE_FILE: '../pass' }, '/work/me');
  assert.equal(env.AIDR_STATE_PATH, path.resolve('/work/me', 'data/state.json'));
  assert.equal(env.AIDR_HOME, path.resolve('/work/me', 'home'));
  assert.equal(env.AIDR_PASSPHRASE_FILE, path.resolve('/work/me', '../pass'));
});

test('an absolute path, an empty value and an unset variable are left alone', () => {
  const abs = path.resolve('/srv/aidr/state.json');
  const env = absolutizePathEnv({ AIDR_STATE_PATH: abs, AIDR_LOG_DIR: '', PATH: 'bin:usr/bin' }, '/work/me');
  assert.equal(env.AIDR_STATE_PATH, abs);
  assert.equal(env.AIDR_LOG_DIR, '', 'empty counts as unset, as lib/paths.js reads it');
  assert.equal('AIDR_CONFIG_PATH' in env, false, 'nothing is invented');
  assert.equal(env.PATH, 'bin:usr/bin', 'only AIDR_* path variables are touched');
});

test('variables that are not paths are never rewritten', () => {
  const env = absolutizePathEnv({ AIDR_USER: 'me', AIDR_PASS: 'pw', AIDR_PASSPHRASE: 'a/b', AIDR_PORT: '8080', AIDR_LOCK_MAX_AGE_HOURS: '6' }, '/work/me');
  assert.deepEqual(env, { AIDR_USER: 'me', AIDR_PASS: 'pw', AIDR_PASSPHRASE: 'a/b', AIDR_PORT: '8080', AIDR_LOCK_MAX_AGE_HOURS: '6' });
});

test('the input environment is not mutated', () => {
  const input = { AIDR_STATE_PATH: 'rel/state.json' };
  absolutizePathEnv(input, '/work/me');
  assert.equal(input.AIDR_STATE_PATH, 'rel/state.json');
});

// A read-only command that prints which files it is using, run through the real
// dispatcher from a directory that is NOT the repo root.
test('through bin/aidr.js, a relative AIDR_* path names the same files as it does for run.sh: under the launch directory', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-relative-env-')));
  try {
    fs.mkdirSync(path.join(dir, 'rel'));
    const r = spawnSync(process.execPath, [AIDR, 'config', 'check'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        AIDR_HOME: 'rel',
        AIDR_CONFIG_PATH: 'rel/config.json',
        AIDR_STATE_PATH: 'rel/state.json',
        AIDR_PASSPHRASE: '',
        AIDR_PASSPHRASE_FILE: '',
      },
    });
    const out = r.stdout + r.stderr;
    assert.ok(out.includes(path.join(dir, 'rel', 'config.json')), `the config path is under the launch directory:\n${out}`);
    assert.ok(out.includes(path.join(dir, 'rel', 'state.json')), `the state path is under the launch directory:\n${out}`);
    const repoRoot = path.resolve(__dirname, '..');
    assert.ok(!out.includes(path.join(repoRoot, 'rel')), 'and not under the repo root');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
