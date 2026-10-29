/**
 * dashboard/server.test.js
 *
 * Hermetic endpoint tests for the dashboard server. Each test starts a real
 * express app on an ephemeral port against its OWN temp directory (see
 * support/harness.js): config, config.json.enc, state, logs and .auth.json all
 * live there, so no real repo-root file is ever read-modified-restored. This
 * file used to overwrite the real config.json / state.json / config.json.enc and
 * put them back in a finally block; a Ctrl-C mid-test left fixtures in place of
 * a maintainer's real PII. support/fs-guard.js now makes such a write throw.
 *
 * Run with: node --test (from the dashboard/ directory)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHarness, basicAuth } = require('./support/harness');
const secrets = require('../lib/secrets');
const { readConfigMeta, maskConfig, mergeConfig, MASK } = require('./server');

/** Run `fn` against a fresh harness and always clean it up. */
async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---- auth + basics -----------------------------------------------------------

test('/api/health is reachable without auth', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ pathname: '/api/health', noAuth: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });
});

test('all other routes return 401 without auth', async () => {
  await withServer({}, async ({ request }) => {
    for (const pathname of ['/api/version', '/api/config', '/api/state', '/api/run/status', '/api/schedule', '/api/auth/whoami']) {
      const r = await request({ pathname, noAuth: true });
      assert.equal(r.status, 401, `${pathname} should be 401 without auth`);
    }
  });
});

test('/api/config with auth returns secrets masked', async () => {
  const cfgContent = {
    person: { firstName: 'Jane', lastName: 'Doe' },
    capsolver: { apiKey: 'REAL-SECRET-KEY' },
    email: { smtp: { host: 'smtp.example.com', user: 'jane@example.com', pass: 'REAL-SMTP-PASS' } },
    notify: { webhook: 'https://hooks.example.com/real-token' },
  };
  await withServer({ cfgContent }, async ({ request }) => {
    const r = await request({ pathname: '/api/config' });
    assert.equal(r.status, 200);
    const cfg = r.json.config;
    assert.notEqual(cfg.capsolver.apiKey, 'REAL-SECRET-KEY', 'capsolver.apiKey must be masked');
    assert.notEqual(cfg.email.smtp.pass, 'REAL-SMTP-PASS', 'smtp.pass must be masked');
    assert.notEqual(cfg.notify.webhook, 'https://hooks.example.com/real-token', 'webhook must be masked');
    assert.equal(cfg.person.firstName, 'Jane');
    assert.equal(cfg.person.lastName, 'Doe');
    assert.equal(cfg.email.smtp.host, 'smtp.example.com');
  });
});

test('POST /api/run mode real without confirm returns 400', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ method: 'POST', pathname: '/api/run', body: { mode: 'real' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /confirm/i);
  });
});

// ---- PUT /api/config merge semantics -----------------------------------------

test('mergeConfig: masked secret left as sentinel is preserved on disk', async () => {
  const cfgContent = { capsolver: { apiKey: 'ORIGINAL-SECRET' }, person: { firstName: 'Jane' } };
  await withServer({ cfgContent }, async ({ request, paths }) => {
    const r = await request({
      method: 'PUT', pathname: '/api/config',
      body: { capsolver: { apiKey: MASK }, person: { firstName: 'Updated' } },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    const saved = readJson(paths.config);
    assert.equal(saved.capsolver.apiKey, 'ORIGINAL-SECRET', 'masked sentinel must preserve original secret on disk');
    assert.equal(saved.person.firstName, 'Updated', 'non-secret field must be updated');
  });
});

test('mergeConfig: retyped secret is updated on disk', async () => {
  await withServer({ cfgContent: { capsolver: { apiKey: 'OLD-SECRET' } } }, async ({ request, paths }) => {
    const r = await request({ method: 'PUT', pathname: '/api/config', body: { capsolver: { apiKey: 'NEW-SECRET' } } });
    assert.equal(r.status, 200);
    assert.equal(readJson(paths.config).capsolver.apiKey, 'NEW-SECRET', 'retyped secret must be updated on disk');
  });
});

test('mergeConfig: non-secret field set to empty string is cleared', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Jane', lastName: 'Doe' } } }, async ({ request, paths }) => {
    const r = await request({ method: 'PUT', pathname: '/api/config', body: { person: { firstName: 'Jane', lastName: '' } } });
    assert.equal(r.status, 200);
    assert.equal(readJson(paths.config).person.lastName, '', 'clearing a non-secret field to "" must be preserved');
  });
});

