/**
 * dashboard/server-auth-required.test.js
 *
 * codex round 2 #1: the default loopback dashboard had no authentication, so any
 * other local account could read the identity data and start real runs. Credentials
 * are now required everywhere. The only way to run without them is the explicit
 * AIDR_DASHBOARD_NO_AUTH=1, for tests and local development, and it never applies to
 * a non-loopback bind.
 *
 * CFG2-4: deleting dashboard/.auth.json (which the corrupt-file 409 tells operators
 * to do) while the server was running used to open every route. Auth that was
 * required when the server started stays required.
 *
 * CFG2-3 is in validate.test.js; the relay-alias and log redactions, the in-place
 * envelope write-back and the config decrypt cache are below.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHarness, basicAuth } = require('./support/harness');
const { startServer } = require('./server');
const secrets = require('../lib/secrets');

async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const NO_AUTH = 'AIDR_DASHBOARD_NO_AUTH';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-auth-req-'));
const serverOpts = (dir, extra = {}) => ({
  host: '127.0.0.1', port: 0, authFile: path.join(dir, 'auth.json'), configPath: path.join(dir, 'c.json'),
  encPath: path.join(dir, 'c.enc'), statePath: path.join(dir, 's.json'), logsDir: path.join(dir, 'logs'), warn: () => {}, ...extra,
});
async function stop(s) {
  await s.instance.close();
  s.server.closeAllConnections();
  await new Promise(r => s.server.close(r));
}

// ---- no credentials: closed by default ------------------------------------------

test('codex #1: with no credentials configured every route but /api/health is a 401, even from loopback', async () => {
  await withServer({ noAuth: true }, async ({ request, instance }) => {
    assert.equal(instance.openMode, false);
    for (const p of ['/api/config', '/api/state', '/api/summary', '/api/logs', '/api/auth/whoami']) {
      const r = await request({ pathname: p, noAuth: true });
      assert.equal(r.status, 401, p);
      assert.match(r.headers['www-authenticate'], /Basic/);
    }
    const run = await request({ method: 'POST', pathname: '/api/run', body: { mode: 'real', confirm: true }, noAuth: true });
    assert.equal(run.status, 401, 'a run cannot be started without logging in');
    assert.equal((await request({ pathname: '/api/health', noAuth: true })).status, 200);
  });
});

test('codex #1: the explicit opt-out opens a loopback dashboard, and says so', async () => {
  await withServer({ noAuth: true, env: { [NO_AUTH]: '1' } }, async ({ request, instance }) => {
    assert.equal(instance.openMode, true);
    assert.equal((await request({ pathname: '/api/config', noAuth: true })).status, 200);
  });
});

test('codex #1: only the literal 1 opts out', async () => {
  for (const value of ['0', 'true', 'yes', '']) {
    await withServer({ noAuth: true, env: { [NO_AUTH]: value } }, async ({ request, instance }) => {
      assert.equal(instance.openMode, false, JSON.stringify(value));
      assert.equal((await request({ pathname: '/api/config', noAuth: true })).status, 401);
    });
  }
});

test('codex #1: startServer refuses a loopback bind with no credentials and says how to fix it', async () => {
  const dir = tmp();
  await assert.rejects(
    startServer(serverOpts(dir, { env: {} })),
    err => err.code === 'AIDR_NO_CREDENTIALS' && /AIDR_USER/.test(err.message) && /aidr dashboard/.test(err.message) &&
      /refusing to listen on 127\.0\.0\.1 with no credentials/.test(err.message),
  );
});

test('codex #1: startServer on loopback starts with credentials, a token, a saved login or the opt-out', async () => {
  for (const [label, env, prepare] of [
    ['env credentials', { AIDR_USER: 'u', AIDR_PASS: 'password1' }],
    ['a token', { AIDR_TOKEN: 'tok-1' }],
    ['a saved login', {}, (dir) => fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: 'u', salt: 'ab', hash: 'cd' }))],
    ['the opt-out', { [NO_AUTH]: '1' }],
  ]) {
    const dir = tmp();
    if (prepare) prepare(dir);
    const s = await startServer(serverOpts(dir, { env }));
    try { assert.ok(s.port > 0, label); } finally { await stop(s); }
  }
});

test('codex #1: the opt-out never opens a non-loopback bind', async () => {
  const dir = tmp();
  await assert.rejects(
    startServer(serverOpts(dir, { host: '0.0.0.0', env: { [NO_AUTH]: '1' } })),
    err => err.code === 'AIDR_UNSAFE_BIND' && /refusing to listen on 0\.0\.0\.0 with no credentials/.test(err.message),
  );
});

// ---- CFG2-4: auth required at start stays required --------------------------------

function savedLogin(dir, user, pw) {
  const salt = 'ab'.repeat(8);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user, salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }));
}

test('CFG2-4: deleting the saved login while the server runs does not open it', async () => {
  const dir = tmp();
  savedLogin(dir, 'admin', 's3cretpw');
  const s = await startServer(serverOpts(dir, { env: {} }));
  const get = (headers = {}) => fetch(`http://127.0.0.1:${s.port}/api/config`, { headers });
  try {
    assert.equal((await get()).status, 401);
    assert.equal((await get({ authorization: basicAuth('admin', 's3cretpw') })).status, 200);
    fs.unlinkSync(path.join(dir, 'auth.json'));
    assert.equal((await get()).status, 401, 'the unauthenticated request must still be refused');
    assert.equal((await get({ authorization: basicAuth('admin', 's3cretpw') })).status, 401, 'and nobody can log in until credentials are provided again');
  } finally {
    await stop(s);
  }
});

test('CFG2-4: even with the opt-out set, a login that existed at start-up stays required', async () => {
  const dir = tmp();
  savedLogin(dir, 'admin', 's3cretpw');
  const s = await startServer(serverOpts(dir, { env: { [NO_AUTH]: '1' } }));
  try {
    assert.equal(s.instance.openMode, false, 'credentials exist, so the opt-out has nothing to open');
    fs.unlinkSync(path.join(dir, 'auth.json'));
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/config`)).status, 401);
  } finally {
    await stop(s);
  }
});

test('CFG2-4: env credentials still work when the saved login is removed (they were the bootstrap)', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.writeFileSync(paths.auth, JSON.stringify({ user: 'x', salt: 'ab', hash: 'cd' }));
    assert.equal((await request({ pathname: '/api/config' })).status, 401, 'the saved login overrides env credentials');
    fs.unlinkSync(paths.auth);
    assert.equal((await request({ pathname: '/api/config' })).status, 200, 'the env credentials apply again');
    assert.equal((await request({ pathname: '/api/config', noAuth: true })).status, 401);
  });
});

// ---- the shipped example password -------------------------------------------------

test('the example service password is not a usable credential', async () => {
  const warnings = [];
  await withServer({ noAuth: true, env: { AIDR_USER: 'admin', AIDR_PASS: 'change-me' }, options: { warn: (m) => warnings.push(m) } }, async ({ request, rawRequest }) => {
    assert.ok(warnings.some(w => /change-me/.test(w)), 'says why the credentials were ignored');
    assert.equal((await rawRequest({ pathname: '/api/config', headers: { Authorization: basicAuth('admin', 'change-me') } })).status, 401);
    assert.equal((await request({ pathname: '/api/config', noAuth: true })).status, 401);
  });
  const dir = tmp();
  await assert.rejects(startServer(serverOpts(dir, { env: { AIDR_USER: 'admin', AIDR_PASS: 'change-me' } })), err => err.code === 'AIDR_NO_CREDENTIALS');
});

test('the example service file does not ship that password', () => {
  const unit = fs.readFileSync(path.join(__dirname, 'examples', 'aidr-dashboard.service'), 'utf8');
  assert.doesNotMatch(unit, /^Environment=AIDR_PASS=change-me/m);
  assert.match(unit, /EnvironmentFile=|AIDR_PASS/, 'still tells the operator where the password goes');
});

// ---- redaction next to the History routes -----------------------------------------

test('GET /api/state does not return the relay aliases or URLs with query strings', async () => {
  const state = {
    relayAliases: { 'ann@example.test': 'ann.alias123@simplelogin.com' },
    optOuts: {
      Spokeo: {
        history: ['success'],
        lastDetail: 'submitted https://www.spokeo.com/optout?email=ann%40example.test&zip=12345 ok',
        pendingConfirm: { since: '2026-10-01T00:00:00.000Z', snippet: 'confirm at https://x.example/c?token=SECRET' },
      },
    },
  };
  await withServer({ stateContent: state }, async ({ request }) => {
    const r = await request({ pathname: '/api/state' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.raw, /ann@example\.test|alias123|SECRET|zip=12345|simplelogin/);
    assert.equal(r.json.optOuts.Spokeo.history[0], 'success', 'the rest of the state is intact');
    assert.match(r.json.optOuts.Spokeo.lastDetail, /www\.spokeo\.com/);
    assert.equal(r.json.relayAliases.count, 1);
  });
});

test('GET /api/logs/:name reduces URLs to their host, like the History routes', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.writeFileSync(path.join(paths.logs, 'run-2026-10-29T03-30-00.json'), JSON.stringify({
      runAt: '2026-10-29T03:30:00.000Z',
      succeeded: [{ broker: 'Spokeo', status: 'success', detail: 'opened https://www.spokeo.com/optout?email=ann%40example.test&zip=12345' }],
    }, null, 2));
    fs.writeFileSync(path.join(paths.logs, 'run.log'), 'visiting https://example.org/a/b?name=Ann+Probe\nsecond line\n');
    const json = await request({ pathname: '/api/logs/run-2026-10-29T03-30-00.json' });
    assert.equal(json.status, 200);
    assert.doesNotMatch(json.raw, /ann%40example|zip=12345|optout\?/);
    assert.match(json.raw, /www\.spokeo\.com/);
    assert.ok(JSON.parse(json.raw).succeeded[0], 'still valid JSON');
    const text = await request({ pathname: '/api/logs/run.log' });
    assert.equal(text.status, 200);
    assert.doesNotMatch(text.raw, /name=Ann/);
    assert.match(text.raw, /example\.org\nsecond line/, 'line structure is kept');
  });
});

// ---- CFG2-10: the file the config was read from is the file written ---------------

test('CFG2-10: a PUT on an in-place envelope rewrites config.json and creates no .enc beside it', async () => {
  const cfg = { person: { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' } };
  await withServer({ passphrase: 'pw-b' }, async ({ request, paths }) => {
    fs.writeFileSync(paths.config, JSON.stringify(secrets.encryptConfig(cfg, 'pw-b')));
    const r = await request({ method: 'PUT', pathname: '/api/config', body: { config: { person: { city: 'Dallas' } } } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(fs.existsSync(paths.enc), false, 'no second encrypted file');
    const inPlace = secrets.decryptConfig(JSON.parse(fs.readFileSync(paths.config, 'utf8')), 'pw-b');
    assert.equal(inPlace.person.city, 'Dallas', 'config.json is the file the next run reads');
    assert.equal(inPlace.person.firstName, 'Ann');
    const after = await request({ pathname: '/api/config' });
    assert.equal(after.json.config.person.city, 'Dallas');
  });
});

// ---- CFG2-11: one scrypt per config change, not per request -----------------------

test('CFG2-11: consecutive reads of an encrypted config derive the key once', async () => {
  const enc = secrets.encryptConfig({ person: { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' } }, 'pw');
  await withServer({ encContent: enc, passphrase: 'pw', options: { brokers: [] } }, async ({ request }) => {
    const real = crypto.scryptSync;
    let calls = 0;
    crypto.scryptSync = (...a) => { calls += 1; return real(...a); };
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await request({ pathname: '/api/config' })).json.config.person.firstName, 'Ann');
      assert.equal((await request({ pathname: '/api/summary' })).json.configured, true);
      assert.equal(calls, 1, `scrypt ran ${calls} times`);
    } finally {
      crypto.scryptSync = real;
    }
  });
});

test('CFG2-11: a changed config file is read again', async () => {
  const enc1 = secrets.encryptConfig({ person: { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' } }, 'pw');
  const enc2 = secrets.encryptConfig({ person: { firstName: 'Bea', lastName: 'Probe', email: 'bea@example.test', zip: '12345' } }, 'pw');
  await withServer({ encContent: enc1, passphrase: 'pw', options: { brokers: [] } }, async ({ request, paths }) => {
    assert.equal((await request({ pathname: '/api/config' })).json.config.person.firstName, 'Ann');
    fs.writeFileSync(paths.enc, JSON.stringify(enc2));
    assert.equal((await request({ pathname: '/api/config' })).json.config.person.firstName, 'Bea');
  });
});
