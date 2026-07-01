/**
 * test/right-to-know-runner.test.js
 *
 * Covers lib/right-to-know-runner.js sendKnowRequests:
 *   1. smtp configured -> nodemailer sends a know-request email; state recorded
 *   2. no smtp -> logged 'manual' with the template body; state recorded
 *   3. dry-run -> no send, no state write
 *   4. non-email brokers are filtered out
 *
 * Mocks: nodemailer (Module._load), logger.logResult, config helpers - all at
 * the module-object level so the runner's cached requires see the patched
 * versions at call time. No real email/network/disk.
 */

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

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };
const WEB_BROKER = { name: 'WhitePages', method: 'search-form', optOutUrl: 'https://wp.com' };

const origLogResult = loggerMod.logResult;
const origRecordKnow = configMod.recordKnowRequest;
const origGetPersons = configMod.getPersonsFromConfig;

function patchDeps() {
  const logCalls = [];
  const recorded = [];
  const recordedArgs = [];
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });
  configMod.recordKnowRequest = (name, person, totalPersons) => {
    recorded.push(name);
    recordedArgs.push({ name, person, totalPersons });
  };
  configMod.getPersonsFromConfig = (c) => (c.persons && c.persons.length ? c.persons : [c.person]);
  return { logCalls, recorded, recordedArgs };
}

function restoreDeps() {
  loggerMod.logResult = origLogResult;
  configMod.recordKnowRequest = origRecordKnow;
  configMod.getPersonsFromConfig = origGetPersons;
}

const runner = require('../lib/right-to-know-runner');

test('no smtp -> logs manual with template body, records state', async () => {
  const { logCalls, recorded } = patchDeps();
  const cfg = { person: PERSON };

  const result = await runner.sendKnowRequests([EMAIL_BROKER, WEB_BROKER], cfg, {});

  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, `expected manual log, got ${JSON.stringify(logCalls)}`);
  assert.match(manualLog.detail, /CCPA|Right to Know/i);
  assert.deepEqual(result.manual, ['Pipl']);
  assert.deepEqual(recorded, ['Pipl']);
  // Web broker filtered out entirely.
  assert.equal(logCalls.filter(l => l.broker === 'WhitePages').length, 0);
});

test('smtp configured -> nodemailer sends know request, records state', async () => {
  const { logCalls, recorded } = patchDeps();
  const nmCalls = [];
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
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  const freshRunner = require('../lib/right-to-know-runner');

  const smtpCfg = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };
  const result = await freshRunner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  Module._load = origLoad;
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  require('../lib/right-to-know-runner');
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected one sendMail call');
  assert.equal(nmCalls[0].to, 'privacy@pipl.com');
  assert.match(nmCalls[0].subject, /Right to Know/i);
  assert.match(nmCalls[0].text, /CCPA/);
  assert.deepEqual(result.sent, ['Pipl']);
  assert.deepEqual(recorded, ['Pipl']);
  assert.ok(logCalls.find(l => l.broker === 'Pipl' && l.status === 'success'));
});

test('dry-run -> no send, no state record, manual preview only', async () => {
  const { logCalls, recorded } = patchDeps();
  const smtpCfg = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };

  const result = await runner.sendKnowRequests([EMAIL_BROKER], cfg, { dryRun: true });

  restoreDeps();

  assert.deepEqual(recorded, [], 'dry-run must not record state');
  assert.deepEqual(result.sent, [], 'dry-run must not send');
  assert.ok(logCalls.find(l => l.broker === 'Pipl'), 'should still log a preview');
});

test('multi-person -> one request per (broker, person)', async () => {
  const { recorded } = patchDeps();
  const personB = { ...PERSON, fullName: 'John Roe', firstName: 'John', lastName: 'Roe' };
  const cfg = { persons: [PERSON, personB] };

  const result = await runner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  restoreDeps();

  // Manual log per person, state recorded once per broker per person.
  assert.equal(result.manual.length, 2, `expected 2 manual entries, got ${JSON.stringify(result.manual)}`);
  assert.equal(recorded.length, 2);
});

test('B6: recordKnowRequest is threaded the person + person count (multi-person keying)', async () => {
  const { recordedArgs } = patchDeps();
  const personB = { ...PERSON, fullName: 'John Roe', firstName: 'John', lastName: 'Roe' };
  const cfg = { persons: [PERSON, personB] };

  await runner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  restoreDeps();

  assert.equal(recordedArgs.length, 2);
  // Each call carries the specific person and the total count so config.stateKey
  // produces distinct composite keys instead of collapsing onto one bare name.
  assert.equal(recordedArgs[0].totalPersons, 2);
  assert.equal(recordedArgs[1].totalPersons, 2);
  const names = recordedArgs.map(a => a.person && a.person.firstName).sort();
  assert.deepEqual(names, ['Jane', 'John']);
});

test('B6: single-person run threads person count 1 (bare-name keying preserved)', async () => {
  const { recordedArgs } = patchDeps();
  const cfg = { person: PERSON };

  await runner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  restoreDeps();

  assert.equal(recordedArgs.length, 1);
  assert.equal(recordedArgs[0].totalPersons, 1);
});