// ---- exposure ----------------------------------------------------------------

test('/api/exposure returns a current score, breakdown and history array', async () => {
  const stateContent = {
    optOuts: {
      Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' }, // still listed (never verified)
      MyLife: { lastSuccess: '2026-01-01T00:00:00.000Z', verifiedDeletedAt: '2026-02-01T00:00:00.000Z' }, // gone
    },
  };
  await withServer({ stateContent }, async ({ request }) => {
    const r = await request({ pathname: '/api/exposure' });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.score, 'number');
    assert.equal(r.json.listedCount, 1); // Spokeo still listed, MyLife gone
    assert.ok(r.json.breakdown && typeof r.json.breakdown.listed === 'number');
    assert.ok(Array.isArray(r.json.history));
  });
});

test('/api/exposure requires auth', async () => {
  await withServer({}, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/exposure', noAuth: true })).status, 401);
  });
});

// ---- freeze checklist endpoints ----------------------------------------------

test('GET /api/freeze returns 7 targets with done:false for empty state', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request }) => {
    const r = await request({ pathname: '/api/freeze' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    assert.ok(Array.isArray(r.json.targets), 'response.targets must be an array');
    assert.equal(r.json.targets.length, 7);
    assert.ok(r.json.targets.every(t => t.done === false), 'all targets not-done for empty state');
    const eq = r.json.targets.find(t => t.key === 'equifax');
    assert.match(eq.url, /equifax\.com/);
    assert.equal(eq.type, 'credit-bureau');
  });
});

test('GET /api/freeze reflects completed targets from state.freezes', async () => {
  const stateContent = { optOuts: {}, freezes: { experian: { doneAt: '2026-06-02T00:00:00.000Z' } } };
  await withServer({ stateContent }, async ({ request }) => {
    const r = await request({ pathname: '/api/freeze' });
    assert.equal(r.status, 200);
    const ex = r.json.targets.find(t => t.key === 'experian');
    assert.equal(ex.done, true);
    assert.equal(ex.doneAt, '2026-06-02T00:00:00.000Z');
  });
});

test('POST /api/freeze action=done records the target on disk', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request, paths }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    assert.equal(r.json.ok, true);
    const saved = readJson(paths.state);
    assert.ok(saved.freezes.equifax, 'equifax freeze must be persisted');
    assert.match(saved.freezes.equifax.doneAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('POST /api/freeze action=clear removes a recorded target', async () => {
  const stateContent = { optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } };
  await withServer({ stateContent }, async ({ request, paths }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'clear' } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    assert.ok(!readJson(paths.state).freezes.equifax, 'equifax freeze must be cleared on disk');
  });
});

test('POST /api/freeze does not disturb the existing optOuts namespace', async () => {
  const stateContent = { optOuts: { spokeo: { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  await withServer({ stateContent }, async ({ request, paths }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'innovis', action: 'done' } });
    assert.equal(r.status, 200);
    const saved = readJson(paths.state);
    assert.ok(saved.optOuts.spokeo, 'optOuts must survive a freeze write');
    assert.equal(saved.optOuts.spokeo.lastSuccess, '2026-01-01T00:00:00.000Z');
    assert.ok(saved.freezes.innovis, 'innovis recorded alongside optOuts');
  });
});

test('POST /api/freeze with an unknown key returns 400', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'bogus', action: 'done' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown freeze target|bad key/i);
  });
});

test('POST /api/freeze with a bad action returns 400', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request }) => {
    const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'nope' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bad action|action/i);
  });
});

test('GET /api/freeze requires auth (401 without credentials)', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/freeze', noAuth: true })).status, 401);
  });
});

// ---- first-run gate ----------------------------------------------------------

