/**
 * test/relay-sender-warning.test.js
 *
 * BRK2-7 refuses to send an opt-out email when a relay is on and the From address
 * (email.smtp.from, else the login email.smtp.user) is one of the persons' real
 * addresses, because the relay only replaces the address in the body and Reply-To.
 * That refusal shows up at run time, one error per email broker, months after
 * setup. `aidr config check` and `aidr doctor` now say it up front, and the docs
 * say what email.smtp.from has to be: a dedicated sending address.
 *
 * Nothing in the output may carry the address itself: config-check output is pasted
 * into bug reports.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { relaySenderWarning } = require('../lib/email');
const { checkConfig, formatConfigCheck } = require('../lib/config-check');
const { checkSMTP } = require('../lib/doctor');
const h = require('./config-check-helpers');

const REAL = h.person().email;
const smtp = (over = {}) => ({ host: 'smtp.example.net', user: 'smtp-user-zq', pass: 'smtp-secret-pass-90210', from: 'zq@example.net', ...over });
const relay = { provider: 'simplelogin', apiKey: 'relay-secret-key-55231' };

function check(config) {
  const root = h.makeRoot();
  try {
    h.writePlain(root, config);
    const result = checkConfig({ env: {}, root });
    return { result, text: h.everything(result, formatConfigCheck) };
  } finally {
    h.cleanup(root);
  }
}

// ── the shared test ───────────────────────────────────────────────────────────

test('a relay with smtp.from set to a person\'s real address is a warning', () => {
  const cfg = { relay, email: { smtp: smtp({ from: REAL }) } };
  const warning = relaySenderWarning(cfg, [h.person()]);
  assert.ok(warning, 'expected a warning');
  assert.match(warning, /email\.smtp\.from/);
  assert.match(warning, /dedicated/);
  assert.match(warning, /refused/, 'says what happens to the email opt-outs');
  assert.ok(!warning.includes(REAL), 'never the address itself');
});

test('smtp.user is the sender when smtp.from is blank, and the display-name form is read too', () => {
  assert.ok(relaySenderWarning({ relay, email: { smtp: smtp({ from: '', user: REAL }) } }, [h.person()]));
  assert.ok(relaySenderWarning({ relay, email: { smtp: smtp({ from: `Zeb Q <${REAL.toUpperCase()}>` }) } }, [h.person()]));
});

test('any configured person counts, not only the first', () => {
  const second = h.person({ firstName: 'Ada', lastName: 'Byron', fullName: 'Ada Byron', email: 'ada.byron@example.net' });
  assert.ok(relaySenderWarning({ relay, email: { smtp: smtp({ from: 'ada.byron@example.net' }) } }, [h.person(), second]));
});

test('relay.failOpen changes what the warning says will happen, not whether it appears', () => {
  const warning = relaySenderWarning({ relay: { ...relay, failOpen: true }, email: { smtp: smtp({ from: REAL }) } }, [h.person()]);
  assert.match(warning, /failOpen/);
  assert.doesNotMatch(warning, /refused/);
});

test('no warning without a relay, with a dedicated sender, or when no SMTP host is set', () => {
  assert.equal(relaySenderWarning({ email: { smtp: smtp({ from: REAL }) } }, [h.person()]), null, 'no relay: the real address is what was asked for');
  assert.equal(relaySenderWarning({ relay, email: { smtp: smtp() } }, [h.person()]), null, 'a dedicated sender');
  assert.equal(relaySenderWarning({ relay, email: { smtp: smtp({ host: '', from: REAL }) } }, [h.person()]), null, 'nothing is sent by SMTP');
  assert.equal(relaySenderWarning({ relay }, [h.person()]), null);
  assert.equal(relaySenderWarning({}, []), null);
});

// ── aidr config check ─────────────────────────────────────────────────────────

test('config check warns, without failing, when the sender is a real address and a relay is set', () => {
  const { result, text } = check(h.goodConfig({ relay, email: { smtp: smtp({ from: REAL }) } }));
  assert.equal(result.ok, true, 'it is a warning: the run refuses email brokers, it does not crash');
  const warning = result.warnings.find(w => /email\.smtp\.from/.test(w));
  assert.ok(warning, result.warnings.join('\n'));
  assert.match(warning, /dedicated/);
  assert.ok(!text.includes(REAL), 'the address never reaches the pasteable output');
});

test('config check is quiet about the sender when it is dedicated', () => {
  const { result } = check(h.goodConfig({ relay, email: { smtp: smtp() } }));
  assert.deepEqual(result.warnings.filter(w => /email\.smtp\.from/.test(w)), []);
});

// ── aidr doctor ───────────────────────────────────────────────────────────────

test('doctor marks the smtp check as a warning, not a failure, and names the fix', async () => {
  const r = await checkSMTP({ person: h.person(), relay, email: { smtp: smtp({ from: REAL }) } }, { tcpProbe: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.hint, /reachable/);
  assert.match(r.hint, /email\.smtp\.from/);
  assert.match(r.hint, /dedicated/);
  assert.ok(!r.hint.includes(REAL));
});

test('doctor says the same when the server cannot be reached, and stays a failure', async () => {
  const r = await checkSMTP({ person: h.person(), relay, email: { smtp: smtp({ from: REAL }) } }, { tcpProbe: async () => { throw new Error('timeout'); } });
  assert.equal(r.ok, false);
  assert.match(r.hint, /unreachable/);
  assert.match(r.hint, /dedicated/);
});

test('doctor is unchanged for a dedicated sender', async () => {
  const r = await checkSMTP({ person: h.person(), relay, email: { smtp: smtp() } }, { tcpProbe: async () => true });
  assert.deepEqual(r, { ok: true, hint: 'smtp.example.net:587 reachable' });
});

// ── docs ──────────────────────────────────────────────────────────────────────

test('docs/relay.md says email.smtp.from must be a dedicated sending address', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'relay.md'), 'utf8');
  assert.match(doc, /email\.smtp\.from/);
  assert.match(doc, /dedicated/);
  assert.match(doc, /From header/);
  assert.match(doc, /config check/);
});

test('config.example.json says it where the relay and smtp blocks are set', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.match(example.relay._comment, /smtp\.from/);
  assert.match(example.relay._comment, /dedicated/);
});
