/**
 * test/setup-secrets.test.js
 *
 * setup.js and secrets (CFG2 "looked fine but risky" list, codex round 2 #5 and #6):
 *
 *  - Re-running setup printed the existing CapSolver key and notification webhook
 *    (the credential for Slack and ntfy) as the prompt default, into the terminal
 *    and its scrollback, and from there into any pasted bug report.
 *  - Broker account passwords were read with the plain prompt: echoed as typed.
 *  - Editing an encrypted config wrote the whole config as PLAINTEXT config.json
 *    first and encrypted it afterwards, so a kill in between, or a failed shred,
 *    left the PII in the clear. It now writes the envelope straight into the file
 *    it came from, in the layout it was in.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const secrets = require('../lib/secrets');
const setup = require('../setup');

const ROOT = path.join(__dirname, '..');
const skip = process.platform === 'win32' ? 'POSIX' : false;

const GRACE = {
  firstName: 'Grace', lastName: 'Hopper', fullName: 'Grace Hopper', aliases: [],
  city: 'Arlington', country: 'US', state: 'VA', zip: '22201',
  email: 'grace@hopper-labs.org', phone: '7035550111', phoneFormatted: '(703) 555-0111',
};
const CAP_KEY = 'CAP-real-key-XYZ-9981';
const HOOK = 'https://ntfy.sh/secret-topic-77123';
const PASSWORD = 'spokeo-pw-5531';
const existing = () => ({
  person: GRACE,
  capsolver: { apiKey: CAP_KEY },
  notify: { textTo: '+17035550111', webhook: HOOK },
  accounts: { spokeo: { email: GRACE.email, password: PASSWORD } },
});

function runWizard(dir, extraEnv, respond) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['setup.js'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        AIDR_CONFIG_PATH: path.join(dir, 'config.json'),
        AIDR_STATE_PATH: path.join(dir, 'state.json'),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let all = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`wizard timed out. Output so far:\n${all}\n${stderr}`)); }, 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      all += d.toString();
      if (!buf.endsWith(': ')) return;
      const prompt = buf.split('\n').pop();
      buf = '';
      child.stdin.write(`${respond(prompt)}\n`);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: all, err: stderr }); });
  });
}
const enterEverywhere = (prompt) => (/\(y\/n\)/.test(prompt) ? 'n' : '');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-sec-'));

// ---- existing secrets are not printed ---------------------------------------------

test('re-running setup does not print the stored CapSolver key, webhook or account password', { skip }, async () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(existing(), null, 2), { mode: 0o600 });
  const res = await runWizard(dir, {}, enterEverywhere);
  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  for (const secret of [CAP_KEY, HOOK, 'secret-topic-77123', PASSWORD]) {
    assert.ok(!res.out.includes(secret) && !res.err.includes(secret), `${secret} was printed`);
  }
  assert.match(res.out, /CapSolver API key \[[^\]]*keep[^\]]*\]: /i, 'the prompt says Enter keeps the current key');
  assert.match(res.out, /Notification webhook[^\n]*\[[^\]]*keep[^\]]*\]: /i);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(after.capsolver.apiKey, CAP_KEY, 'Enter keeps the stored key');
  assert.equal(after.notify.webhook, HOOK, 'and the stored webhook');
  assert.equal(after.accounts.spokeo.password, PASSWORD);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('typing a new CapSolver key replaces the stored one; a first-time prompt has no "keep" hint', { skip }, async () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(existing(), null, 2), { mode: 0o600 });
  const res = await runWizard(dir, {}, (p) => (/^CapSolver/.test(p) ? 'CAP-new-key-4' : enterEverywhere(p)));
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).capsolver.apiKey, 'CAP-new-key-4');
  fs.rmSync(dir, { recursive: true, force: true });

  const fresh = tmp();
  const r2 = await runWizard(fresh, {}, (p) => {
    if (/^First name/.test(p)) return 'Ada';
    if (/^Last name/.test(p)) return 'Lovelace';
    if (/^Postal code|^ZIP/.test(p)) return '10001';
    if (/^Email address/.test(p)) return 'ada@lovelace-notes.org';
    if (/^Country/.test(p)) return 'US';
    return enterEverywhere(p);
  });
  assert.equal(r2.code, 0);
  assert.match(r2.out, /\nCapSolver API key: /, 'nothing stored: a plain prompt');
  fs.rmSync(fresh, { recursive: true, force: true });
});

// ---- account passwords use the secret prompt --------------------------------------

test('broker account passwords are read with the secret prompt, not echoed', async () => {
  const calls = [];
  const prompter = {
    ask: async (q, def = '') => { calls.push(['ask', q]); return /login email/.test(q) ? 'me@example.org' : def; },
    askSecret: async (q) => { calls.push(['askSecret', q]); return 'typed-secret'; },
    confirm: async () => true,
  };
  const accounts = await setup.collectAccounts({
    prompter, accounts: {}, email: 'me@example.org', say: () => {}, open: () => {},
  });
  const askedPassword = calls.filter(([, q]) => /password/i.test(q));
  assert.equal(askedPassword.length, 3, 'one password prompt per site');
  assert.ok(askedPassword.every(([kind]) => kind === 'askSecret'), JSON.stringify(askedPassword));
  assert.equal(accounts.spokeo.password, 'typed-secret');
});

test('updating a stored account: a blank password keeps the stored one', async () => {
  const prompter = {
    ask: async (q, def = '') => def,
    askSecret: async () => '',
    confirm: async (q) => /Spokeo/.test(q), // update Spokeo only
  };
  const accounts = await setup.collectAccounts({
    prompter,
    accounts: { spokeo: { email: 'a@b.c', password: 'stored-pw' } },
    email: 'a@b.c', say: () => {}, open: () => {},
  });
  assert.equal(accounts.spokeo.password, 'stored-pw');
  assert.equal(accounts.beenverified.password, '', 'a declined site is a blank placeholder, as before');
});

// ---- editing an encrypted config never writes plaintext ---------------------------

function recordWrites(fn) {
  const written = [];
  const realWrite = fs.writeFileSync;
  const realOpen = fs.openSync;
  fs.writeFileSync = function (p, ...rest) { if (typeof p === 'string') written.push(p); return realWrite.call(this, p, ...rest); };
  fs.openSync = function (p, flags, ...rest) {
    if (typeof p === 'string' && /[wa+]/.test(String(flags))) written.push(p);
    return realOpen.call(this, p, flags, ...rest);
  };
  try { fn(); } finally { fs.writeFileSync = realWrite; fs.openSync = realOpen; }
  return written;
}

const ENC_PASS = 'edit-passphrase';

test('persistConfig on an encrypted install writes the envelope to the .enc file and never a plaintext config.json', () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(existing(), ENC_PASS)), { mode: 0o600 });
  const prior = setup.readExistingConfig({ configPath, encPath, passphrase: ENC_PASS });
  assert.equal(prior.file, encPath);

  const next = { ...prior.config, capsolver: { apiKey: 'CAP-changed' } };
  const written = recordWrites(() => setup.persistConfig(next, prior, { passphrase: ENC_PASS, configPath }));
  const plaintextWrites = written.filter(p => p === configPath || p.startsWith(configPath + '.tmp') || p.startsWith(configPath + '.bak'));
  assert.deepEqual(plaintextWrites, [], 'a plaintext config.json (or its temp file) was written');
  assert.ok(written.some(p => p.startsWith(encPath)), 'and the envelope really was written');
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), ENC_PASS).capsolver.apiKey, 'CAP-changed');
  assert.equal(fs.statSync(encPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistConfig keeps an in-place envelope in config.json', () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(secrets.encryptConfig(existing(), ENC_PASS)), { mode: 0o600 });
  const prior = setup.readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: ENC_PASS });
  assert.equal(prior.file, configPath);
  setup.persistConfig({ ...prior.config, capsolver: { apiKey: 'CAP-changed' } }, prior, { passphrase: ENC_PASS, configPath });
  assert.equal(fs.existsSync(path.join(dir, 'config.json.enc')), false);
  const env = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true, 'still an envelope, not plaintext');
  assert.equal(secrets.decryptConfig(env, ENC_PASS).capsolver.apiKey, 'CAP-changed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistConfig on a plain install writes config.json as before', () => {
  const dir = tmp();
  const configPath = path.join(dir, 'config.json');
  const prior = setup.readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: '' });
  const out = setup.persistConfig(existing(), prior, { passphrase: '', configPath });
  assert.equal(out.encrypted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).person, GRACE);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real wizard on an encrypted install: values kept, still encrypted, no plaintext config.json', { skip }, async () => {
  const dir = tmp();
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(existing(), ENC_PASS)), { mode: 0o600 });
  const res = await runWizard(dir, { AIDR_PASSPHRASE: ENC_PASS }, (p) => (/^City/.test(p) ? 'Richmond' : enterEverywhere(p)));
  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'no plaintext config.json');
  const cfg = secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), ENC_PASS);
  assert.equal(cfg.person.city, 'Richmond');
  assert.equal(cfg.capsolver.apiKey, CAP_KEY);
  assert.equal(cfg.notify.webhook, HOOK);
  for (const secret of [CAP_KEY, HOOK, PASSWORD]) assert.ok(!res.out.includes(secret), `${secret} was printed`);
  fs.rmSync(dir, { recursive: true, force: true });
});
