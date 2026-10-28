/**
 * test/email-subject-prefix.test.js
 *
 * Hiya routes personal-data deletion mail by subject: its help article says the
 * subject line must start with "Advanced Data Management". A broker entry can
 * now set `emailSubjectPrefix`; every other broker keeps the default subject.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = {
  fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe',
  city: 'Austin', state: 'TX', zip: '73301',
  email: 'jane@example.com', phone: '5125550000', phoneFormatted: '(512) 555-0000',
};
const SMTP = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

async function sendAndCapture(broker) {
  const orig = {
    lastOptOutDaysAgo: configMod.lastOptOutDaysAgo,
    recordSuccess: configMod.recordSuccess,
    logResult: loggerMod.logResult,
  };
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = () => {};
  loggerMod.logResult = () => {};

  const sent = [];
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'nodemailer') {
      return { createTransport: () => ({ sendMail: async (o) => { sent.push(o); return { messageId: 'mock' }; } }) };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  try {
    await require('../lib/email').sendOptOutEmails([broker], { person: PERSON, email: { smtp: SMTP } }, 'linux');
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../lib/email')];
    Object.assign(configMod, { lastOptOutDaysAgo: orig.lastOptOutDaysAgo, recordSuccess: orig.recordSuccess });
    loggerMod.logResult = orig.logResult;
  }
  assert.equal(sent.length, 1, 'expected exactly one email');
  return sent[0];
}

test('emailSubjectPrefix starts the subject line', async () => {
  const mail = await sendAndCapture({
    name: 'Hiya', method: 'email', emailTo: 'DPO@hiya.com', emailSubjectPrefix: 'Advanced Data Management',
  });
  assert.ok(mail.subject.startsWith('Advanced Data Management'), mail.subject);
  assert.ok(mail.subject.includes('Jane Doe'));
});

test('brokers without a prefix keep the default subject', async () => {
  const mail = await sendAndCapture({ name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' });
  assert.equal(mail.subject, 'Personal Data Removal Request - Jane Doe');
});

test('without SMTP the manual hint tells the user the required subject', async () => {
  const logs = [];
  const origLog = loggerMod.logResult;
  const origDays = configMod.lastOptOutDaysAgo;
  loggerMod.logResult = (broker, status, detail) => logs.push({ broker, status, detail });
  configMod.lastOptOutDaysAgo = () => 999;
  try {
    await require('../lib/email').sendOptOutEmails(
      [{ name: 'Hiya', method: 'email', emailTo: 'DPO@hiya.com', emailSubjectPrefix: 'Advanced Data Management' }],
      { person: PERSON },
      'linux',
    );
  } finally {
    loggerMod.logResult = origLog;
    configMod.lastOptOutDaysAgo = origDays;
  }
  const manual = logs.find(l => l.status === 'manual');
  assert.ok(manual, JSON.stringify(logs));
  assert.match(manual.detail, /DPO@hiya\.com/);
  assert.match(manual.detail, /subject must start "Advanced Data Management"/);
});

test('the removal email states the phone number', async () => {
  const mail = await sendAndCapture({ name: 'Eyecon', method: 'email', emailTo: 'privacy@instabridge.com' });
  assert.match(mail.text || '', /\(512\) 555-0000/);
});
