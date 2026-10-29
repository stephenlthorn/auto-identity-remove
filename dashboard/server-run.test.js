/**
 * dashboard/server-run.test.js
 *
 * Run management and state writes: DASH-3 (mode type), DASH-6 (AIDR_STATE_PATH),
 * DASH-7 / codex #7 (freeze vs a live run or the state lock), DASH-9 (spawn
 * failure, child env, execPath, signals).
 *
 * Runs use a stub spawn (fakeChild) or a stub watcher script in a temp dir; the
 * real watcher.js is never started.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { startHarness, basicAuth, fakeChild } = require('./support/harness');
const { createApp } = require('./server');

async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

/** A spawn recorder that hands back controllable fake children. */
function stubbedSpawn() {
  const calls = [];
  const children = [];
  const spawn = (cmd, args, opts) => {
    const c = fakeChild({ pid: 1000 + children.length });
    calls.push({ cmd, args, opts });
    children.push(c);
    return c;
  };
  return { spawn, calls, children };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const runBody = (body) => ({ method: 'POST', pathname: '/api/run', body });

/** Minimal authenticated client for an app that was created outside the harness. */
function clientFor(server, user = 'testuser', pass = 'testpass') {
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (method, pathname, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', Authorization: basicAuth(user, pass), Origin: origin },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function listen(app) {
  const server = http.createServer(app.app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const stop = async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  };
  return { server, stop };
}

// ---- DASH-3 -------------------------------------------------------------------

test('DASH-3: {"mode":["real"]} is a 400 and nothing is spawned', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request }) => {
    const r = await request(runBody({ mode: ['real'] }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /mode must be a string/);
    assert.equal(s.calls.length, 0, 'a real run must not start');
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, false);
  });
});

// ---- DASH-9 -------------------------------------------------------------------

test('DASH-9: a NUL byte in --only is a 400, not a wedged dashboard', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request }) => {
    const r = await request(runBody({ mode: 'preview', only: 'a\u0000b' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /control character/);
    assert.equal(s.calls.length, 0);
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, false);
  });
});

test('DASH-9: a spawn() that throws leaves the dashboard usable', async () => {
  let attempts = 0;
  const good = stubbedSpawn();
  const spawn = (...a) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new TypeError('boom: argument contains null bytes'), { code: 'ERR_INVALID_ARG_VALUE' });
    return good.spawn(...a);
  };
  await withServer({ options: { spawn } }, async ({ request }) => {
    const r = await request(runBody({ mode: 'preview' }));
    assert.equal(r.status, 500);
    assert.match(r.json.error, /could not start/);
    const status = (await request({ pathname: '/api/run/status' })).json;
    assert.equal(status.running, false, 'run.running must not be left true');
    // ...and the next run starts normally instead of "a run is already in progress".
    const again = await request(runBody({ mode: 'preview' }));
    assert.equal(again.status, 200, JSON.stringify(again.json));
  });
});

test('DASH-9: runs are spawned with process.execPath, not a PATH lookup of "node"', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request }) => {
    await request(runBody({ mode: 'preview', only: 'Spokeo' }));
    assert.equal(s.calls[0].cmd, process.execPath);
    assert.deepEqual(s.calls[0].args, ['watcher.js', '--preview', '--only', 'Spokeo']);
  });
});

test('DASH-9: dashboard credentials never reach the child, the passphrase does', async () => {
  const s = stubbedSpawn();
  const env = { AIDR_TOKEN: 'tok-secret', AIDR_PASSPHRASE: 'pp', AIDR_PASSPHRASE_FILE: '/x/pp', PATH: '/usr/bin' };
  await withServer({ env, options: { spawn: s.spawn } }, async ({ request }) => {
    await request(runBody({ mode: 'preview' }));
    const childEnv = s.calls[0].opts.env;
    for (const k of ['AIDR_USER', 'AIDR_PASS', 'AIDR_TOKEN']) assert.equal(k in childEnv, false, `${k} must be stripped`);
    assert.equal(childEnv.AIDR_PASSPHRASE, 'pp', 'the run needs the passphrase to decrypt the config');
    assert.equal(childEnv.AIDR_PASSPHRASE_FILE, '/x/pp');
    assert.equal(childEnv.HEADLESS, '1');
    assert.equal(childEnv.CI, '1');
  });
});

