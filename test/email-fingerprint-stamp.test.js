/**
 * test/email-fingerprint-stamp.test.js
 *
 * R5: an opt-out email that left is recorded as a success for the person it was
 * sent for, and the entry is stamped with that person's identity fingerprint so a
 * corrected address or phone invalidates it. The email path called recordSuccess
 * with the key and a detail only. One person gets one stamp per recipient, and the
 * stamp is the person the email was FOR, not persons[0].
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const ALICE = { fullName: 'Alice Adams', firstName: 'Alice', lastName: 'Adams', city: 'Austin', state: 'TX', zip: '73301', email: 'alice@example.com', phone: '5125550001', phoneFormatted: '(512) 555-0001' };
const BOB = { fullName: 'Bob Brown', firstName: 'Bob', lastName: 'Brown', city: 'Denver', state: 'CO', zip: '80201', email: 'bob@example.com', phone: '3035550002', phoneFormatted: '(303) 555-0002' };
const BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const SMTP = { host: 'smtp.test', port: 587, user: 'u', pass: 'p' };

async function sendWithStubs(cfg) {
  const calls = [];
  const originals = [configMod.lastOptOutDaysAgo, configMod.recordSuccess, loggerMod.logResult];
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = (key, detail, opts) => calls.push({ key, detail, opts });
  loggerMod.logResult = () => {};
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'nodemailer') return { createTransport: () => ({ sendMail: async () => ({ messageId: 'mock' }) }) };
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  try {
    await require('../lib/email').sendOptOutEmails([BROKER], cfg, undefined, {});
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../lib/email')];
    [configMod.lastOptOutDaysAgo, configMod.recordSuccess, loggerMod.logResult] = originals;
  }
  return calls;
}

test('a single person\'s email success carries that person', async () => {
  const calls = await sendWithStubs({ person: ALICE, email: { smtp: SMTP } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.person, ALICE);
});

test('each person in a household gets their own stamp', async () => {
  const calls = await sendWithStubs({ persons: [ALICE, BOB], email: { smtp: SMTP } });
  const byKey = Object.fromEntries(calls.map(c => [c.key, c.opts.person]));
  assert.equal(byKey['Pipl|Alice Adams'], ALICE);
  assert.equal(byKey['Pipl|Bob Brown'], BOB);
});