test('GET /api/config/status: no config file -> not configured, person fields missing', async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ pathname: '/api/config/status' });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.ok(Array.isArray(r.json.missing));
    assert.ok(r.json.missing.includes('person.firstName'), 'should report person.firstName missing');
    assert.ok(r.json.missing.includes('person.lastName'), 'should report person.lastName missing');
    assert.ok(r.json.missing.includes('person.email'), 'should report person.email missing');
  });
});

test('GET /api/config/status: a complete person -> configured with no missing fields', async () => {
  const cfgContent = { person: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' } };
  await withServer({ cfgContent }, async ({ request }) => {
    const r = await request({ pathname: '/api/config/status' });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.deepEqual(r.json.missing, []);
  });
});

test('GET /api/config/status: unedited example placeholder -> not configured', async () => {
  const cfgContent = { person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' } };
  await withServer({ cfgContent }, async ({ request }) => {
    const r = await request({ pathname: '/api/config/status' });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.ok(r.json.missing.length > 0);
  });
});

test('GET /api/config/status requires auth (401 without credentials)', async () => {
  await withServer({}, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/config/status', noAuth: true })).status, 401);
  });
});

// B5: /api/config/status must use the decryption-aware reader so an encrypted
// config with a complete person reports configured:true (does NOT re-trigger the
// first-run wizard). A non-decrypting reader sees ciphertext and reports missing.
test('GET /api/config/status: encrypted config with complete person -> configured', async () => {
  const PASSPHRASE = 'test-passphrase-b5';
  const plain = { person: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' } };
  const encContent = secrets.encryptConfig(plain, PASSPHRASE);
  await withServer({ encContent, passphrase: PASSPHRASE }, async ({ request }) => {
    const r = await request({ pathname: '/api/config/status' });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true, 'encrypted config with a complete person must report configured');
    assert.deepEqual(r.json.missing, []);
    assert.equal(r.json.locked, false);
  });
});

// ---- At-rest config encryption -----------------------------------------------

function encTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-dash-'));
}

test('readConfigMeta returns plaintext config when config.json is plaintext', () => {
  const dir = encTmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  const plain = { person: { firstName: 'Katherine' }, capsolver: { apiKey: 'CAP-A' } };
  fs.writeFileSync(configPath, JSON.stringify(plain));
  const m = readConfigMeta({ configPath, encPath, passphrase: '' });
  assert.equal(m.exists, true);
  assert.deepEqual(m.data, plain);
});

test('readConfigMeta decrypts config.json.enc when a passphrase is supplied', () => {
  const dir = encTmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  const plain = { person: { firstName: 'Katherine' }, capsolver: { apiKey: 'CAP-A' } };
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(plain, 'pw')));
  const m = readConfigMeta({ configPath, encPath, passphrase: 'pw' });
  assert.equal(m.exists, true);
  assert.deepEqual(m.data, plain);
});

test('readConfigMeta flags parseError when an encrypted config has no passphrase', () => {
  const dir = encTmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig({ person: { firstName: 'Katherine' } }, 'pw')));
  const m = readConfigMeta({ configPath, encPath, passphrase: '' });
  assert.equal(m.exists, true);
  assert.equal(m.parseError, true);
  assert.equal(m.locked, true);
});

test('maskConfig still masks the capsolver key after decrypting', () => {
  assert.equal(maskConfig({ capsolver: { apiKey: 'CAP-SECRET' } }).capsolver.apiKey, MASK);
});

// -- PUT /api/config is encryption-aware ---------------------------------------

