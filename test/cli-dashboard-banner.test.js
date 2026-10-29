/**
 * test/cli-dashboard-banner.test.js
 *
 * DASH-12, end to end: `aidr dashboard` must announce itself (URL, and a
 * password only when it generated one) AFTER the server is listening, must not
 * print a password that cannot log in, and must fail with a readable message -
 * and no banner - when the port is taken or express is not installed.
 *
 * Starts the real server on an ephemeral 127.0.0.1 port in its own process
 * group (as test/cli-dashboard-boot.test.js does) and kills the whole group.
 * Config, state and the saved-credentials file are redirected to a temp dir;
 * nothing under the repo root is written.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'aidr.js');
const HAS_EXPRESS = fs.existsSync(path.join(ROOT, 'dashboard', 'node_modules', 'express'));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-cli-dash-'));
  return {
    dir,
    env: {
      AIDR_STATE_PATH: path.join(dir, 'state.json'),
      AIDR_CONFIG_PATH: path.join(dir, 'config.json'),
      AIDR_CONFIG_ENC_PATH: path.join(dir, 'config.json.enc'),
      AIDR_AUTH_FILE: path.join(dir, 'auth.json'),
    },
  };
}

/** Run `aidr dashboard`; resolve with what happened once `until(out)` or exit. */
function runDashboard({ env, bin = BIN, cwd = ROOT, until }) {
  const baseEnv = { ...process.env };
  delete baseEnv.AIDR_USER; delete baseEnv.AIDR_PASS; delete baseEnv.AIDR_TOKEN; delete baseEnv.NODE_PATH;
  const child = spawn(process.execPath, [bin, 'dashboard'], {
    cwd, env: { ...baseEnv, AIDR_HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* gone */ } } };
  const finished = new Promise(resolve => {
    const done = (kind, code) => { clearTimeout(timer); clearInterval(poll); resolve({ kind, code, stdout, stderr }); };
    const timer = setTimeout(() => done('timeout'), 20000);
    const poll = setInterval(() => { if (until && until({ stdout, stderr })) done('until'); }, 50);
    child.on('exit', code => done('exit', code));
  });
  return { child, kill, finished, out: () => ({ stdout, stderr }) };
}

function get(port, pathname, auth) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers: auth ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {} }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

test('DASH-12: with saved credentials the banner names no password', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const sb = sandbox();
  fs.writeFileSync(sb.env.AIDR_AUTH_FILE, JSON.stringify({ user: 'owner', salt: 'aa', hash: 'bb' }));
  const port = await freePort();
  const run = runDashboard({ env: { ...sb.env, AIDR_PORT: String(port) }, until: o => o.stdout.includes('Dashboard ready') });
  const r = await run.finished;
  run.kill();
  assert.equal(r.kind, 'until', JSON.stringify(r));
  assert.match(r.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  assert.doesNotMatch(r.stdout, /Password:/, 'a generated password would 401 against .auth.json');
  assert.doesNotMatch(r.stdout, /Username:/);
  assert.match(r.stdout, /saved credentials/);
});

test('DASH-12: the generated password is printed only after listening, and it really logs in', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const sb = sandbox();
  const port = await freePort();
  const run = runDashboard({ env: { ...sb.env, AIDR_PORT: String(port) }, until: o => /Password:\s+\S+/.test(o.stdout) });
  const r = await run.finished;
  try {
    assert.equal(r.kind, 'until', JSON.stringify(r));
    const listening = r.stdout.indexOf('aidr-dashboard listening');
    const banner = r.stdout.indexOf('Dashboard ready');
    assert.ok(listening >= 0 && banner > listening, `banner must follow the server's listening line:\n${r.stdout}`);
    const pass = r.stdout.match(/Password:\s+(\S+)/)[1];
    const user = r.stdout.match(/Username:\s+(\S+)/)[1];
    assert.equal(await get(port, '/api/version', `${user}:${pass}`), 200, 'the printed credentials must work');
    assert.equal(await get(port, '/api/version', `${user}:wrong`), 401);
  } finally {
    run.kill();
  }
});

test('DASH-12: a port already in use is a readable error with no banner, no password and no stack', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const sb = sandbox();
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const run = runDashboard({ env: { ...sb.env, AIDR_PORT: String(port) } });
  const r = await run.finished;
  run.kill();
  await new Promise(res => blocker.close(res));
  assert.equal(r.kind, 'exit', JSON.stringify(r));
  assert.notEqual(r.code, 0);
  const all = r.stdout + r.stderr;
  assert.match(all, /already in use/);
  assert.match(all, /AIDR_PORT/);
  assert.doesNotMatch(all, /Dashboard ready|Dashboard starting|Password:/);
  assert.doesNotMatch(all, /node:events|Emitted 'error'|at Server\./, 'no raw stack trace');
});

test('DASH-12: a missing express is a readable install hint with no banner', async () => {
  // A copy of just the dispatcher in a directory with no node_modules anywhere above it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-no-express-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'dashboard'));
  for (const f of ['bin/aidr.js', 'lib/cli-map.js', 'lib/dashboard-creds.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'dashboard', 'server.js'), "require('express');\n");
  const run = runDashboard({ env: {}, bin: path.join(dir, 'bin', 'aidr.js'), cwd: dir });
  const r = await run.finished;
  run.kill();
  assert.equal(r.kind, 'exit', JSON.stringify(r));
  assert.equal(r.code, 1);
  const all = r.stdout + r.stderr;
  assert.match(all, /express/);
  assert.match(all, /cd dashboard && npm install/);
  assert.doesNotMatch(all, /Password:|Dashboard ready|MODULE_NOT_FOUND|Cannot find module/);
});

test('refuses to start the server directly on a non-loopback bind with no credentials', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const sb = sandbox();
  const baseEnv = { ...process.env, ...sb.env, AIDR_HOST: '0.0.0.0', AIDR_PORT: String(await freePort()) };
  delete baseEnv.AIDR_USER; delete baseEnv.AIDR_PASS; delete baseEnv.AIDR_TOKEN;
  const child = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.js')], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const code = await new Promise(resolve => { const t2 = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 15000); child.on('exit', c => { clearTimeout(t2); resolve(c); }); });
  assert.equal(code, 1, out);
  assert.match(out, /refusing to listen on 0\.0\.0\.0 with no credentials/);
  assert.doesNotMatch(out, /listening on/);
});
