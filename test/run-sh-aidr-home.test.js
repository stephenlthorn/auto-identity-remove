/**
 * test/run-sh-aidr-home.test.js
 *
 * R0: AIDR_HOME names one directory for every runtime file, and run.sh is what a
 * scheduled job executes. It looked for config.json in the project directory only
 * (and for AIDR_CONFIG_PATH), so a job on an AIDR_HOME install exited "no config
 * found" before node started, even though watcher.js would have found it.
 *
 * Like test/run-sh-config.test.js this runs run.sh for real in a temp copy of the
 * project with a stub `node` that records the environment it was handed.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN_SH = path.resolve(__dirname, '..', 'run.sh');
const VARS = ['AIDR_HOME', 'AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR', 'AIDR_PASSPHRASE_FILE'];

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-runsh-home-')));
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  fs.copyFileSync(RUN_SH, path.join(project, 'run.sh'));
  fs.writeFileSync(path.join(project, 'watcher.js'), '// never run: node is stubbed\n');

  const record = path.join(root, 'node-env.txt');
  const lines = VARS.map(v => `printf '${v}=%s\\n' "$${v}"`);
  fs.writeFileSync(path.join(bin, 'node'), ['#!/bin/bash', `{ ${lines.join('; ')}; } > '${record}'`, 'exit 0', ''].join('\n'), { mode: 0o755 });

  return {
    root,
    project,
    bin,
    ran: () => fs.existsSync(record),
    seen: () => Object.fromEntries(fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runSh(p, { env = {}, cwd = p.project } = {}) {
  return spawnSync('/bin/bash', [path.join(p.project, 'run.sh')], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${p.bin}:/usr/bin:/bin`, HOME: p.root, ...env },
  });
}

const withHome = (p, files) => {
  const home = path.join(p.root, 'aidr-home');
  fs.mkdirSync(home);
  for (const f of files) fs.writeFileSync(path.join(home, f), '{}');
  return home;
};

test('run.sh finds a plaintext config inside AIDR_HOME', () => {
  const p = makeProject();
  try {
    const home = withHome(p, ['config.json']);
    const r = runSh(p, { env: { AIDR_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(p.seen().AIDR_HOME, home);
  } finally { p.cleanup(); }
});

test('run.sh finds an encrypted config inside AIDR_HOME, and still demands a passphrase for it', () => {
  const p = makeProject();
  try {
    const home = withHome(p, ['config.json.enc']);
    const refused = runSh(p, { env: { AIDR_HOME: home } });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /AIDR_PASSPHRASE_FILE/);
    assert.equal(p.ran(), false, 'node must not start');

    const ok = runSh(p, { env: { AIDR_HOME: home, AIDR_PASSPHRASE: 'pw' } });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { p.cleanup(); }
});

test('with AIDR_HOME and no config anywhere, run.sh names where it looked', () => {
  const p = makeProject();
  try {
    const home = withHome(p, []);
    const r = runSh(p, { env: { AIDR_HOME: home } });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(path.join(home, 'config.json')), r.stderr);
    assert.match(r.stderr, /setup/);
    assert.equal(p.ran(), false);
  } finally { p.cleanup(); }
});

test('AIDR_CONFIG_PATH still wins over AIDR_HOME', () => {
  const p = makeProject();
  try {
    const home = withHome(p, []);
    const elsewhere = path.join(p.root, 'mine.json');
    fs.writeFileSync(elsewhere, '{}');
    const r = runSh(p, { env: { AIDR_HOME: home, AIDR_CONFIG_PATH: elsewhere } });
    assert.equal(r.status, 0, r.stderr);
  } finally { p.cleanup(); }
});

test('a relative AIDR_HOME is anchored where run.sh was launched, then handed to node as an absolute path', () => {
  const p = makeProject();
  try {
    const launch = path.join(p.root, 'launch');
    fs.mkdirSync(path.join(launch, 'h'), { recursive: true });
    fs.writeFileSync(path.join(launch, 'h', 'config.json'), '{}');
    const r = runSh(p, { cwd: launch, env: { AIDR_HOME: 'h' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(p.seen().AIDR_HOME, path.join(launch, 'h'), 'run.sh cds into the project, so a relative path would point at the wrong place');
  } finally { p.cleanup(); }
});

test('every path variable is made absolute before run.sh moves to the project directory', () => {
  const p = makeProject();
  try {
    const launch = path.join(p.root, 'launch');
    fs.mkdirSync(launch);
    fs.writeFileSync(path.join(launch, 'c.json'), '{}');
    fs.writeFileSync(path.join(launch, 'pass'), 'pw\n', { mode: 0o600 });
    const r = runSh(p, { cwd: launch, env: { AIDR_CONFIG_PATH: 'c.json', AIDR_STATE_PATH: 's.json', AIDR_LOG_DIR: 'logs', AIDR_DATA_DIR: 'data', AIDR_PASSPHRASE_FILE: 'pass' } });
    assert.equal(r.status, 0, r.stderr);
    const seen = p.seen();
    assert.equal(seen.AIDR_CONFIG_PATH, path.join(launch, 'c.json'));
    assert.equal(seen.AIDR_STATE_PATH, path.join(launch, 's.json'));
    assert.equal(seen.AIDR_LOG_DIR, path.join(launch, 'logs'));
    assert.equal(seen.AIDR_DATA_DIR, path.join(launch, 'data'));
    assert.equal(seen.AIDR_PASSPHRASE_FILE, path.join(launch, 'pass'));
  } finally { p.cleanup(); }
});

test('a variable that is not set stays unset: run.sh invents no path of its own', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.project, 'config.json'), '{}');
    const r = runSh(p);
    assert.equal(r.status, 0, r.stderr);
    const seen = p.seen();
    for (const v of VARS) assert.equal(seen[v], '', `${v} should still be empty`);
  } finally { p.cleanup(); }
});
