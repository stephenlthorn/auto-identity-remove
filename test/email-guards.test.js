// test/email-guards.test.js
/**
 * sendOptOutEmails guards:
 *   CORE-4  opts.include (broker predicate) and the config allowlist
 *   DASH-4  a blank smtp object is "no SMTP", not a send that fails
 *   NET-15  GDPR for EEA/UK, no "undefined" in any template
 *   codex #5 (intentional behaviour kept) the log says "sent", not "removed"
 *
 * nodemailer is mocked through Module._load; nothing leaves the machine.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phoneFormatted: '(512) 555-0000',
  country: 'US',
};

const PIPL = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const ACME = { name: 'Acme', method: 'email', emailTo: 'optout@acme.com' };
const SMTP_CFG = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function harness() {
  const logCalls = [];
  const successCalls = [];
  const nmCalls = [];
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = (key, detail) => successCalls.push({ key, detail });
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return { messageId: 'mock' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const email = require('../lib/email');

  const restore = () => {
    Module._load = origLoad;
    configMod.lastOptOutDaysAgo = origLastOptOut;
    configMod.recordSuccess = origRecordSuccess;
    loggerMod.logResult = origLogResult;
    delete require.cache[require.resolve('../lib/email')];
    require('../lib/email');
  };
  return { email, logCalls, successCalls, nmCalls, restore };
}

// -- CORE-4: opts.include ----------------------------------------------------

test('CORE-4: opts.include skips excluded brokers silently - no mail, no log, no state', async () => {
  const h = harness();
  try {
    await h.email.sendOptOutEmails([PIPL, ACME], { person: PERSON, email: { smtp: SMTP_CFG } }, 'linux', {
      include: (name) => name === 'Pipl',
    });
  } finally { h.restore(); }

  assert.equal(h.nmCalls.length, 1);
  assert.equal(h.nmCalls[0].to, 'removal@pipl.com');
  assert.equal(h.logCalls.filter(l => l.broker === 'Acme').length, 0, 'excluded broker leaves no trace');
  assert.equal(h.successCalls.length, 1);
});

test('CORE-4: no include predicate means every email broker is processed', async () => {
  const h = harness();
  try {
    await h.email.sendOptOutEmails([PIPL, ACME], { person: PERSON, email: { smtp: SMTP_CFG } }, 'linux');
  } finally { h.restore(); }
  assert.equal(h.nmCalls.length, 2);
});

// -- CORE-4: allowlist --------------------------------------------------------

test('CORE-4: an allowlisted email broker is logged allowlisted and never emailed', async () => {
  const h = harness();
  try {
    await h.email.sendOptOutEmails([PIPL, ACME], {
      person: PERSON,
      email: { smtp: SMTP_CFG },
      allowlist: ['  pipl '],
    }, 'linux');
  } finally { h.restore(); }

  assert.equal(h.nmCalls.length, 1, 'only Acme is emailed');
  assert.equal(h.nmCalls[0].to, 'optout@acme.com');
  assert.ok(h.logCalls.some(l => l.broker === 'Pipl' && l.status === 'allowlisted'));
  assert.equal(h.successCalls.filter(s => /Pipl/.test(s.key)).length, 0, 'no cooldown recorded for it');
});

// -- DASH-4: blank smtp -------------------------------------------------------

for (const [label, smtp] of [
  ['empty host', { host: '', port: '', user: '', from: '' }],
  ['whitespace host', { host: '   ', port: 587 }],
  ['missing host', { port: 587, user: 'u@x.com' }],
]) {
  test(`DASH-4: smtp with ${label} behaves as no SMTP (manual, nothing sent)`, async () => {
    const h = harness();
    try {
      await h.email.sendOptOutEmails([PIPL], { person: PERSON, email: { smtp } }, 'linux');
    } finally { h.restore(); }

    assert.equal(h.nmCalls.length, 0);
    assert.ok(h.logCalls.some(l => l.broker === 'Pipl' && l.status === 'manual'));
    assert.equal(h.logCalls.filter(l => l.status === 'error').length, 0, 'no failing send attempted');
  });
}

// -- NET-15: regime + undefined ----------------------------------------------

test('NET-15: Norway (EEA, not EU) and the UK get the GDPR template', () => {
  const h = harness();
  try {
    for (const country of ['NO', 'IS', 'LI', 'GB']) {
      const body = h.email._buildBody({ ...PERSON, country });
      assert.match(body, /General Data Protection Regulation/, `${country} should cite the GDPR`);
    }
  } finally { h.restore(); }
});

test('NET-15: a person with only firstName/lastName never produces "undefined" in subject or body', async () => {
  const h = harness();
  const sparse = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' };
  try {
    await h.email.sendOptOutEmails([PIPL], { person: sparse, email: { smtp: SMTP_CFG } }, 'linux');
  } finally { h.restore(); }

  assert.equal(h.nmCalls.length, 1);
  const { subject, text } = h.nmCalls[0];
  assert.doesNotMatch(subject, /undefined/);
  assert.doesNotMatch(text, /undefined/);
  assert.match(subject, /Jane Doe/);
  assert.match(text, /Name: Jane Doe/);
});

test('NET-15: the GDPR template also survives a sparse person', () => {
  const h = harness();
  try {
    const body = h.email._buildBody({ firstName: 'Max', lastName: 'Mustermann', country: 'DE' });
    assert.doesNotMatch(body, /undefined/);
    assert.match(body, /Name: Max Mustermann/);
  } finally { h.restore(); }
});

// -- codex #5: wording only ---------------------------------------------------

test('codex #5: the success log says an email was sent, and does not claim removal', async () => {
  const h = harness();
  try {
    await h.email.sendOptOutEmails([PIPL], { person: PERSON, email: { smtp: SMTP_CFG } }, 'linux');
  } finally { h.restore(); }

  const ok = h.logCalls.find(l => l.broker === 'Pipl' && l.status === 'success');
  assert.ok(ok, 'SMTP acceptance is still recorded as the re-send marker');
  assert.match(ok.detail, /sent/i);
  assert.match(ok.detail, /removal not confirmed/i);
  assert.doesNotMatch(ok.detail, /removed|opted out|deleted/i);
  assert.equal(h.successCalls.length, 1, 'lastSuccess still starts the re-send window');
});
