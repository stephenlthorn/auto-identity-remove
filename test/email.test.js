/**
 * test/email.test.js
 *
 * Covers lib/email.js sendOptOutEmails routing:
 *   1. macOS + no smtp   → Mail.app via osascript (_sendViaMailApp)
 *   2. any OS + smtp set → nodemailer branch attempted (_sendViaSMTP)
 *   3. non-mac + no smtp → brokers logged as 'manual'
 *
 * Mocks: child_process.execSync (via module-object patch), nodemailer, logger.logResult
 * No real email or network traffic.
 *
 * Design: email.js calls cp.execSync(...) through the module reference so
 * patching childProcess.execSync on the required module intercepts correctly.
 * We do NOT clear the email.js cache except for the SMTP test where we must
 * swap out nodemailer via Module._load — and we patch configMod/loggerMod
 * at the object level so fresh email.js loads pick them up too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
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

/** Capture all childProcess.execSync calls; restore on teardown. */
function stubExecSync() {
  const calls = [];
  const orig = childProcess.execSync;
  childProcess.execSync = (...args) => { calls.push(args[0]); };
  return { calls, restore: () => { childProcess.execSync = orig; } };
}

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

// ─── Test 1: macOS + no smtp → Mail.app ──────────────────────────────────────

test('macOS + no smtp → calls osascript (Mail.app) and logs success', async () => {
  const logCalls = patchDeps(999);
  const exec = stubExecSync();

  const cfg = { person: PERSON }; // no cfg.email.smtp
  await emailMod.sendOptOutEmails([EMAIL_BROKER, NON_EMAIL_BROKER], cfg, 'darwin');

  exec.restore();
  restoreDeps();

  const osaCalls = exec.calls.filter(c => c.includes('osascript'));
  assert.ok(osaCalls.length >= 1, `expected osascript call, got: ${JSON.stringify(exec.calls)}`);
  assert.ok(osaCalls.some(c => c.includes('Mail')), 'osascript should reference Mail');

  const successLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'success');
  assert.ok(successLog, `expected success log for Pipl, got: ${JSON.stringify(logCalls)}`);
  assert.ok(successLog.detail.includes('removal@pipl.com'));

  // Non-email broker filtered out — no log entries for it
  assert.equal(logCalls.filter(l => l.broker === 'WhitePages').length, 0);
});

// ─── Test 2: smtp configured → nodemailer ────────────────────────────────────

test('smtp configured → nodemailer branch attempted (lazy require mocked)', async () => {
  const logCalls = patchDeps(999);
  const exec = stubExecSync();

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

  exec.restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected one nodemailer sendMail call');
  assert.equal(nmCalls[0].to, 'removal@pipl.com');
  assert.ok(nmCalls[0].subject.includes('Jane Doe'));

  const successLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'success');
  assert.ok(successLog, 'expected success log via SMTP path');
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
});

// ─── Test 3: linux + no smtp → manual ────────────────────────────────────────

test('linux + no smtp → brokers logged as manual with email address hint', async () => {
  const logCalls = patchDeps(999);
  const exec = stubExecSync();

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'linux');

  exec.restore();
  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, `expected manual log for Pipl, got: ${JSON.stringify(logCalls)}`);
  assert.ok(manualLog.detail.includes('removal@pipl.com'), 'detail should include emailTo');
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
});

test('windows + no smtp → brokers logged as manual', async () => {
  const logCalls = patchDeps(999);
  const exec = stubExecSync();

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'win32');

  exec.restore();
  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, 'expected manual log on windows without smtp');
});

// ─── Test 4: recheck-window skip ─────────────────────────────────────────────

test('broker within recheck window is skipped regardless of platform', async () => {
  // daysAgoValue = 0 → within RECHECK_DAYS (90)
  const logCalls = patchDeps(0);
  const exec = stubExecSync();

  await emailMod.sendOptOutEmails([EMAIL_BROKER], { person: PERSON }, 'darwin');

  exec.restore();
  restoreDeps();

  const skippedLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'skipped');
  assert.ok(skippedLog, `expected skipped log for recently opted-out broker, got: ${JSON.stringify(logCalls)}`);
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
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

// ─── Test 6: macOS + smtp → uses SMTP not Mail.app ───────────────────────────

test('macOS + smtp configured → uses SMTP, not Mail.app', async () => {
  const logCalls = patchDeps(999);
  const exec = stubExecSync();

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

  exec.restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected nodemailer call on macOS with smtp');
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
});