test('PUT /api/config with encrypted config preserves untouched fields and re-encrypts', async () => {
  const plain = {
    person: { firstName: 'Alice', lastName: 'Smith' },
    capsolver: { apiKey: 'ORIGINAL-SECRET' },
    notify: { webhook: 'https://hooks.example.com/original' },
  };
  const PASSPHRASE = 'test-passphrase-fix1';
  const encContent = secrets.encryptConfig(plain, PASSPHRASE);
  await withServer({ encContent, passphrase: PASSPHRASE }, async ({ request, paths }) => {
    const r = await request({
      method: 'PUT', pathname: '/api/config',
      body: { config: { person: { firstName: 'Updated', lastName: 'Smith' }, capsolver: { apiKey: MASK } } },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    // The critical invariant: no plaintext PII in config.json when enc is active.
    assert.equal(fs.existsSync(paths.config), false, 'plaintext config.json must not appear when encryption is active');
    assert.ok(fs.existsSync(paths.enc), 'config.json.enc must exist after encrypted PUT');
    const decrypted = secrets.decryptConfig(readJson(paths.enc), PASSPHRASE);
    assert.equal(decrypted.person.firstName, 'Updated', 'person.firstName must be updated in enc file');
    assert.equal(decrypted.capsolver.apiKey, 'ORIGINAL-SECRET', 'masked sentinel must preserve original secret in enc file');
    assert.equal(decrypted.notify.webhook, 'https://hooks.example.com/original', 'untouched field must be preserved via merge base');
  });
});

test('PUT /api/config without encryption writes plaintext (unchanged behavior)', async () => {
  const plain = { person: { firstName: 'Bob' }, capsolver: { apiKey: 'ORIGINAL-BOB' } };
  await withServer({ cfgContent: plain }, async ({ request, paths }) => {
    const r = await request({
      method: 'PUT', pathname: '/api/config',
      body: { config: { person: { firstName: 'BobUpdated' }, capsolver: { apiKey: MASK } } },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    const saved = readJson(paths.config);
    assert.equal(saved.person.firstName, 'BobUpdated');
    assert.equal(saved.capsolver.apiKey, 'ORIGINAL-BOB', 'masked sentinel preserves secret in plaintext mode');
    assert.ok(!fs.existsSync(paths.enc), 'config.json.enc must not appear for plaintext config');
  });
});

// -- secret-clear escape hatch -------------------------------------------------

test('PUT /api/config with explicit empty string clears a secret field', async () => {
  const plain = { capsolver: { apiKey: 'SECRET-TO-CLEAR' }, person: { firstName: 'Clara' } };
  await withServer({ cfgContent: plain }, async ({ request, paths }) => {
    const r = await request({ method: 'PUT', pathname: '/api/config', body: { config: { capsolver: { apiKey: '' } } } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal(readJson(paths.config).capsolver.apiKey, '', 'explicit empty string must clear the secret field');
  });
});

test('PUT /api/config with MASK sentinel preserves existing secret (not cleared)', async () => {
  await withServer({ cfgContent: { capsolver: { apiKey: 'PRESERVED-SECRET' } } }, async ({ request, paths }) => {
    const r = await request({ method: 'PUT', pathname: '/api/config', body: { config: { capsolver: { apiKey: MASK } } } });
    assert.equal(r.status, 200);
    assert.equal(readJson(paths.config).capsolver.apiKey, 'PRESERVED-SECRET', 'MASK sentinel must preserve the existing secret');
  });
});

// B19: mergeConfig must drop dangerous keys (__proto__ / constructor / prototype)
// so a crafted PUT body cannot pollute Object.prototype (defense-in-depth). The
// keys must be dropped outright, not merely neutralised by assignment semantics,
// so the merged object carries no manipulated prototype and no polluting own key.
test('mergeConfig drops __proto__/constructor/prototype keys without polluting', () => {
  // JSON.parse produces __proto__/constructor as OWN enumerable properties.
  const incoming = JSON.parse('{"person":{"firstName":"Updated","__proto__":{"polluted":"yes"}},"constructor":{"polluted":"c"},"prototype":{"polluted":"p"},"__proto__":{"polluted":"top"}}');
  const out = mergeConfig({ person: { firstName: 'Peggy' } }, incoming);
  assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(out.person.firstName, 'Updated', 'legitimate field must still be merged');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'constructor'), false, 'constructor own-key must be dropped');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'prototype'), false, 'prototype own-key must be dropped');
  assert.equal(Object.prototype.hasOwnProperty.call(out.person, 'polluted'), false, 'nested pollution must not leak');
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'merged object must have a clean prototype');
  assert.equal(Object.getPrototypeOf(out.person), Object.prototype, 'nested merged object must have a clean prototype');
});

test('PUT /api/config with a nested __proto__ does not pollute and is dropped', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Peggy' } } }, async ({ request, paths }) => {
    // JSON.parse so __proto__ is a real own key on the wire.
    const r = await request({
      method: 'PUT', pathname: '/api/config',
      rawBody: '{"config":{"person":{"firstName":"Updated","__proto__":{"polluted":"yes"}},"__proto__":{"polluted":"yes"}}}',
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
    const saved = readJson(paths.config);
    assert.equal(saved.person.firstName, 'Updated', 'legitimate field must still be updated');
    assert.equal(Object.prototype.hasOwnProperty.call(saved.person, 'polluted'), false, 'polluted own-prop must not be persisted');
    assert.equal(saved.polluted, undefined, 'top-level polluted must not be persisted');
  });
});

