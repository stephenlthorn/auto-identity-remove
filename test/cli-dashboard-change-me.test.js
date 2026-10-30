/**
 * test/cli-dashboard-change-me.test.js
 *
 * CFG2-1 follow-up: the dashboard server refuses AIDR_PASS=change-me (the old
 * example value), so `aidr dashboard` must not count it as credentials "already in
 * the environment". It used to print "use AIDR_USER / AIDR_PASS from your
 * environment" and hand the person a login that answers 401 forever.
 *
 * With the placeholder in the environment the dispatcher now behaves as if no
 * password was set: it generates a login, and the one it prints really works.
 *
 * Real server on an ephemeral 127.0.0.1 port in its own process group; config,
 * state and the saved-credentials file are redirected to a temp dir.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
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

function status(port, auth) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` };
    http.get({ hostname: '127.0.0.1', port, path: '/api/version', headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function runDashboard(env) {
  const child = spawn(process.execPath, [BIN, 'dashboard'], {
    cwd: ROOT,
    env: { ...process.env, AIDR_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* gone */ } } };
  const finished = new Promise(resolve => {
    const done = kind => { clearTimeout(timer); clearInterval(poll); resolve({ kind, stdout, stderr }); };
    const timer = setTimeout(() => done('timeout'), 20000);
    const poll = setInterval(() => { if (/Password:\s+\S+/.test(stdout) || /Login:/.test(stdout)) done('until'); }, 50);
    child.on('exit', () => done('exit'));
  });
  return { kill, finished };
}

test('AIDR_PASS=change-me is treated as unset: a login is generated and it works', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-cli-changeme-'));
  const port = await freePort();
  const run = runDashboard({
    AIDR_STATE_PATH: path.join(dir, 'state.json'),
    AIDR_CONFIG_PATH: path.join(dir, 'config.json'),
    AIDR_CONFIG_ENC_PATH: path.join(dir, 'config.json.enc'),
    AIDR_AUTH_FILE: path.join(dir, 'auth.json'),
    AIDR_USER: 'admin',
    AIDR_PASS: 'change-me',
    AIDR_PORT: String(port),
  });
  const r = await run.finished;
  try {
    assert.equal(r.kind, 'until', JSON.stringify(r));
    assert.match(r.stdout, /Password:\s+\S+/, 'a login is generated instead of trusting the placeholder');
    assert.doesNotMatch(r.stdout, /from your environment/, 'the placeholder is not "credentials from your environment"');
    const pass = r.stdout.match(/Password:\s+(\S+)/)[1];
    const user = r.stdout.match(/Username:\s+(\S+)/)[1];
    assert.notEqual(pass, 'change-me');
    assert.equal(await status(port, `${user}:${pass}`), 200, 'the printed login must work');
    assert.equal(await status(port, `${user}:change-me`), 401, 'the placeholder never logs in');
  } finally {
    run.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real AIDR_PASS from the environment is still used and nothing is generated', async (t) => {
  if (!HAS_EXPRESS) return t.skip('dashboard dependencies are not installed (cd dashboard && npm ci)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-cli-envpass-'));
  const port = await freePort();
  const run = runDashboard({
    AIDR_STATE_PATH: path.join(dir, 'state.json'),
    AIDR_CONFIG_PATH: path.join(dir, 'config.json'),
    AIDR_CONFIG_ENC_PATH: path.join(dir, 'config.json.enc'),
    AIDR_AUTH_FILE: path.join(dir, 'auth.json'),
    AIDR_USER: 'owner',
    AIDR_PASS: 'a-real-password-1234',
    AIDR_PORT: String(port),
  });
  const r = await run.finished;
  try {
    assert.equal(r.kind, 'until', JSON.stringify(r));
    assert.doesNotMatch(r.stdout, /Password:/);
    assert.match(r.stdout, /from your environment/);
    assert.equal(await status(port, 'owner:a-real-password-1234'), 200);
  } finally {
    run.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
