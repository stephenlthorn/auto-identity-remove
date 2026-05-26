/**
 * test/email-multi-person.test.js
 *
 * Covers the multi-person path of sendOptOutEmails:
 *   - cfg.person (single-person) sends email for that one person
 *   - cfg.persons (array) sends one email per person per broker
 *   - cfg.persons empty + cfg.person present falls back to person
 *   - neither cfg.person nor cfg.persons: no emails, no error
 */

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
const EMAIL_BROKER_2 = { name: 'SpokeoEmail', method: 'email', emailTo: 'optout@spokeo.com' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function patchDeps(daysAgoValue = 999) {
  configMod.lastOptOutDaysAgo = () => daysAgoValue;
  configMod.recordSuccess = () => {};
  const logCalls = [];
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });
  return logCalls;
}

function restoreDeps() {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
}

/**
 * Load a fresh copy of email.js with a mocked nodemailer that records sendMail calls.
 * Returns { freshEmail, nmCalls, restore }.
 */
function loadFreshEmailWithSmtpMock() {
  const nmCalls = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
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
    require('../lib/email');
  }
  return { freshEmail, nmCalls, restore };
}

const SMTP_CFG = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

// ── Tests ─────────────────────────────────────────────────────────────────────

test('cfg.person (single-person) sends one email with that person\'s name', async () => {
  const logCalls = patchDeps(999);
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON_A, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected exactly one sendMail call');
  assert.ok(nmCalls[0].subject.includes('Alice Adams'), 'subject should include person A fullName');
  assert.ok(nmCalls[0].text.includes('Alice Adams'), 'body should include person A fullName');
  assert.equal(nmCalls[0].to, 'removal@pipl.com');
});

test('cfg.persons with two people sends two emails (one per person) per broker', async () => {
  const logCalls = patchDeps(999);
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { persons: [PERSON_A, PERSON_B], email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 2, 'expected two sendMail calls (one per person)');
  const subjects = nmCalls.map(c => c.subject);
  assert.ok(subjects.some(s => s.includes('Alice Adams')), 'expected email for Alice Adams');
  assert.ok(subjects.some(s => s.includes('Bob Brown')), 'expected email for Bob Brown');
});

test('cfg.persons with two people and two brokers sends four emails total', async () => {
  const logCalls = patchDeps(999);
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { persons: [PERSON_A, PERSON_B], email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER, EMAIL_BROKER_2], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 4, 'expected 4 sendMail calls (2 persons x 2 brokers)');
  const aliceMails = nmCalls.filter(c => c.subject.includes('Alice Adams'));
  const bobMails = nmCalls.filter(c => c.subject.includes('Bob Brown'));
  assert.equal(aliceMails.length, 2, 'expected two emails for Alice (one per broker)');
  assert.equal(bobMails.length, 2, 'expected two emails for Bob (one per broker)');
});

test('cfg.persons empty array with cfg.person falls back to single person', async () => {
  const logCalls = patchDeps(999);
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  // persons is empty array - should fall back to person
  const cfg = { persons: [], person: PERSON_A, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected fallback to single person when persons is empty');
  assert.ok(nmCalls[0].subject.includes('Alice Adams'), 'expected fallback person name in subject');
});

test('neither cfg.person nor cfg.persons: no emails sent and no error thrown', async () => {
  const logCalls = patchDeps(999);
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { email: { smtp: SMTP_CFG } };
  await assert.doesNotReject(
    () => freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux'),
    'sendOptOutEmails should not throw when neither person nor persons is set'
  );

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 0, 'expected zero emails when no person configured');
});

test('cfg.persons (no smtp) logs manual for each person per broker', async () => {
  const logCalls = patchDeps(999);

  const emailMod = require('../lib/email');
  const cfg = { persons: [PERSON_A, PERSON_B] }; // no smtp
  await emailMod.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restoreDeps();

  // Each person should produce one manual log for Pipl
  const manualLogs = logCalls.filter(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.equal(manualLogs.length, 2, 'expected two manual log entries (one per person)');
});
