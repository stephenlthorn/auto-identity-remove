/**
 * test/paths-resolve.test.js
 *
 * R0: one home directory for every runtime file. lib/paths.js is the single
 * place that decides where config, state, logs, snapshots, reports, complaints,
 * the history caches and the confirmation inbox live.
 *
 * The contract has two halves that pull in opposite directions:
 *   - AIDR_HOME relocates everything, so a Docker/NAS install keeps ONE mount;
 *   - with no AIDR_* variable at all every path is byte-for-byte what it was
 *     before this module existed, so existing installs keep reading the files
 *     they already have.
 * The "legacy" expectations below are written out independently (not derived
 * from resolvePaths) so a regression in the resolver cannot hide behind itself.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolvePaths, describePaths } = require('../lib/paths');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = path.resolve('/opt/aidr-app');
const HOME = path.resolve('/srv/aidr-home');

const legacyPaths = root => ({
  home: root,
  config: path.join(root, 'config.json'),
  configEnc: path.join(root, 'config.json.enc'),
  state: path.join(root, 'state.json'),
  logs: path.join(root, 'logs'),
  snapshots: path.join(root, 'logs', 'snapshots'),
  reports: path.join(root, 'logs', 'reports'),
  complaints: path.join(root, 'logs', 'complaints'),
  data: path.join(root, 'data'),
  inbox: path.join(root, 'inbox'),
});

const inside = (dir, ...rest) => path.join(dir, ...rest);

test('with no AIDR_* variable every path is exactly what it was before R0', () => {
  assert.deepEqual({ ...resolvePaths({}, ROOT) }, legacyPaths(ROOT));
});

test('the default root is the repo root and the default env is process.env', () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AIDR_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    assert.deepEqual({ ...resolvePaths() }, legacyPaths(REPO_ROOT));
    assert.equal(resolvePaths({}).config, path.join(REPO_ROOT, 'config.json'));
  } finally {
    Object.assign(process.env, saved);
  }
});

test('AIDR_HOME is the default base for every runtime file', () => {
  const p = resolvePaths({ AIDR_HOME: HOME }, ROOT);
  assert.deepEqual({ ...p }, {
    home: HOME,
    config: inside(HOME, 'config.json'),
    configEnc: inside(HOME, 'config.json.enc'),
    state: inside(HOME, 'state.json'),
    logs: inside(HOME, 'logs'),
    snapshots: inside(HOME, 'logs', 'snapshots'),
    reports: inside(HOME, 'logs', 'reports'),
    complaints: inside(HOME, 'logs', 'complaints'),
    data: inside(HOME, 'data'),
    inbox: inside(HOME, 'inbox'),
  });
});

test('a relative AIDR_HOME is resolved against the working directory, like the other env paths', () => {
  const p = resolvePaths({ AIDR_HOME: 'aidr-home' }, ROOT);
  assert.equal(p.home, path.resolve('aidr-home'));
  assert.equal(p.state, path.resolve('aidr-home', 'state.json'));
});

test('an empty AIDR_HOME means "not set"', () => {
  assert.deepEqual({ ...resolvePaths({ AIDR_HOME: '' }, ROOT) }, legacyPaths(ROOT));
});

test('AIDR_CONFIG_PATH wins over AIDR_HOME and carries the encrypted default with it', () => {
  const cfg = path.resolve('/etc/aidr/mine.json');
  const p = resolvePaths({ AIDR_HOME: HOME, AIDR_CONFIG_PATH: cfg }, ROOT);
  assert.equal(p.config, cfg);
  assert.equal(p.configEnc, cfg + '.enc', 'the encrypted envelope defaults to <config path>.enc, as before');
  assert.equal(p.state, inside(HOME, 'state.json'), 'unrelated paths still follow AIDR_HOME');
});

test('AIDR_CONFIG_ENC_PATH wins over AIDR_HOME and over the <config>.enc default', () => {
  const enc = path.resolve('/vault/cfg.enc');
  const p = resolvePaths({ AIDR_HOME: HOME, AIDR_CONFIG_ENC_PATH: enc }, ROOT);
  assert.equal(p.configEnc, enc);
  assert.equal(p.config, inside(HOME, 'config.json'));
});

test('AIDR_STATE_PATH wins over AIDR_HOME', () => {
  const state = path.resolve('/var/lib/aidr/state.json');
  const p = resolvePaths({ AIDR_HOME: HOME, AIDR_STATE_PATH: state }, ROOT);
  assert.equal(p.state, state);
  assert.equal(p.config, inside(HOME, 'config.json'));
});

test('AIDR_LOG_DIR wins over AIDR_HOME and moves snapshots, reports and complaints with it', () => {
  const logs = path.resolve('/var/log/aidr');
  const p = resolvePaths({ AIDR_HOME: HOME, AIDR_LOG_DIR: logs }, ROOT);
  assert.equal(p.logs, logs);
  assert.equal(p.snapshots, inside(logs, 'snapshots'));
  assert.equal(p.reports, inside(logs, 'reports'));
  assert.equal(p.complaints, inside(logs, 'complaints'));
  assert.equal(p.data, inside(HOME, 'data'));
});

test('AIDR_DATA_DIR wins over AIDR_HOME', () => {
  const data = path.resolve('/var/cache/aidr');
  const p = resolvePaths({ AIDR_HOME: HOME, AIDR_DATA_DIR: data }, ROOT);
  assert.equal(p.data, data);
  assert.equal(p.logs, inside(HOME, 'logs'));
});

test('each specific variable works on its own, without AIDR_HOME', () => {
  const logs = path.resolve('/l');
  const data = path.resolve('/d');
  const p = resolvePaths({ AIDR_LOG_DIR: logs, AIDR_DATA_DIR: data }, ROOT);
  const legacy = legacyPaths(ROOT);
  assert.equal(p.logs, logs);
  assert.equal(p.data, data);
  assert.equal(p.config, legacy.config);
  assert.equal(p.state, legacy.state);
  assert.equal(p.inbox, legacy.inbox);
});

test('the inbox follows AIDR_HOME and has no variable of its own', () => {
  assert.equal(resolvePaths({ AIDR_HOME: HOME }, ROOT).inbox, inside(HOME, 'inbox'));
  assert.equal(resolvePaths({}, ROOT).inbox, inside(ROOT, 'inbox'));
});

test('resolvePaths does not read or modify the environment it is given', () => {
  const env = Object.freeze({ AIDR_HOME: HOME });
  assert.doesNotThrow(() => resolvePaths(env, ROOT));
  assert.deepEqual({ ...env }, { AIDR_HOME: HOME });
});

test('the resolved set is frozen so a caller cannot move a runtime path by accident', () => {
  const p = resolvePaths({ AIDR_HOME: HOME }, ROOT);
  assert.throws(() => { p.state = '/elsewhere'; }, TypeError);
});

// ── describePaths ────────────────────────────────────────────────────────────

test('describePaths returns printable lines naming every resolved path', () => {
  const lines = describePaths({ AIDR_HOME: HOME }, ROOT);
  assert.ok(Array.isArray(lines) && lines.every(l => typeof l === 'string'));
  const p = resolvePaths({ AIDR_HOME: HOME }, ROOT);
  const text = lines.join('\n');
  for (const key of ['home', 'config', 'configEnc', 'state', 'logs', 'snapshots', 'reports', 'complaints', 'data', 'inbox']) {
    assert.ok(text.includes(p[key]), `describePaths must show ${key} (${p[key]})`);
  }
});

test('describePaths says which variable decided each path', () => {
  const cfg = path.resolve('/etc/aidr/mine.json');
  const text = describePaths({ AIDR_HOME: HOME, AIDR_CONFIG_PATH: cfg }, ROOT).join('\n');
  const line = needle => text.split('\n').find(l => l.includes(needle));
  assert.match(line(cfg), /AIDR_CONFIG_PATH/);
  assert.match(line(inside(HOME, 'state.json')), /AIDR_HOME/);
});

test('describePaths marks the app directory default when nothing is set', () => {
  const text = describePaths({}, ROOT).join('\n');
  assert.match(text, /default/i);
  assert.doesNotMatch(text, /\[AIDR_HOME\]/, 'no path may claim AIDR_HOME decided it when it is unset');
});

test('describePaths also lists the lock and checkpoint that sit beside the state file', () => {
  const text = describePaths({ AIDR_HOME: HOME }, ROOT).join('\n');
  assert.ok(text.includes(inside(HOME, 'state.json.lock')));
  assert.ok(text.includes(inside(HOME, 'state.json.checkpoint')));
});

test('describePaths shows where the shipped read-only datasets load from', () => {
  const text = describePaths({ AIDR_HOME: HOME }, ROOT).join('\n');
  assert.ok(text.includes(inside(ROOT, 'data')), 'the shipped datasets stay in the app directory even with AIDR_HOME set');
});
