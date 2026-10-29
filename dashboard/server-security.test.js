/**
 * dashboard/server-security.test.js
 *
 * DASH-8 (auth before body parsing, JSON errors), DASH-11 (calendar preset),
 * DASH-13 (Host allow-list, unsafe bind), DASH-15 (username, rate limit, async
 * scrypt) and the security headers.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { startHarness, basicAuth } = require('./support/harness');
const { startServer } = require('./server');

async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

// ---- DASH-8 -------------------------------------------------------------------

test('DASH-8: an unauthenticated malformed POST is a plain 401, not an HTML stack trace', async () => {
  await withServer({}, async ({ rawRequest }) => {
    const r = await rawRequest({ method: 'POST', pathname: '/api/run', rawBody: '{bad' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'unauthorized' });
    assert.doesNotMatch(r.raw, /node_modules|SyntaxError|<pre>|at /);
  });
});

test('DASH-8: an unauthenticated oversized body is refused before it is parsed', async () => {
  await withServer({}, async ({ rawRequest }) => {
    const r = await rawRequest({ method: 'PUT', pathname: '/api/config', rawBody: '{"x":"' + 'a'.repeat(600 * 1024) + '"}' });
    assert.equal(r.status, 401, 'auth must run before express.json');
  });
});

test('DASH-8: an authenticated malformed body is a JSON 400 with no stack or path', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ method: 'POST', pathname: '/api/run', rawBody: '{bad' });
    assert.equal(r.status, 400);
    assert.equal(typeof r.json.error, 'string');
    assert.doesNotMatch(r.raw, /node_modules|SyntaxError|<pre>|at |\/Users\/|\/home\//);
  });
});

test('DASH-8: an authenticated oversized body is a JSON 413', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ method: 'PUT', pathname: '/api/config', rawBody: '{"x":"' + 'a'.repeat(600 * 1024) + '"}' });
    assert.equal(r.status, 413);
    assert.equal(typeof r.json.error, 'string');
  });
});

test('DASH-8: unknown API routes are a JSON 404 and the server does not advertise express', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ pathname: '/api/nope' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not found' });
    assert.equal(r.headers['x-powered-by'], undefined);
  });
});

test('an unexpected handler error is a JSON 500 that does not leak the message to the client', async () => {
  const bad = { name: 'x', get method() { throw new Error('secret path /srv/aidr/brokers.js exploded'); } };
  await withServer({ options: { brokers: [bad] } }, async ({ request }) => {
    const r = await request({ pathname: '/api/summary' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal error' });
  });
});

// ---- security headers ---------------------------------------------------------

test('every response carries CSP, nosniff and no-referrer; /api is no-store', async () => {
  await withServer({}, async ({ request }) => {
    for (const r of [
      await request({ pathname: '/api/version' }),
      await request({ pathname: '/api/health', noAuth: true }),
      await request({ pathname: '/api/version', noAuth: true }), // the 401
      await request({ pathname: '/api/nope' }),
      await request({ pathname: '/index.html' }),
    ]) {
      assert.equal(r.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'");
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['x-frame-options'], 'DENY');
    }
    for (const p of ['/api/version', '/api/config', '/api/health', '/api/run/status']) {
      const r = await request({ pathname: p, noAuth: p === '/api/health' });
      assert.equal(r.headers['cache-control'], 'no-store', p);
    }
    assert.notEqual((await request({ pathname: '/index.html' })).headers['cache-control'], 'no-store', 'static assets may be cached');
  });
});

// ---- DASH-11 ------------------------------------------------------------------

test('DASH-11: prototype names are not calendar presets', async () => {
  await withServer({}, async ({ request }) => {
    for (const preset of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = await request({ method: 'POST', pathname: '/api/schedule', body: { action: 'preset', preset } });
      assert.equal(r.status, 400, `${preset} must be rejected`);
      assert.deepEqual(r.json, { error: 'bad action' });
    }
    assert.equal((await request({ method: 'POST', pathname: '/api/schedule', body: { action: 'preset', preset: ['daily'] } })).status, 400);
  });
});

// ---- DASH-13 ------------------------------------------------------------------

test('DASH-13: a foreign Host header is a 403 (DNS rebinding), even for health', async () => {
  await withServer({}, async ({ request }) => {
    for (const host of ['evil.example', 'evil.example:8080', '192.168.1.5', 'localhost.evil.com']) {
      const r = await request({ pathname: '/api/version', headers: { Host: host } });
      assert.equal(r.status, 403, host);
      assert.match(r.json.error, /host not allowed/);
      const h = await request({ pathname: '/api/health', noAuth: true, headers: { Host: host } });
      assert.equal(h.status, 403, `health on ${host}`);
    }
  });
});

test('DASH-13: loopback Host names work, with or without a port', async () => {
  await withServer({}, async ({ request, server }) => {
    for (const host of [`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`, 'localhost', `[::1]:${server.address().port}`]) {
      const r = await request({ pathname: '/api/version', headers: { Host: host } });
      assert.equal(r.status, 200, host);
    }
  });
});

test('DASH-13: AIDR_ALLOWED_HOSTS admits a named host', async () => {
  await withServer({ env: { AIDR_ALLOWED_HOSTS: 'nas.lan, aidr.example.com' } }, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/version', headers: { Host: 'nas.lan:8080' } })).status, 200);
    assert.equal((await request({ pathname: '/api/version', headers: { Host: 'aidr.example.com' } })).status, 200);
    assert.equal((await request({ pathname: '/api/version', headers: { Host: 'other.lan' } })).status, 403);
  });
});

test('DASH-13: the dashboard refuses to start on a non-loopback bind with no credentials', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aidr-bind-'));
  await assert.rejects(
    startServer({ host: '0.0.0.0', port: 0, env: {}, authFile: path.join(dir, 'auth.json'), configPath: path.join(dir, 'c.json'),
      encPath: path.join(dir, 'c.enc'), statePath: path.join(dir, 's.json'), logsDir: path.join(dir, 'logs'), warn: () => {} }),
    err => err.code === 'AIDR_UNSAFE_BIND' && /AIDR_USER/.test(err.message),
  );
});

test('startServer binds, and port 0 resolves to the real ephemeral port', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aidr-bind-'));
  const s = await startServer({ host: '127.0.0.1', port: 0, env: { AIDR_USER: 'u', AIDR_PASS: 'password1' }, authFile: path.join(dir, 'auth.json'),
    configPath: path.join(dir, 'c.json'), encPath: path.join(dir, 'c.enc'), statePath: path.join(dir, 's.json'), logsDir: path.join(dir, 'logs'), warn: () => {} });
  try {
    assert.ok(s.port > 0, 'port 0 resolves to the real ephemeral port');
    assert.equal(s.host, '127.0.0.1');
  } finally {
    await s.instance.close();
    s.server.closeAllConnections();
    await new Promise(r => s.server.close(r));
  }
});

test('DASH-12: a port that is already in use is a readable error, not a crash', async () => {
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aidr-bind-'));
  try {
    await assert.rejects(
      startServer({ host: '127.0.0.1', port, env: { AIDR_USER: 'u', AIDR_PASS: 'password1' }, authFile: path.join(dir, 'auth.json'),
        configPath: path.join(dir, 'c.json'), encPath: path.join(dir, 'c.enc'), statePath: path.join(dir, 's.json'), logsDir: path.join(dir, 'logs'), warn: () => {} }),
      err => err.code === 'EADDRINUSE' && /already in use/.test(err.message) && /AIDR_PORT/.test(err.message),
    );
  } finally {
    await new Promise(r => blocker.close(r));
  }
});

// ---- DASH-15 ------------------------------------------------------------------

test('DASH-15: a new username containing ":" or a control character is rejected', async () => {
  await withServer({}, async ({ request, paths }) => {
    for (const newUsername of ['a:b', 'a\u0000b', 'a\nb']) {
      const r = await request({ method: 'POST', pathname: '/api/auth/password', body: { currentPassword: 'testpass', newPassword: 'newpass1', newUsername } });
      assert.equal(r.status, 400, JSON.stringify(newUsername));
    }
    assert.equal(fs.existsSync(paths.auth), false, 'nothing may be saved for a rejected username');
  });
});

test('DASH-15: a password change round-trips: the new login works, the old one stops', async () => {
  await withServer({}, async ({ request, rawRequest, paths }) => {
    const r = await request({ method: 'POST', pathname: '/api/auth/password', body: { currentPassword: 'testpass', newPassword: 'newpass1', newUsername: 'alice' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user, 'alice');
    assert.equal(fs.statSync(paths.auth).mode & 0o777, 0o600);
    const good = await rawRequest({ pathname: '/api/whoami-nope', headers: { Authorization: basicAuth('alice', 'newpass1') } });
    assert.notEqual(good.status, 401);
    const me = await rawRequest({ pathname: '/api/auth/whoami', headers: { Authorization: basicAuth('alice', 'newpass1') } });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, { user: 'alice', source: 'file' });
    const old = await rawRequest({ pathname: '/api/auth/whoami', headers: { Authorization: basicAuth('testuser', 'testpass') } });
    assert.equal(old.status, 401);
  });
});

test('DASH-15: a wrong current password is still a 403', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ method: 'POST', pathname: '/api/auth/password', body: { currentPassword: 'nope', newPassword: 'newpass1' } });
    assert.equal(r.status, 403);
  });
});

test('DASH-15: failed logins are rate limited per address (429 + Retry-After), without further hashing', async () => {
  await withServer({ options: { authFailLimit: 3, authFailWindowMs: 60000 } }, async ({ rawRequest }) => {
    const bad = { Authorization: basicAuth('testuser', 'wrong') };
    for (let i = 0; i < 3; i++) assert.equal((await rawRequest({ pathname: '/api/version', headers: bad })).status, 401);
    const limited = await rawRequest({ pathname: '/api/version', headers: bad });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    // Even the right password waits out the window; that is the point of a lockout.
    const right = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('testuser', 'testpass') } });
    assert.equal(right.status, 429);
    // The unauthenticated health probe is unaffected.
    assert.equal((await rawRequest({ pathname: '/api/health' })).status, 200);
  });
});

test('DASH-15: requests with no credentials do not count as failed logins', async () => {
  // A browser's first request has no Authorization header; it is not a guess.
  await withServer({ options: { authFailLimit: 3 } }, async ({ rawRequest }) => {
    for (let i = 0; i < 8; i++) assert.equal((await rawRequest({ pathname: '/api/version' })).status, 401);
    const ok = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('testuser', 'testpass') } });
    assert.equal(ok.status, 200);
  });
});

test('DASH-15: a good login clears the failure count', async () => {
  await withServer({ options: { authFailLimit: 3 } }, async ({ rawRequest }) => {
    const bad = { Authorization: basicAuth('testuser', 'wrong') };
    const good = { Authorization: basicAuth('testuser', 'testpass') };
    await rawRequest({ pathname: '/api/version', headers: bad });
    await rawRequest({ pathname: '/api/version', headers: bad });
    assert.equal((await rawRequest({ pathname: '/api/version', headers: good })).status, 200);
    await rawRequest({ pathname: '/api/version', headers: bad });
    await rawRequest({ pathname: '/api/version', headers: bad });
    assert.equal((await rawRequest({ pathname: '/api/version', headers: good })).status, 200, 'count restarted after the good login');
  });
});

test('DASH-15: a bad login against a saved credential never calls scryptSync (no event-loop blocking)', async () => {
  await withServer({}, async ({ request, rawRequest }) => {
    // Move to a file credential so verification takes the scrypt path.
    await request({ method: 'POST', pathname: '/api/auth/password', body: { currentPassword: 'testpass', newPassword: 'newpass1' } });
    const real = crypto.scryptSync;
    crypto.scryptSync = () => { throw new Error('scryptSync blocks the event loop'); };
    try {
      const bad = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('testuser', 'nope') } });
      assert.equal(bad.status, 401);
      const good = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('testuser', 'newpass1') } });
      assert.equal(good.status, 200);
    } finally {
      crypto.scryptSync = real;
    }
  });
});

test('DASH-15: existing .auth.json files written by the old sync hash still verify', async () => {
  await withServer({}, async ({ rawRequest, paths }) => {
    const salt = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(paths.auth, JSON.stringify({ user: 'legacy', salt, hash: crypto.scryptSync('oldpass1', salt, 64).toString('hex') }));
    const ok = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('legacy', 'oldpass1') } });
    assert.equal(ok.status, 200);
  });
});

test('a token credential still works and counts failures too', async () => {
  await withServer({ noAuth: true, env: { AIDR_TOKEN: 'tok-123' }, options: { authFailLimit: 2 } }, async ({ rawRequest }) => {
    assert.equal((await rawRequest({ pathname: '/api/version', headers: { 'X-AIDR-Token': 'tok-123' } })).status, 200);
    assert.equal((await rawRequest({ pathname: '/api/version', headers: { 'X-AIDR-Token': 'bad' } })).status, 401);
    assert.equal((await rawRequest({ pathname: '/api/version', headers: { 'X-AIDR-Token': 'bad' } })).status, 401);
    assert.equal((await rawRequest({ pathname: '/api/version', headers: { 'X-AIDR-Token': 'bad' } })).status, 429);
  });
});
