// test/right-to-know-send-guards.test.js
/**
 * NET-11 / DASH-4 / NET-15 for lib/right-to-know-runner.js:
 *   - a know request is recorded only after a real send (never for "manual")
 *   - a request sent inside its response window is not sent again
 *   - the relay alias is advertised instead of the real address
 *   - dryRun sends and records nothing
 *   - a blank email.smtp object is "no SMTP"
 *   - no "Phone: undefined" / "Name: undefined"
 *
 * State is the REAL config module pointed at a temp file, so "recorded" and
 * "sent recently" are exercised end to end. nodemailer is mocked; nothing is
 * sent.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const PERSON = {
  firstName: 'Jane', lastName: 'Doe', city: 'Austin', state: 'TX', zip: '73301',
  email: 'jane@example.com', country: 'US',
};
const PERSON_B = { ...PERSON, firstName: 'John', lastName: 'Roe', email: 'john@example.com' };
const DE_PERSON = {
  firstName: 'Max', lastName: 'Mustermann', city: 'Berlin', state: 'BE', zip: '10115',
  email: 'max@example.de', country: 'DE',
};
const PIPL = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };
const SMTP = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

const origLogResult = loggerMod.logResult;
let tmpDir;
let logCalls;
let sendCalls;
let origLoad;
let runner;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-know-'));
  configMod.setTestStatePath(path.join(tmpDir, 'state.json'));
  configMod.resetState();
  logCalls = [];
  sendCalls = [];
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });

  origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { sendCalls.push(opts); return { messageId: 'mock' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  runner = require('../lib/right-to-know-runner');
});

afterEach(() => {
  Module._load = origLoad;
  loggerMod.logResult = origLogResult;
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  configMod.setTestStatePath(null);
  configMod.resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const knowTimestamp = (key) => (configMod.loadState().optOuts[key] || {}).knowRequestedAt;

test('NET-11: with no SMTP the request is printed, NOT recorded as sent', async () => {
  const result = await runner.sendKnowRequests([PIPL], { person: PERSON }, {});

  assert.deepEqual(result.manual, ['Pipl']);
  assert.deepEqual(result.sent, []);
  assert.equal(knowTimestamp('Pipl'), undefined, 'nothing was sent, so no timer may start');
  assert.ok(logCalls.some(l => l.status === 'manual'));
});

test('DASH-4: a blank smtp object is treated as no SMTP', async () => {
  const cfg = { person: PERSON, email: { smtp: { host: '', port: '', user: '', from: '' } } };
  const result = await runner.sendKnowRequests([PIPL], cfg, {});

  assert.equal(sendCalls.length, 0);
  assert.deepEqual(result.manual, ['Pipl']);
  assert.deepEqual(result.errors, []);
  assert.equal(knowTimestamp('Pipl'), undefined);
});

test('NET-11: a second run inside the response window sends zero emails', async () => {
  const cfg = { person: PERSON, email: { smtp: SMTP } };

  const first = await runner.sendKnowRequests([PIPL], cfg, {});
  assert.deepEqual(first.sent, ['Pipl']);
  assert.equal(sendCalls.length, 1);
  const stamp = knowTimestamp('Pipl');
  assert.ok(stamp, 'a real send records the request');

  const second = await runner.sendKnowRequests([PIPL], cfg, {});
  assert.equal(sendCalls.length, 1, 'no second email');
  assert.deepEqual(second.sent, []);
  assert.deepEqual(second.skipped, ['Pipl']);
  assert.equal(knowTimestamp('Pipl'), stamp, 'the timer is not reset');
  assert.ok(logCalls.some(l => l.broker === 'Pipl' && l.status === 'skipped'));
});

test('NET-11: once the response window has passed the request may be sent again', async () => {
  const old = new Date(Date.now() - 50 * 86400000).toISOString();
  configMod.loadState().optOuts.Pipl = { knowRequestedAt: old };

  const result = await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});
  assert.deepEqual(result.sent, ['Pipl']);
});

test('NET-11: the window is 30 days for a GDPR resident', async () => {
  const thirtyFiveDays = new Date(Date.now() - 35 * 86400000).toISOString();
  configMod.loadState().optOuts.Pipl = { knowRequestedAt: thirtyFiveDays };

  const gdpr = await runner.sendKnowRequests([PIPL], { person: DE_PERSON, email: { smtp: SMTP } }, {});
  assert.deepEqual(gdpr.sent, ['Pipl'], '35 days is past the 30-day GDPR window');

  configMod.loadState().optOuts.Pipl = { knowRequestedAt: thirtyFiveDays };
  const generic = await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});
  assert.deepEqual(generic.sent, [], '35 days is inside the 45-day window for everyone else');
});

test('NET-11: multi-person recency is per person', async () => {
  const cfg = { persons: [PERSON, PERSON_B], email: { smtp: SMTP } };
  configMod.loadState().optOuts['Pipl|Jane Doe'] = { knowRequestedAt: new Date().toISOString() };

  const result = await runner.sendKnowRequests([PIPL], cfg, {});
  assert.equal(sendCalls.length, 1, 'only John is sent');
  assert.match(sendCalls[0].subject, /John Roe/);
  assert.ok(knowTimestamp('Pipl|John Roe'));
});

test('NET-11: the relay alias is advertised instead of the real address', async () => {
  const cfg = { person: PERSON, email: { smtp: SMTP } };
  await runner.sendKnowRequests([PIPL], cfg, {
    submissionEmailFor: () => 'jane.masked@aliases.simplelogin.io',
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].replyTo, 'jane.masked@aliases.simplelogin.io');
  assert.match(sendCalls[0].text, /jane\.masked@aliases\.simplelogin\.io/);
  assert.doesNotMatch(sendCalls[0].text, /jane@example\.com/);
});

test('NET-11: without a relay the real address is used and replyTo is omitted', async () => {
  await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});
  assert.match(sendCalls[0].text, /jane@example\.com/);
  assert.equal(sendCalls[0].replyTo, undefined);
});

test('NET-11: dryRun sends nothing, records nothing, and still previews', async () => {
  const result = await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, { dryRun: true });

  assert.equal(sendCalls.length, 0);
  assert.deepEqual(result.sent, []);
  assert.equal(knowTimestamp('Pipl'), undefined);
  assert.ok(logCalls.some(l => l.broker === 'Pipl' && /preview/.test(l.detail)));
});

test('NET-11: a failed send is not recorded', async () => {
  Module._load = function (request) {
    if (request === 'nodemailer') {
      return { createTransport: () => ({ sendMail: async () => { throw new Error('550 rejected'); } }) };
    }
    return origLoad.apply(this, arguments);
  };
  const result = await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});

  assert.equal(result.errors.length, 1);
  assert.equal(knowTimestamp('Pipl'), undefined);
});

test('NET-11 / NET-15: a person with no phone and no fullName never prints undefined', async () => {
  await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});

  assert.equal(sendCalls.length, 1);
  assert.doesNotMatch(sendCalls[0].subject, /undefined/);
  assert.doesNotMatch(sendCalls[0].text, /undefined/);
  assert.doesNotMatch(sendCalls[0].text, /Phone:/);
  assert.match(sendCalls[0].text, /Name: Jane Doe/);
});

test('NET-15: a Texas resident is not sent CCPA wording', async () => {
  await runner.sendKnowRequests([PIPL], { person: PERSON, email: { smtp: SMTP } }, {});
  assert.doesNotMatch(sendCalls[0].text, /CCPA|California/);
});