test('DASH-9: the child is pointed at the same state and config files the dashboard shows', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request, paths }) => {
    await request(runBody({ mode: 'preview' }));
    const e = s.calls[0].opts.env;
    assert.equal(e.AIDR_STATE_PATH, paths.state);
    assert.equal(e.AIDR_CONFIG_PATH, paths.config);
    assert.equal(e.AIDR_CONFIG_ENC_PATH, paths.enc);
  });
});

test('DASH-9: a real child process gets the stripped environment and the right argv', async () => {
  // End to end with an actual process: a stub watcher that reports what it saw.
  const h = await startHarness({});
  try {
    const stub = path.join(h.paths.dir, 'stub-watcher.js');
    fs.writeFileSync(stub, `
      process.stdout.write('REPORT ' + JSON.stringify({
        argv: process.argv.slice(2),
        user: process.env.AIDR_USER || null,
        pass: process.env.AIDR_PASS || null,
        token: process.env.AIDR_TOKEN || null,
        passphrase: process.env.AIDR_PASSPHRASE || null,
      }) + '\\n');
    `);
    const app = createApp({
      statePath: h.paths.state, configPath: h.paths.config, encPath: h.paths.enc, logsDir: h.paths.logs, authFile: h.paths.auth,
      env: { AIDR_USER: 'testuser', AIDR_PASS: 'testpass', AIDR_TOKEN: 'tok-secret', AIDR_PASSPHRASE: 'pp', PATH: process.env.PATH },
      passphrase: '', watcherScript: stub, cwd: h.paths.dir, warn: () => {},
    });
    const { server, stop } = await listen(app);
    try {
      const call = clientFor(server);
      assert.equal((await call('POST', '/api/run', { mode: 'preview', only: 'Spokeo' })).status, 200);
      let status;
      for (let i = 0; i < 200; i++) {
        status = (await call('GET', '/api/run/status')).json;
        if (!status.running) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(status.running, false);
      assert.equal(status.exitCode, 0);
      const stream = await new Promise((resolve) => {
        const req = http.get({
          hostname: '127.0.0.1', port: server.address().port, path: '/api/run/stream',
          headers: { Authorization: basicAuth('testuser', 'testpass') },
        }, res => {
          let d = '';
          res.on('data', c => { d += c; if (d.includes('event: end')) { req.destroy(); resolve(d); } });
        });
      });
      const reportLine = stream.split('\n').map(l => l.replace(/^data: /, '')).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean).map(e => e.line).find(l => l.startsWith('REPORT '));
      assert.ok(reportLine, `no REPORT line in the stream:\n${stream}`);
      const report = JSON.parse(reportLine.slice('REPORT '.length));
      assert.deepEqual(report.argv, ['--preview', '--only', 'Spokeo']);
      assert.equal(report.user, null);
      assert.equal(report.pass, null);
      assert.equal(report.token, null);
      assert.equal(report.passphrase, 'pp');
    } finally {
      await stop();
    }
  } finally {
    await h.close();
  }
});

test('DASH-9: stop sends SIGTERM and a signal-killed run ends cleanly', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request }) => {
    await request(runBody({ mode: 'preview' }));
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, true);
    const stop = await request({ method: 'POST', pathname: '/api/run/stop' });
    assert.equal(stop.status, 200);
    assert.deepEqual(s.children[0].killed, ['SIGTERM']);
    s.children[0].exit(null, 'SIGTERM');
    const status = (await request({ pathname: '/api/run/status' })).json;
    assert.equal(status.running, false);
    assert.equal(status.exitCode, -1);
  });
});

test('DASH-9: terminateRun escalates to SIGKILL when the child ignores SIGTERM', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request, instance }) => {
    await request(runBody({ mode: 'preview' }));
    const done = instance.terminateRun('SIGTERM', { graceMs: 30 });
    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(s.children[0].killed, ['SIGTERM', 'SIGKILL']);
    s.children[0].exit(null, 'SIGKILL');
    assert.equal(await done, true);
  });
});

test('DASH-9: terminateRun with nothing running resolves false immediately', async () => {
  await withServer({}, async ({ instance }) => {
    assert.equal(await instance.terminateRun('SIGTERM'), false);
  });
});

