'use strict';
/**
 * test/doctor-config-sources.test.js
 *
 * CFG-12: doctor read only <root>/config.json and <root>/state.json. With an
 * encrypted install it reported "config.json not found" and skipped every SMTP /
 * CapSolver / webhook check; with AIDR_STATE_PATH pointing at a corrupt file it
 * said "absent (fresh install)". It now loads the config the way the watcher does
 * (encrypted, passphrase from env / file) and checks the real state path.
 *
 * CFG-15b: doctor printed the full webhook URL, which for Slack and ntfy is the
 * credential, and https.request rejected http:// webhooks outright.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const secrets = require('../lib/secrets');
const cfgModule = require('../lib/config');
const { checkConfig, checkState, checkWebhook, runDoctor } = require('../lib/doctor');

// R4: runDoctor also reads the installed schedule. These tests are about other
// checks, so the schedule is stubbed and nothing here asks the real crontab,
// launchd or systemd anything.
const NO_SCHEDULE = { installed: false, kind: null, kinds: [], schedule: null, target: null, active: null, env: {}, plaintextPassphrase: false, lastRun: null };

const PERSON = { firstName: 'Radia', lastName: 'Perlman', email: 'radia@perlman-net.org', zip: '02139' };
const FULL = {
  person: PERSON,
  email: { smtp: { host: 'smtp.perlman-net.org', port: 587 } },
  capsolver: { apiKey: 'CAP-real-key-123' },
  notify: { webhook: 'https://hooks.slack.test/services/T000/B000/SECRETTOKEN' },
};
const PASS = 'doctor-passphrase';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-src-'));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const NO_PASS = { AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: undefined };

describe('doctor with an encrypted config', () => {
  it('checkConfig reads config.json.enc with the passphrase', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(FULL, PASS)));
    const r = await withEnv({ ...NO_PASS, AIDR_PASSPHRASE: PASS }, () => checkConfig(dir));
    assert.equal(r.ok, true, r.hint);
    assert.match(r.hint, /encrypted/i);
  });

  it('checkConfig says passphrase, not "not found", when the passphrase is missing', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(FULL, PASS)));
    const r = await withEnv(NO_PASS, () => checkConfig(dir));
    assert.equal(r.ok, false);
    assert.match(r.hint, /passphrase/i);
    assert.doesNotMatch(r.hint, /not found/i);
  });

  it('checkConfig reports a wrong passphrase distinctly', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(FULL, PASS)));
    const r = await withEnv({ ...NO_PASS, AIDR_PASSPHRASE: 'nope' }, () => checkConfig(dir));
    assert.equal(r.ok, false);
    assert.match(r.hint, /wrong passphrase|decrypt/i);
  });

  it('runDoctor runs the SMTP / CapSolver / webhook checks against the decrypted config', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(FULL, PASS)));
    const probed = [];
    const results = await withEnv({ ...NO_PASS, AIDR_PASSPHRASE: PASS }, () => runDoctor({
      rootDir: dir,
      requirePlaywright: () => ({ chromium: { executablePath: () => '/x' } }),
      fsExists: () => true,
      tcpProbe: async (host, port) => { probed.push(`${host}:${port}`); return true; },
      headRequest: async () => 200,
      printOutput: false,
      scheduleStatus: NO_SCHEDULE,
    }));
    const byName = Object.fromEntries(results.map(r => [r.name, r]));
    assert.equal(byName.config.ok, true, byName.config.hint);
    assert.deepEqual(probed, ['smtp.perlman-net.org:587']);
    for (const name of ['smtp', 'capsolver', 'webhook']) {
      assert.doesNotMatch(byName[name].hint, /skipped/i, `${name} must not be skipped: ${byName[name].hint}`);
    }
  });

  it('the passphrase file is a passphrase source for doctor too', { skip: process.platform === 'win32' }, async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(FULL, PASS)));
    const pf = path.join(dir, 'pw');
    fs.writeFileSync(pf, PASS + '\n', { mode: 0o600 });
    fs.chmodSync(pf, 0o600);
    const r = await withEnv({ ...NO_PASS, AIDR_PASSPHRASE_FILE: pf }, () => checkConfig(dir));
    assert.equal(r.ok, true, r.hint);
  });

  it('a plaintext config still works exactly as before', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(FULL));
    const r = await withEnv(NO_PASS, () => checkConfig(dir));
    assert.equal(r.ok, true);
    assert.match(r.hint, /valid/i);
  });
});

describe('doctor config gate', () => {
  it('checkConfig fails on an unedited config.example.json', async () => {
    const dir = tmpDir();
    fs.copyFileSync(path.join(__dirname, '..', 'config.example.json'), path.join(dir, 'config.json'));
    const r = await withEnv(NO_PASS, () => checkConfig(dir));
    assert.equal(r.ok, false);
    assert.match(r.hint, /config\.example\.json/);
  });
});

describe('doctor state path', () => {
  it('checkState honours an explicit statePath over rootDir', async () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(bad, 'not json');
    const r = await checkState(dir, { statePath: bad });
    assert.equal(r.ok, false);
    assert.match(r.hint, /parse/i);
  });

  it('with no rootDir, runDoctor checks the real state path (AIDR_STATE_PATH / getStatePath)', async () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'state.json');
    fs.writeFileSync(bad, '{ truncated');
    cfgModule.setTestStatePath(bad);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const results = await runDoctor({
        requirePlaywright: () => ({ chromium: { executablePath: () => '/x' } }),
        fsExists: () => true,
        tcpProbe: async () => true,
        headRequest: async () => 200,
        printOutput: false,
        scheduleStatus: NO_SCHEDULE,
      });
      const state = results.find(r => r.name === 'state');
      assert.equal(state.ok, false, state.hint);
      assert.match(state.hint, /parse/i);
    } finally {
      console.warn = realWarn;
      cfgModule.setTestStatePath(null);
    }
  });
});

describe('doctor webhook output', () => {
  it('prints only scheme and host, never the secret path', async () => {
    const r = await checkWebhook(FULL, { headRequest: async () => 200 });
    assert.equal(r.ok, true);
    assert.match(r.hint, /hooks\.slack\.test/);
    assert.doesNotMatch(r.hint, /SECRETTOKEN|services/);
  });

  it('does not leak the URL through an error message either', async () => {
    const url = FULL.notify.webhook;
    const r = await checkWebhook(FULL, { headRequest: async () => { throw new Error(`getaddrinfo ENOTFOUND for ${url}`); } });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.hint, /SECRETTOKEN/);
    assert.match(r.hint, /hooks\.slack\.test/);
  });

  it('never prints credentials embedded in the URL', async () => {
    const r = await checkWebhook({ notify: { webhook: 'https://user:hunter2@example.test/hook?k=SECRET' } }, { headRequest: async () => 200 });
    assert.doesNotMatch(r.hint, /hunter2|SECRET|user:/);
  });

  it('a malformed URL is reported without echoing it', async () => {
    const r = await checkWebhook({ notify: { webhook: 'not a url SECRETTOKEN' } }, { headRequest: async () => 200 });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.hint, /SECRETTOKEN/);
    assert.match(r.hint, /not a valid URL/i);
  });

  it('a non-http(s) scheme is refused', async () => {
    const r = await checkWebhook({ notify: { webhook: 'ftp://example.test/x' } }, { headRequest: async () => 200 });
    assert.equal(r.ok, false);
    assert.match(r.hint, /http/i);
  });

  it('an http:// webhook is actually probed (the default request supports http)', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => { hits += 1; res.statusCode = 204; res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const r = await checkWebhook({ notify: { webhook: `http://127.0.0.1:${port}/topic/SECRETTOKEN` } });
      assert.equal(r.ok, true, r.hint);
      assert.equal(hits, 1);
      assert.doesNotMatch(r.hint, /SECRETTOKEN|topic/);
    } finally {
      server.close();
    }
  });
});
