/**
 * test/email.test.js
 *
 * Covers lib/email.js sendOptOutEmails routing:
 *   1. any OS + smtp set → nodemailer (_sendViaSMTP)
 *   2. any OS + no smtp  → brokers logged as 'manual' (no osascript/Mail.app)
 *
 * Mocks: nodemailer (via Module._load), logger.logResult, config.lastOptOutDaysAgo
 * No real email or network traffic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phone: '5125550000',
  phoneFormatted: '(512) 555-0000',
};

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const NON_EMAIL_BROKER = { name: 'WhitePages', method: 'web', optOutUrl: 'https://wp.com/optout' };

// ── Module stubs ──────────────────────────────────────────────────────────────

// Patch config and logger at the module-object level so all cached copies
// of email.js that import them get the patched versions at call-time.
const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function patchDeps(daysAgoValue = 999) {
  const logCalls = [];
  configMod.lastOptOutDaysAgo = () => daysAgoValue;
  configMod.recordSuccess = () => {};
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });
  return logCalls;
}

function restoreDeps() {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
}

// Require the email module once (cached). Tests use patchDeps / restoreDeps.
const emailMod = require('../lib/email');

// ─── Test 1: macOS + no smtp → manual (no Mail.app / osascript) ──────────────

test('macOS + no smtp → logs manual (SMTP required on all platforms)', async () => {
  const logCalls = patchDeps(999);

  const cfg = { person: PERSON }; // no cfg.email.smtp
  await emailMod.sendOptOutEmails([EMAIL_BROKER, NON_EMAIL_BROKER], cfg, 'darwin');

  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, `expected manual log for Pipl, got: ${JSON.stringify(logCalls)}`);
  assert.ok(manualLog.detail.includes('removal@pipl.com'), 'detail should include emailTo');

  // Non-email broker filtered out — no log entries for it
  assert.equal(logCalls.filter(l => l.broker === 'WhitePages').length, 0);
});

// ─── Test 2: smtp configured → nodemailer ────────────────────────────────────

test('smtp configured → nodemailer branch attempted (lazy require mocked)', async () => {
  const logCalls = patchDeps(999);
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

  // Clear email.js from cache so the lazy `require('nodemailer')` inside
  // _sendViaSMTP goes through our patched Module._load this time.
  delete require.cache[require.resolve('../lib/email')];
  const freshEmail = require('../lib/email');

  const smtpCfg = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  Module._load = origLoad;
  // Restore cache to the version without a pre-loaded nodemailer
  delete require.cache[require.resolve('../lib/email')];
  require('../lib/email'); // re-cache fresh copy for subsequent tests

  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected one nodemailer sendMail call');
  assert.equal(nmCalls[0].to, 'removal@pipl.com');
  assert.ok(nmCalls[0].subject.includes('Jane Doe'));

  const successLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'success');
  assert.ok(successLog, 'expected success log via SMTP path');
});

// ─── Test 3: linux + no smtp → manual ────────────────────────────────────────

test('linux + no smtp → brokers logged as manual with email address hint', async () => {
  const logCalls = patchDeps(999);

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'linux');

  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, `expected manual log for Pipl, got: ${JSON.stringify(logCalls)}`);
  assert.ok(manualLog.detail.includes('removal@pipl.com'), 'detail should include emailTo');
});

test('windows + no smtp → brokers logged as manual', async () => {
  const logCalls = patchDeps(999);

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'win32');

  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, 'expected manual log on windows without smtp');
});

// ─── Test 4: recheck-window skip ─────────────────────────────────────────────

test('broker within recheck window is skipped regardless of platform', async () => {
  // daysAgoValue = 0 → within RECHECK_DAYS (90)
  const logCalls = patchDeps(0);

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'darwin');

  restoreDeps();

  const skippedLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'skipped');
  assert.ok(skippedLog, `expected skipped log for recently opted-out broker, got: ${JSON.stringify(logCalls)}`);
});

// ─── Test 5: _buildBody ───────────────────────────────────────────────────────

test('_buildBody includes all person fields', () => {
  const body = emailMod._buildBody(PERSON);
  assert.ok(body.includes('Jane Doe'));
  assert.ok(body.includes('Austin'));
  assert.ok(body.includes('TX'));
  assert.ok(body.includes('jane@example.com'));
  assert.ok(body.includes('(512) 555-0000'));
});

// ─── Tests 7-12: GDPR / CCPA template routing ────────────────────────────────

test('_pickTemplate returns GDPR builder for EU country DE', () => {
  const builder = emailMod._pickTemplate('DE');
  assert.equal(typeof builder, 'function', '_pickTemplate should return a function');
  const body = builder(PERSON);
  assert.ok(body.includes('Article 17'), 'GDPR body should cite Article 17');
});

test('_pickTemplate returns CCPA builder for US', () => {
  const builder = emailMod._pickTemplate('US');
  assert.equal(typeof builder, 'function', '_pickTemplate should return a function');
  const body = builder(PERSON);
  assert.ok(body.includes('CCPA'), 'CCPA body should mention CCPA');
});

test('_pickTemplate returns GDPR builder for GB (UK GDPR)', () => {
  const builder = emailMod._pickTemplate('GB');
  const body = builder(PERSON);
  assert.ok(body.includes('Article 17'), 'GB should get GDPR body citing Article 17');
});

test('_buildBodyGDPR includes Article 17 and person fields', () => {
  const body = emailMod._buildBodyGDPR(PERSON);
  assert.ok(body.includes('Article 17'), 'GDPR body must cite Article 17');
  assert.ok(body.includes('Jane Doe'), 'GDPR body must include fullName');
  assert.ok(body.includes('Austin'), 'GDPR body must include city');
  assert.ok(body.includes('TX'), 'GDPR body must include state');
  assert.ok(body.includes('jane@example.com'), 'GDPR body must include email');
  assert.ok(body.includes('(512) 555-0000'), 'GDPR body must include phone');
});

test('_buildBodyCCPA includes CCPA and person fields', () => {
  const body = emailMod._buildBodyCCPA(PERSON);
  assert.ok(body.includes('CCPA'), 'CCPA body must mention CCPA');
  assert.ok(body.includes('Jane Doe'), 'CCPA body must include fullName');
  assert.ok(body.includes('Austin'), 'CCPA body must include city');
  assert.ok(body.includes('TX'), 'CCPA body must include state');
  assert.ok(body.includes('jane@example.com'), 'CCPA body must include email');
  assert.ok(body.includes('(512) 555-0000'), 'CCPA body must include phone');
});

test('_pickTemplate with undefined country falls back to CCPA', () => {
  const builder = emailMod._pickTemplate(undefined);
  const body = builder(PERSON);
  assert.ok(body.includes('CCPA'), 'undefined country should use CCPA template');
});

// ─── Test 6: macOS + smtp → uses SMTP not Mail.app ───────────────────────────

test('macOS + smtp configured → uses SMTP', async () => {
  const logCalls = patchDeps(999);
  const nmCalls = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return {}; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve('../lib/email')];
  const freshEmail = require('../lib/email');

  const smtpCfg = { host: 'smtp.x.com', port: 465, user: 'u@x.com', pass: 'pw' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'darwin');

  Module._load = origLoad;
  delete require.cache[require.resolve('../lib/email')];
  require('../lib/email');

  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected nodemailer call on macOS with smtp');
});
