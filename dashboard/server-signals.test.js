/**
 * dashboard/server-signals.test.js
 *
 * DASH-9: stopping the dashboard (SIGTERM from systemd or `kill`, Ctrl-C) must
 * stop the watcher it started instead of orphaning it mid-submission.
 *
 * A driver process starts the real server (all paths in a temp dir, a stub
 * watcher that records the signal it receives); the test starts a run through
 * the HTTP API and signals the driver.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('u:password1').toString('base64'), Origin: `http://127.0.0.1:${port}` },
    }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`DASH-9: ${signal} to the dashboard is forwarded to a running watcher and the dashboard exits`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-signal-'));
    const pidFile = path.join(dir, 'child.pid');
    const markFile = path.join(dir, 'child.signal');
    fs.writeFileSync(path.join(dir, 'stub-watcher.js'), `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { fs.writeFileSync(${JSON.stringify(markFile)}, s); process.exit(0); });
      setInterval(() => {}, 1000);
    `);
    fs.writeFileSync(path.join(dir, 'driver.js'), `
      const { startServer } = require(${JSON.stringify(SERVER)});
      startServer({
        host: '127.0.0.1', port: 0, handleSignals: true, warn() {},
        env: { AIDR_USER: 'u', AIDR_PASS: 'password1', PATH: process.env.PATH },
        configPath: ${JSON.stringify(path.join(dir, 'config.json'))}, encPath: ${JSON.stringify(path.join(dir, 'config.json.enc'))},
        statePath: ${JSON.stringify(path.join(dir, 'state.json'))}, logsDir: ${JSON.stringify(path.join(dir, 'logs'))},
        authFile: ${JSON.stringify(path.join(dir, 'auth.json'))}, passphrase: '',
        watcherScript: ${JSON.stringify(path.join(dir, 'stub-watcher.js'))}, cwd: ${JSON.stringify(dir)},
      }).then(s => process.stdout.write('PORT ' + s.port + '\\n'));
    `);
    const driver = spawn(process.execPath, [path.join(dir, 'driver.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    driver.stdout.on('data', d => { out += d; });
    driver.stderr.on('data', d => { out += d; });
    const exited = new Promise(resolve => driver.on('exit', (code, sig) => resolve({ code, sig })));
    let watcherPid = null;
    try {
      assert.ok(await until(() => /PORT \d+/.test(out)), `driver did not start:\n${out}`);
      const port = Number(out.match(/PORT (\d+)/)[1]);
      const r = await post(port, '/api/run', { mode: 'preview' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(await until(() => fs.existsSync(pidFile)), 'the stub watcher started');
      watcherPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(alive(watcherPid));

      driver.kill(signal);
      const res = await Promise.race([exited, new Promise(r2 => setTimeout(() => r2('timeout'), 10000))]);
      assert.notEqual(res, 'timeout', 'the dashboard must exit after the signal');
      assert.equal(res.code, signal === 'SIGINT' ? 130 : 143, JSON.stringify(res));
      assert.equal(fs.readFileSync(markFile, 'utf8'), signal, 'the watcher received the forwarded signal');
      assert.ok(await until(() => !alive(watcherPid)), 'the watcher is gone, not orphaned');
    } finally {
      driver.kill('SIGKILL');
      if (watcherPid && alive(watcherPid)) process.kill(watcherPid, 'SIGKILL');
    }
  });
}

test('DASH-9: a signal with no run in progress just exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-signal-'));
  fs.writeFileSync(path.join(dir, 'driver.js'), `
    const { startServer } = require(${JSON.stringify(SERVER)});
    startServer({
      host: '127.0.0.1', port: 0, handleSignals: true, warn() {},
      env: { AIDR_USER: 'u', AIDR_PASS: 'password1' },
      configPath: ${JSON.stringify(path.join(dir, 'c.json'))}, encPath: ${JSON.stringify(path.join(dir, 'c.enc'))},
      statePath: ${JSON.stringify(path.join(dir, 's.json'))}, logsDir: ${JSON.stringify(path.join(dir, 'logs'))},
      authFile: ${JSON.stringify(path.join(dir, 'a.json'))}, passphrase: '',
    }).then(s => process.stdout.write('PORT ' + s.port + '\\n'));
  `);
  const driver = spawn(process.execPath, [path.join(dir, 'driver.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  driver.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => driver.on('exit', (code) => resolve(code)));
  try {
    assert.ok(await until(() => /PORT \d+/.test(out)));
    driver.kill('SIGTERM');
    assert.equal(await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 10000))]), 143);
  } finally {
    driver.kill('SIGKILL');
  }
});
