/**
 * test/setup-build-config.test.js
 *
 * CFG-1: re-running `node setup.js` rebuilt the config from only person,
 * capsolver, accounts, notify and profileDir. For a user with a persons[] config
 * (and SMTP, relay, hibp, allowlist, notify.emailReportTo) pressing Enter at
 * every prompt produced a blank `person`, deleted everything else, left a 0644
 * file at 0644, and - if encryption was on - re-encrypted that over the .enc,
 * irreversibly.
 *
 * buildConfig(existing, answers) is the pure core: it preserves every key setup
 * does not ask about, edits persons[0] in place for a persons config, and
 * refuses blank name / email / zip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildConfig, answerDefaults, saveConfig, readExistingConfig } = require('../setup');

const GRACE = {
  firstName: 'Grace', lastName: 'Hopper', fullName: 'Grace Hopper',
  aliases: ['G Hopper'], city: 'Arlington', country: 'US', state: 'VA', zip: '22201',
  email: 'grace@hopper-labs.org', phone: '7035550111', phoneFormatted: '(703) 555-0111',
  dob: '1906-12-09', _note: 'hand-added field setup knows nothing about',
};
const GRACE_TWIN = {
  firstName: 'Gregory', lastName: 'Hopper', fullName: 'Gregory Hopper',
  aliases: [], city: 'Arlington', country: 'US', state: 'VA', zip: '22201',
  email: 'gregory@hopper-labs.org', phone: '7035550112', phoneFormatted: '(703) 555-0112',
};

function multiPersonConfig() {
  return {
    persons: [GRACE, GRACE_TWIN],
    capsolver: { apiKey: 'CAP-real-key' },
    accounts: { spokeo: { email: 'grace@hopper-labs.org', password: 'pw1' } },
    notify: { textTo: '+17035550111', webhook: 'https://ntfy.example/topic', emailReportTo: 'grace@hopper-labs.org' },
    profileDir: '/home/grace/.config/aidr',
    email: { smtp: { host: 'smtp.hopper-labs.org', port: 587, user: 'grace', pass: 'smtp-secret', from: 'grace@hopper-labs.org' } },
    relay: { provider: 'simplelogin', apiKey: 'SL-KEY' },
    hibp: { apiKey: 'HIBP-KEY' },
    allowlist: ['Whitepages'],
    futureFeature: { enabled: true },
  };
}

test('answering every prompt with its default is a no-op on a multi-person config', () => {
  const existing = multiPersonConfig();
  const out = buildConfig(existing, answerDefaults(existing));
  assert.deepEqual(out, existing);
});

test('answering every prompt with its default is a no-op on a single-person config', () => {
  const existing = { ...multiPersonConfig(), persons: undefined, person: GRACE };
  delete existing.persons;
  const out = buildConfig(existing, answerDefaults(existing));
  assert.deepEqual(out, existing);
});

test('a persons config is edited in place: persons[0] changes, persons[1] is untouched, no person key appears', () => {
  const existing = multiPersonConfig();
  const answers = { ...answerDefaults(existing), city: 'Washington', zip: '20001' };
  const out = buildConfig(existing, answers);

  assert.equal(out.person, undefined, 'must not write a person key beside persons');
  assert.equal(out.persons.length, 2);
  assert.equal(out.persons[0].city, 'Washington');
  assert.equal(out.persons[0].zip, '20001');
  assert.equal(out.persons[0].dob, GRACE.dob, 'unknown person keys survive');
  assert.deepEqual(out.persons[1], GRACE_TWIN);
});

test('every key setup does not ask about survives', () => {
  const existing = multiPersonConfig();
  const out = buildConfig(existing, { ...answerDefaults(existing), textTo: '+17035559999' });
  assert.deepEqual(out.email, existing.email);
  assert.deepEqual(out.relay, existing.relay);
  assert.deepEqual(out.hibp, existing.hibp);
  assert.deepEqual(out.allowlist, existing.allowlist);
  assert.deepEqual(out.futureFeature, existing.futureFeature);
  assert.equal(out.notify.emailReportTo, 'grace@hopper-labs.org');
  assert.equal(out.notify.webhook, 'https://ntfy.example/topic');
  assert.equal(out.notify.textTo, '+17035559999', 'the answered value is applied');
});

test('accounts the wizard did not touch are kept', () => {
  const existing = multiPersonConfig();
  const out = buildConfig(existing, {
    ...answerDefaults(existing),
    accounts: { beenverified: { email: 'grace@hopper-labs.org', password: 'pw2' } },
  });
  assert.deepEqual(out.accounts.spokeo, existing.accounts.spokeo);
  assert.equal(out.accounts.beenverified.password, 'pw2');
});

test('a fresh install (no existing config) builds a single-person config', () => {
  const out = buildConfig({}, {
    firstName: 'Ada', lastName: 'Lovelace', aliases: ['A Lovelace'], city: 'London', country: 'GB',
    state: 'LND', zip: 'SW1A 1AA', email: 'ada@example.org', phone: '2075550100',
    capsolverKey: '', textTo: '', webhook: '', profileDir: '/tmp/p', accounts: {},
  });
  assert.deepEqual(out.person, {
    firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', aliases: ['A Lovelace'],
    city: 'London', country: 'GB', state: 'LND', zip: 'SW1A 1AA', email: 'ada@example.org',
    phone: '2075550100', phoneFormatted: '2075550100',
  });
  assert.equal(out.capsolver.apiKey, 'CAP-YOUR_KEY_HERE');
  assert.equal(out.notify.webhook, undefined);
});

test('US phone digits are formatted, other countries are verbatim', () => {
  const base = answerDefaults(multiPersonConfig());
  assert.equal(buildConfig(multiPersonConfig(), { ...base, phone: '5125550000' }).persons[0].phoneFormatted, '(512) 555-0000');
  assert.equal(buildConfig(multiPersonConfig(), { ...base, country: 'GB', phone: '+44 20 7946 0000' }).persons[0].phoneFormatted, '+44 20 7946 0000');
});

test('blank first name, last name, email or zip is rejected, naming the field', () => {
  const existing = multiPersonConfig();
  const defaults = answerDefaults(existing);
  const labels = { firstName: /first name/i, lastName: /last name/i, email: /email/i, zip: /zip|postal/i };
  for (const [field, label] of Object.entries(labels)) {
    for (const blank of ['', '   ', undefined]) {
      assert.throws(() => buildConfig(existing, { ...defaults, [field]: blank }), label, `${field}=${JSON.stringify(blank)}`);
    }
  }
});

test('buildConfig does not mutate its inputs', () => {
  const existing = multiPersonConfig();
  const snapshot = JSON.stringify(existing);
  const answers = answerDefaults(existing);
  const answersSnapshot = JSON.stringify(answers);
  buildConfig(existing, { ...answers, city: 'Elsewhere' });
  assert.equal(JSON.stringify(existing), snapshot);
  assert.equal(JSON.stringify(answers), answersSnapshot);
});

test('answerDefaults reads persons[0] for a persons config and person otherwise', () => {
  assert.equal(answerDefaults(multiPersonConfig()).firstName, 'Grace');
  assert.equal(answerDefaults({ person: GRACE_TWIN }).firstName, 'Gregory');
  assert.equal(answerDefaults({}).country, 'US');
  assert.equal(answerDefaults({}).firstName, '');
});

// -- the write ------------------------------------------------------------------

test('saveConfig writes 0600 and tightens an existing 0644 file', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-save-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{"old":true}', { mode: 0o644 });
  fs.chmodSync(configPath, 0o644);

  const config = multiPersonConfig();
  saveConfig(config, { configPath });

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'no temp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveConfig creates a new file 0600', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-save-'));
  const configPath = path.join(dir, 'config.json');
  saveConfig({ person: GRACE }, { configPath });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- never overwrite what could not be read --------------------------------------

test('readExistingConfig flags a config.json that is not valid JSON, so setup can refuse to overwrite it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-corrupt-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{ "person": { "firstName": "Grace", }');
  const r = readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: '' });
  assert.equal(r.exists, true);
  assert.equal(r.corrupt, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a valid config is not flagged corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-corrupt-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ person: GRACE }));
  const r = readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: '' });
  assert.notEqual(r.corrupt, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
