/**
 * test/upgrade-origin-main-install.test.js
 *
 * The upgrade path, in one place. A real person runs this from cron: an install
 * made by the released version (origin/main) has a single-person plaintext
 * config.json, a bare-key state.json whose entries carry no `fp`, no AIDR_HOME,
 * no state.json.bak beyond the one saveState writes, and possibly a
 * config.json.enc written by the first encryption release (v:1, scrypt N=2^14).
 *
 * Every change in this wave touches how that data is read or written (the
 * fingerprint, the single-person composite fallback, the complaint ownership
 * filter, the envelope version, the unreadable-state refusal, the dashboard auth).
 * This test loads such an install and asserts that
 *   - nothing re-runs: every broker that was skipped before is skipped now, and
 *     every one that was due is still due;
 *   - nothing is lost: a write adds to the history and leaves every other entry,
 *     and every key setup never heard of, exactly as it was;
 *   - every reader (config check, doctor, complaint, dashboard) accepts it.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const secrets = require('../lib/secrets');
const { checkConfig } = require('../lib/config-check');
const complaint = require('../lib/complaint');
const doctor = require('../lib/doctor');
const harness = require('../dashboard/support/harness');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const PERSON = {
  firstName: 'Margaret', lastName: 'Hamilton', fullName: 'Margaret Hamilton', aliases: ['Peg Hamilton'],
  city: 'Raleigh', country: 'US', state: 'NC', zip: '27601',
  email: 'margaret@hamilton-apollo.org', phone: '9195550142', phoneFormatted: '(919) 555-0142',
};

// What released versions wrote: bare keys, no fp, camel-case fields, the odd pending entry.
const ORIGIN_CONFIG = () => ({
  person: PERSON,
  capsolver: { apiKey: 'CAP-origin-key-1234' },
  notify: { textTo: '+19195550142' },
  email: { smtp: { host: 'smtp.hamilton-apollo.org', port: 587, user: 'margaret', pass: 'smtp-origin-pw', from: PERSON.email } },
  accounts: { spokeo: { email: PERSON.email, password: 'spokeo-origin-pw' } },
  profileDir: '/home/mh/.config/auto-identity-remove',
});

const ORIGIN_STATE = () => ({
  createdAt: daysAgo(400),
  optOuts: {
    Spokeo: { history: ['error', 'success'], lastSuccess: daysAgo(30), lastAttempt: daysAgo(30), lastDetail: 'submitted https://www.spokeo.com/optout', totalRuns: 4 },
    Whitepages: { history: ['success'], lastSuccess: daysAgo(200), lastAttempt: daysAgo(200), lastDetail: 'ok', totalRuns: 2 },
    MyLife: { history: ['pending_confirm'], lastAttempt: daysAgo(3), pendingConfirm: { since: daysAgo(3), snippet: 'check your inbox' }, totalRuns: 1 },
    Radaris: { history: ['pending_confirm'], lastAttempt: daysAgo(40), pendingConfirm: { since: daysAgo(40), snippet: 'check your inbox' }, totalRuns: 1 },
    PeopleFinders: { history: ['notFound'], lastAttempt: daysAgo(10), totalRuns: 1 },
    Intelius: { history: ['success'], lastSuccess: daysAgo(100), verifiedStillListedAt: daysAgo(5), lastAttempt: daysAgo(100), totalRuns: 3 },
    BeenVerified: { history: ['success'], lastSuccess: daysAgo(10), knowRequestedAt: daysAgo(60), totalRuns: 1 },
  },
  relayAliases: { 'margaret@hamilton-apollo.org': 'mh.alias@simplelogin.com' },
  freezes: { equifax: { at: daysAgo(80) } },
});

// One snapshot per install, so what a test compares against is exactly what was
// written (the timestamps are relative to now).
function install({ legacyEncrypted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-upgrade-'));
  const files = { config: path.join(dir, 'config.json'), enc: path.join(dir, 'config.json.enc'), state: path.join(dir, 'state.json') };
  const config = ORIGIN_CONFIG();
  const state = ORIGIN_STATE();
  if (legacyEncrypted) {
    fs.writeFileSync(files.enc, JSON.stringify(LEGACY_ENVELOPE));
  } else {
    fs.writeFileSync(files.config, JSON.stringify(config, null, 2), { mode: 0o644 });
  }
  fs.writeFileSync(files.state, JSON.stringify(state, null, 2), { mode: 0o644 });
  fs.writeFileSync(files.state + '.bak', JSON.stringify(state, null, 2), { mode: 0o644 });
  return { dir, files, config, state };
}

function withState(files, fn) {
  cfg.setTestStatePath(files.state);
  cfg.resetState();
  try { return fn(); } finally {
    cfg.setTestStatePath(null);
    cfg.resetState();
  }
}

// Written by the first encryption release: v:1, kdf 'scrypt' (N=2^14 implied).
const LEGACY_PASSPHRASE = 'legacy-passphrase';
const LEGACY_PLAIN = {
  person: { firstName: 'Legacy', lastName: 'Fixture', email: 'legacy@example.com', zip: '00000' },
  notify: { textTo: '+15555550100' },
};
const LEGACY_ENVELOPE = {
  v: 1, alg: 'aes-256-gcm', kdf: 'scrypt',
  salt: 'b364b5bdd4e0299e05141951f89074a1', iv: '50bf60f28bf20ea0ab975323', tag: '06c886617ebcf8d4319e0fcbf0692c41',
  ciphertext:
    '671e2c313d2587871a12a6d4889f2cd1a2a7df5fe7026a09cdaf073b53465a9edece166323980cfd903db1987b0319f5' +
    '48ba6937f02d74d7c3df93f8f6142a10fa90c15974f3e7cbf92fe459a4bd1cf1f0d2bb12df44b435e1c6b8879c3dababe' +
    '5408b1e9a15be6721448eeaa32252f5a26bf8e95852eadd0be8ce77ab3dc3a4fa508037',
};

// ---- nothing re-runs -----------------------------------------------------------------

test('every broker is skipped or due exactly as it was before the upgrade', () => {
  const { dir, files } = install();
  withState(files, () => {
    const decide = (name, over = {}) => cfg.shouldSkip(name, { person: PERSON, personCount: 1, personIndex: 0, ...over });
    assert.match(decide('Spokeo').reason, /Last removed 30d ago/, 'removed a month ago: skipped');
    assert.equal(decide('Whitepages'), null, 'last removed 200 days ago: due again');
    assert.match(decide('MyLife').reason, /Pending email confirmation/, 'pending 3 days: wait');
    assert.equal(decide('Radaris'), null, 'pending 40 days: retry');
    assert.equal(decide('PeopleFinders'), null, 'only ever "not found": still due');
    assert.match(decide('BeenVerified').reason, /Last removed 10d ago/);
    assert.equal(decide('NeverSeen'), null);
    // The same answers through the literal-key form old callers still use.
    assert.match(cfg.shouldSkip('Spokeo').reason, /Last removed 30d ago/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adding a phone number, a second person, or reformatting the phone does not re-run anyone', () => {
  const { dir, files } = install();
  withState(files, () => {
    const reformatted = { ...PERSON, phone: '+1 919 555 0142' };
    assert.match(cfg.shouldSkip('Spokeo', { person: reformatted, personCount: 1, personIndex: 0 }).reason, /30d ago/);
    const bob = { firstName: 'Bob', lastName: 'Hamilton', email: 'bob@hamilton-apollo.org', zip: '27601' };
    const two = { personCount: 2, persons: [PERSON, bob] };
    assert.match(cfg.shouldSkip('Spokeo', { person: PERSON, personIndex: 0, ...two }).reason, /30d ago/, 'persons[0] keeps its history');
    assert.equal(cfg.shouldSkip('Spokeo', { person: bob, personIndex: 1, ...two }), null, 'the new person has none');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- nothing is lost -----------------------------------------------------------------

test('a write adds to the history and leaves every other entry and key exactly as it was', () => {
  const { dir, files, state: before } = install();
  withState(files, () => {
    cfg.recordSuccess('Whitepages', 'resubmitted', { person: PERSON });
    cfg.recordFailure('PeopleFinders', 'error', { person: PERSON });
  });
  const after = JSON.parse(fs.readFileSync(files.state, 'utf8'));
  for (const name of ['Spokeo', 'MyLife', 'Radaris', 'Intelius', 'BeenVerified']) {
    assert.deepEqual(after.optOuts[name], before.optOuts[name], `${name} untouched`);
  }
  assert.equal(after.optOuts.Whitepages.totalRuns, 3, 'run count carried on from the old entry');
  assert.deepEqual(after.optOuts.Whitepages.history, ['success', 'success']);
  assert.equal(after.optOuts.Whitepages.fp, cfg.personFingerprint(PERSON), 'now stamped');
  assert.deepEqual(after.optOuts.PeopleFinders.history, ['notFound', 'error']);
  assert.deepEqual(after.relayAliases, before.relayAliases);
  assert.deepEqual(after.freezes, before.freezes);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(fs.statSync(files.state).mode & 0o777, 0o600, 'and the file is private from here on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the config round-trips untouched through loadConfig and editConfig', () => {
  const { dir, files, config } = install();
  const loaded = cfg.loadConfig({ configPath: files.config, encPath: files.enc });
  assert.deepEqual(loaded, config);
  cfg.editConfig((c) => ({ ...c, allowlist: ['Spokeo'] }), { configPath: files.config, encPath: files.enc });
  assert.deepEqual(JSON.parse(fs.readFileSync(files.config, 'utf8')), { ...config, allowlist: ['Spokeo'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config.json.enc from the first encryption release (v:1, N=2^14) still decrypts, and re-encrypts as v:2', () => {
  const { dir, files } = install({ legacyEncrypted: true });
  const loaded = cfg.loadConfig({ configPath: files.config, encPath: files.enc, passphrase: LEGACY_PASSPHRASE });
  assert.deepEqual(loaded, LEGACY_PLAIN);
  cfg.editConfig((c) => ({ ...c, allowlist: ['Spokeo'] }), { configPath: files.config, encPath: files.enc, passphrase: LEGACY_PASSPHRASE });
  const env = JSON.parse(fs.readFileSync(files.enc, 'utf8'));
  assert.equal(env.v, 2);
  assert.deepEqual(secrets.decryptConfig(env, LEGACY_PASSPHRASE), { ...LEGACY_PLAIN, allowlist: ['Spokeo'] });
  assert.equal(fs.existsSync(files.config), false, 'no plaintext copy appeared');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encrypting the origin-era config keeps the state and removes only plaintext config copies', () => {
  const { dir, files, config, state } = install();
  fs.writeFileSync(files.config + '.bak', JSON.stringify(config));
  const res = cfg.encryptConfigToDisk({ configPath: files.config, encPath: files.enc, passphrase: 'pw-upgrade', shred: true });
  assert.equal(res.shredded, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json.enc', 'state.json', 'state.json.bak']);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.state, 'utf8')), state);
  assert.deepEqual(secrets.decryptConfig(JSON.parse(fs.readFileSync(files.enc, 'utf8')), 'pw-upgrade'), config);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- every reader accepts it ---------------------------------------------------------

test('config check: no problems, nothing identity-stamped, nothing "for a previous identity"', () => {
  const { dir } = install();
  const r = checkConfig({ env: {}, root: dir });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.info.state, { exists: true, entries: 7, stamped: 0, otherIdentity: 0 });
  assert.equal(r.warnings.filter((w) => /old location|plain text copy|AIDR_HOME/.test(w)).length, 0, r.warnings.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doctor: config and state checks pass on it', async () => {
  const { dir, files } = install();
  const c = await doctor.checkConfig(dir, {});
  assert.equal(c.ok, true, c.hint);
  assert.equal(c.warn, undefined);
  const s = await doctor.checkState(dir, { statePath: files.state });
  assert.equal(s.ok, true, s.hint);
  assert.equal(s.warn, undefined);
  assert.match(s.hint, /7 entries/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('complaints: a bare-key entry with evidence is still overdue for the one configured person', () => {
  const { dir, state } = install();
  state.optOuts.Intelius.lastSuccess = daysAgo(100);
  const out = complaint.findOverdue(state, { persons: [PERSON] });
  assert.deepEqual(out.map((o) => o.broker), ['Intelius']);
  assert.equal(out[0].person, null, 'bare key: attributed to the sole person');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the dashboard serves the origin-era install with the same numbers it always did', async () => {
  const h = await harness.startHarness({
    cfgContent: ORIGIN_CONFIG(),
    stateContent: ORIGIN_STATE(),
    options: { brokers: ['Spokeo', 'Whitepages', 'MyLife', 'Radaris', 'PeopleFinders', 'Intelius', 'BeenVerified'].map((name) => ({ name, method: 'search-form' })), genericBrokers: [] },
  });
  try {
    const summary = await h.request({ pathname: '/api/summary' });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.configured, true);
    assert.equal(summary.json.optedOut, 4, 'Spokeo, Whitepages, Intelius, BeenVerified');
    assert.equal(summary.json.pending, 2, 'MyLife, Radaris');
    const state = await h.request({ pathname: '/api/state' });
    assert.deepEqual(Object.keys(state.json.optOuts).sort(), Object.keys(ORIGIN_STATE().optOuts).sort());
    assert.equal(state.json.optOuts.Spokeo.totalRuns, 4);
    const config = await h.request({ pathname: '/api/config' });
    assert.equal(config.json.config.person.email, PERSON.email);
  } finally {
    await h.close();
  }
});
