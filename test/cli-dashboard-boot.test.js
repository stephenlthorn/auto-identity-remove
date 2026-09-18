/**
 * test/cli-dashboard-boot.test.js
 *
 * The behavioural half of the PR #9 fix: actually run `aidr dashboard` and
 * require the server to come up. test/cli-bin-smoke.test.js deliberately
 * covered only the non-spawning paths (--help, --version, unknown command),
 * which is exactly why a subcommand that crashed with MODULE_NOT_FOUND on
 * every invocation shipped with a green suite.
 *
 * Boots on an ephemeral port bound to 127.0.0.1, with credentials supplied via
 * the environment so nothing is generated or written, and kills the child as
 * soon as it has listened.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'aidr.js');
const DASHBOARD_DEPS = path.join(ROOT, 'dashboard', 'node_modules', 'express');

/** An OS-assigned free port, so parallel test files cannot collide. */
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

test('aidr dashboard boots the server instead of dying on a doubled path', async (t) => {
  if (!fs.existsSync(DASHBOARD_DEPS)) {
    t.skip('dashboard dependencies are not installed (run: cd dashboard && npm ci)');
    return;
  }

  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'dashboard'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIDR_USER: 'test-user',
      AIDR_PASS: 'test-pass',
      AIDR_HOST: '127.0.0.1',
      AIDR_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // The dispatcher spawns server.js as a grandchild with inherited stdio, so
    // killing the dispatcher alone leaves the server running and holding the
    // pipe open. Own the whole process group and kill that.
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  const outcome = await new Promise(resolve => {
    const done = value => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(value);
    };
    const timer = setTimeout(() => done({ kind: 'timeout' }), 15000);
    const poll = setInterval(() => {
      if (stdout.includes('aidr-dashboard listening')) done({ kind: 'listening' });
    }, 50);
    child.on('exit', code => done({ kind: 'exit', code }));
    child.on('error', err => done({ kind: 'error', message: err.message }));
  });

  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }

  const combined = stdout + stderr;
  assert.ok(
    !/Cannot find module/.test(combined),
    `the dispatcher resolved a script that does not exist:\n${combined}`
  );
  assert.equal(
    outcome.kind,
    'listening',
    `expected the dashboard to listen, got ${JSON.stringify(outcome)}\n${combined}`
  );
  assert.match(stdout, new RegExp(`127\\.0\\.0\\.1:${port}`));
});
