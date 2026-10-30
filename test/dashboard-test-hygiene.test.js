/**
 * test/dashboard-test-hygiene.test.js
 *
 * TEST HYGIENE (P1): dashboard/server.test.js used to write fixtures over the
 * real repo-root config.json, state.json and config.json.enc and restore them
 * in a finally block. On a maintainer's real install those files hold real PII;
 * a Ctrl-C (or a crash) mid-test left fixtures where the real files had been.
 *
 * This runs the dashboard test files in a child process with
 * dashboard/support/fs-guard.js preloaded - any write, rename or delete of a
 * repo-root config/state/log/auth file THROWS - and then checks the protected
 * files are exactly as they were.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'dashboard', 'support', 'fs-guard.js');
const DASHBOARD = path.join(ROOT, 'dashboard');
const HAS_EXPRESS = fs.existsSync(path.join(DASHBOARD, 'node_modules', 'express'));

const WATCHED = ['config.json', 'config.json.enc', 'config.json.bak', 'state.json', 'state.json.bak',
  'state.json.lock', path.join('dashboard', '.auth.json')];

function fingerprint() {
  return WATCHED.map(rel => {
    try {
      const st = fs.statSync(path.join(ROOT, rel));
      return `${rel}:${st.size}:${st.mtimeMs}`;
    } catch (_) {
      return `${rel}:absent`;
    }
  }).join('\n');
}

// NODE_TEST_CONTEXT marks "I am a test file of an outer node --test"; inherited
// by a nested `node --test` it makes the inner run report nothing and exit 0.
function guardedEnv() {
  const env = { ...process.env, NODE_OPTIONS: `--require=${GUARD}` };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runGuarded(code) {
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: guardedEnv() });
}

test('the guard refuses writes to the real repo-root config, state and log files', () => {
  const out = runGuarded(`
    const fs = require('fs'), path = require('path');
    const root = ${JSON.stringify(ROOT)};
    const attempts = {
      writeConfig: () => fs.writeFileSync(path.join(root, 'config.json'), '{}'),
      writeEnc: () => fs.writeFileSync(path.join(root, 'config.json.enc'), '{}'),
      writeState: () => fs.writeFileSync(path.join(root, 'state.json'), '{}'),
      unlinkState: () => fs.unlinkSync(path.join(root, 'state.json')),
      renameOverConfig: () => fs.renameSync(path.join(root, 'x.tmp'), path.join(root, 'config.json')),
      openStateForWrite: () => fs.openSync(path.join(root, 'state.json.tmp-ab'), 'wx'),
      writeLog: () => fs.writeFileSync(path.join(root, 'logs', 'run.log'), 'x'),
      writeAuth: () => fs.writeFileSync(path.join(root, 'dashboard', '.auth.json'), '{}'),
    };
    const refused = [];
    for (const [name, fn] of Object.entries(attempts)) {
      try { fn(); } catch (e) { if (e.code === 'EAIDRGUARD') refused.push(name); }
    }
    process.stdout.write(JSON.stringify(refused));
  `);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).sort(), [
    'openStateForWrite', 'renameOverConfig', 'unlinkState', 'writeAuth', 'writeConfig', 'writeEnc', 'writeLog', 'writeState',
  ]);
});

test('the guard allows writes under a temp dir and reads of repo files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-guard-'));
  const out = runGuarded(`
    const fs = require('fs'), path = require('path');
    const dir = ${JSON.stringify(dir)};
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    fs.renameSync(path.join(dir, 'config.json'), path.join(dir, 'state.json'));
    fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'package.json'));
    process.stdout.write('ok');
  `);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'ok');
});

test('the dashboard test files never touch the real repo-root config, state or auth files', (t) => {
  if (!HAS_EXPRESS) {
    t.skip('dashboard dependencies are not installed (run: cd dashboard && npm ci)');
    return;
  }
  const before = fingerprint();
  const files = fs.readdirSync(DASHBOARD).filter(n => n.endsWith('.test.js'));
  assert.ok(files.length > 0);
  const run = spawnSync(process.execPath, ['--test', ...files], {
    cwd: DASHBOARD,
    encoding: 'utf8',
    env: guardedEnv(),
    timeout: 240000,
  });
  const tail = `${run.stdout}\n${run.stderr}`.split('\n').slice(-40).join('\n');
  assert.equal(run.status, 0, `dashboard tests failed under the fs guard:\n${tail}`);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /fs-guard: refusing/);
  assert.equal(fingerprint(), before, 'a protected repo-root file changed during the dashboard tests');
});