// -- Issue #8 cross-model review: secret masking + plaintext-spill guard --------
//
// Two independent reviews (OpenAI codex and a second Claude pass) both flagged
// that SECRET_PATHS covered only 3 of the 5 secret leaves config.example.json
// actually defines. GET /api/config returned relay.apiKey (SimpleLogin) and
// hibp.apiKey verbatim to the browser, so anyone with dashboard read access
// walked away with reusable third-party API keys.

test('maskConfig masks the SimpleLogin relay API key', () => {
  assert.equal(maskConfig({ relay: { apiKey: 'SL-LIVE-SECRET' } }).relay.apiKey, MASK, 'relay.apiKey is a live credential and must be masked');
});

test('maskConfig masks the HIBP API key', () => {
  assert.equal(maskConfig({ hibp: { apiKey: 'HIBP-LIVE-SECRET' } }).hibp.apiKey, MASK, 'hibp.apiKey is a paid credential and must be masked');
});

test('maskConfig covers every secret leaf that config.example.json declares', () => {
  // Guard against the next secret being added to the example config without a
  // matching SECRET_PATHS entry.
  const full = {
    capsolver: { apiKey: 'a' },
    hibp: { apiKey: 'b' },
    relay: { apiKey: 'c' },
    email: { smtp: { pass: 'd' } },
    notify: { webhook: 'https://hooks.example.com/e' },
    accounts: { spokeo: { email: 'x@y.z', password: 'f' } },
  };
  const masked = maskConfig(full);
  const leaked = [];
  const walk = (o, trail) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === 'object') walk(v, [...trail, k]);
      else if (typeof v === 'string' && ['a', 'b', 'c', 'd', 'f'].includes(v)) leaked.push([...trail, k].join('.'));
      else if (typeof v === 'string' && v.startsWith('https://hooks.')) leaked.push([...trail, k].join('.'));
    }
  };
  walk(masked, []);
  assert.deepEqual(leaked, [], `unmasked secrets returned to the browser: ${leaked.join(', ')}`);
});

test('PUT /api/config refuses to write plaintext beside an active encrypted config', async () => {
  // The old else-branch wrote a plaintext config.json whenever config.json.enc
  // existed but AIDR_PASSPHRASE was unset. Two harms at once: full PII landed on
  // disk in the clear, and loadConfig() still prefers the .enc file, so the edit
  // the operator just made silently did nothing.
  const plain = { person: { firstName: 'Alice', lastName: 'Smith' }, capsolver: { apiKey: 'ORIGINAL' } };
  const encContent = secrets.encryptConfig(plain, 'the-real-passphrase');
  await withServer({ encContent }, async ({ request, paths }) => { // no passphrase
    const r = await request({
      method: 'PUT', pathname: '/api/config',
      body: { config: { person: { firstName: 'Updated', lastName: 'Smith' } } },
    });
    assert.notEqual(r.status, 200, 'the write must be rejected, not silently downgraded to plaintext');
    assert.match(JSON.stringify(r.json || {}), /passphrase/i, 'the error should tell the operator to supply AIDR_PASSPHRASE');
    assert.equal(fs.existsSync(paths.config), false, 'no plaintext config.json may be created next to an active config.json.enc');
  });
});

// keep basicAuth exported from the harness exercised: a wrong password is a 401
test('a wrong Basic password is rejected', async () => {
  await withServer({}, async ({ rawRequest }) => {
    const r = await rawRequest({ pathname: '/api/version', headers: { Authorization: basicAuth('testuser', 'wrong') } });
    assert.equal(r.status, 401);
  });
});
