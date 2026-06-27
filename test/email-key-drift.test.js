/**
 * test/email-key-drift.test.js
 *
 * Fix 4: sendOptOutEmails must record success under stateKey(broker.name, person,
 * personCount) so multi-person state is keyed the same way broker-runner writes it.
 *
 * Single-person mode: bare broker name (unchanged).
 * Multi-person mode : composite key "BrokerName|First Last".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PERSON_A = {
  fullName: 'Alice Adams',
  firstName: 'Alice',
  lastName: 'Adams',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'alice@example.com',
  phone: '5125550001',
  phoneFormatted: '(512) 555-0001',
};

const PERSON_B = {
  fullName: 'Bob Brown',
  firstName: 'Bob',
  lastName: 'Brown',
  city: 'Denver',
  state: 'CO',
  zip: '80201',
  email: 'bob@example.com',
  phone: '3035550002',
  phoneFormatted: '(303) 555-0002',
};

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function patchDeps(daysAgoValue = 999) {
  const successCalls = [];
  configMod.lastOptOutDaysAgo = () => daysAgoValue;
  configMod.recordSuccess = (key, detail) => successCalls.push({ key, detail });
  loggerMod.logResult = () => {};
  return successCalls;
}

function restoreDeps() {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
}

function loadFreshEmailWithSmtpMock() {
  const nmCalls = [];
  const origLoad = Module._load;
  // Keep Module._load patched until restore() is called so the lazy
  // require('nodemailer') inside _sendViaSMTP hits the mock at call time.
  Module._load = function(request, parent, isMain) {
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
  const freshEmail = require('../lib/email');
  function restore() {
    Module._load = origLoad;
    delete require.cache[require.resolve('../lib/email')];
  }
  return { freshEmail, nmCalls, restore };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const SMTP_CFG = { host: 'smtp.test', port: 587, user: 'u', pass: 'p' };

test('Fix 4: single-person mode records success under bare broker name', async () => {
  const successCalls = patchDeps();
  const { freshEmail, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON_A, email: { smtp: SMTP_CFG } };

  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, undefined, {});

  restore();
  restoreDeps();

  assert.equal(successCalls.length, 1, 'Expected 1 recordSuccess call');
  // Single person -> bare name (no composite key)
  assert.equal(successCalls[0].key, 'Pipl', `Expected bare name, got: ${successCalls[0].key}`);
});

test('Fix 4: multi-person mode records success under composite key "Broker|First Last"', async () => {
  const successCalls = patchDeps();
  const { freshEmail, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { persons: [PERSON_A, PERSON_B], email: { smtp: SMTP_CFG } };

  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, undefined, {});

  restore();
  restoreDeps();

  assert.equal(successCalls.length, 2, 'Expected 2 recordSuccess calls (one per person)');
  const keys = successCalls.map(c => c.key);
  assert.ok(keys.includes('Pipl|Alice Adams'), `Expected composite key for Alice, got: ${keys}`);
  assert.ok(keys.includes('Pipl|Bob Brown'), `Expected composite key for Bob, got: ${keys}`);
});

test('Fix 4: persons array with one element uses bare broker name (personCount=1)', async () => {
  // When cfg.persons = [singlePerson] (array with 1 element), personCount = 1.
  // stateKey(name, person, 1) returns bare name per stateKey's rule.
  const successCalls = patchDeps();
  const { freshEmail, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { persons: [PERSON_A], email: { smtp: SMTP_CFG } };

  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, undefined, {});

  restore();
  restoreDeps();

  assert.equal(successCalls.length, 1, 'Expected 1 recordSuccess call');
  // persons.length = 1, so stateKey returns bare name
  assert.equal(successCalls[0].key, 'Pipl', `Expected bare name for single-element array, got: ${successCalls[0].key}`);
});