test('a stale close from an old child cannot end the run that replaced it', async () => {
  const s = stubbedSpawn();
  await withServer({ options: { spawn: s.spawn } }, async ({ request }) => {
    await request(runBody({ mode: 'preview' }));
    s.children[0].emit('error', new Error('spawn ENOENT'));   // finalizes run 1
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, false);
    await request(runBody({ mode: 'preview' }));              // run 2 starts
    s.children[0].exit(1);                                    // old child's late close
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, true, 'run 2 must still be running');
    s.children[1].exit(0);
    assert.equal((await request({ pathname: '/api/run/status' })).json.running, false);
  });
});

// ---- DASH-6 -------------------------------------------------------------------

test('DASH-6: AIDR_STATE_PATH decides which state file the dashboard reads and writes', async () => {
  const h = await startHarness({});
  try {
    const custom = path.join(h.paths.dir, 'elsewhere.json');
    fs.writeFileSync(custom, JSON.stringify({ optOuts: { Spokeo: { history: ['success'] } } }));
    const app = createApp({
      configPath: h.paths.config, encPath: h.paths.enc, logsDir: h.paths.logs, authFile: h.paths.auth,
      env: { AIDR_USER: 'testuser', AIDR_PASS: 'testpass', AIDR_STATE_PATH: custom },
      brokers: [{ name: 'Spokeo', method: 'search-form' }], warn: () => {},
    });
    const { server, stop } = await listen(app);
    try {
      const call = clientFor(server);
      assert.equal((await call('GET', '/api/summary')).json.optedOut, 1, 'summary must read the AIDR_STATE_PATH file');
      assert.equal((await call('POST', '/api/freeze', { key: 'equifax', action: 'done' })).status, 200);
      assert.ok(readJson(custom).freezes.equifax, 'freeze must be written to the configured state file');
      assert.equal(readJson(custom).optOuts.Spokeo.history[0], 'success');
      assert.equal(fs.existsSync(h.paths.state), false, 'no second state.json may be created next to the config');
    } finally {
      await stop();
    }
  } finally {
    await h.close();
  }
});

// ---- DASH-7 / codex #7 ----------------------------------------------------------

test('DASH-7: a freeze POST during a run is a 409 and state.json is untouched', async () => {
  const s = stubbedSpawn();
  const stateContent = { optOuts: { Spokeo: { history: ['success'] } } };
  await withServer({ stateContent, options: { spawn: s.spawn } }, async ({ request, paths }) => {
    await request(runBody({ mode: 'preview' }));
    const before = fs.readFileSync(paths.state);
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'state_busy');
    assert.ok(fs.readFileSync(paths.state).equals(before));
    // Once the run ends the same request works.
    s.children[0].exit(0);
    const ok = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

test('DASH-7: a freeze POST while a watcher holds the state lock is a 409', async () => {
  // A watcher started from the CLI or a scheduler: not our child, but it holds
  // state.json.lock with its live pid and will rewrite state.json on its own save.
  await withServer({ stateContent: { optOuts: {} } }, async ({ request, paths }) => {
    fs.writeFileSync(paths.state + '.lock', JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    const before = fs.readFileSync(paths.state);
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(r.status, 409);
    assert.ok(fs.readFileSync(paths.state).equals(before));
    assert.ok(fs.existsSync(paths.state + '.lock'), "the holder's lock is not ours to remove");
  });
});

test('DASH-7: a stale lock (dead pid) does not block, and the lock is released afterwards', async () => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // exited: no longer alive
  await withServer({ stateContent: { optOuts: {} } }, async ({ request, paths }) => {
    fs.writeFileSync(paths.state + '.lock', JSON.stringify({ pid: dead, ts: new Date().toISOString() }));
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'innovis', action: 'done' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.existsSync(paths.state + '.lock'), false);
  });
});

test('DASH-7: a normal freeze leaves no lock file behind', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request, paths }) => {
    assert.equal((await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } })).status, 200);
    assert.equal(fs.existsSync(paths.state + '.lock'), false);
  });
});

test('DASH-7: an unparseable state.json is a 409 and is left alone', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.writeFileSync(paths.state, '{"optOuts":');
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(paths.state, 'utf8'), '{"optOuts":');
    assert.equal(fs.existsSync(paths.state + '.lock'), false);
  });
});

test('freeze on a fresh install creates state.json with 0600', async () => {
  await withServer({}, async ({ request, paths }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.statSync(paths.state).mode & 0o777, 0o600);
  });
});
