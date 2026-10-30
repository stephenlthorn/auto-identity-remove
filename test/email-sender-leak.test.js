/**
 * test/email-sender-leak.test.js
 *
 * BRK2-7: with a relay configured only the body and Reply-To carried the alias; the
 * From header and the SMTP envelope are the real mailbox when email.smtp.from (or
 * email.smtp.user, which is the default From) IS the person's own address, so every
 * email broker still received the address the relay was set up to hide. The send is
 * refused (fail closed, like the relay itself) unless relay.failOpen is true, which
 * sends with a warning.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = { fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', city: 'Austin', state: 'TX', zip: '73301', email: 'jane.doe@example.com', phone: '5125550000', country: 'US' };
const OTHER = { fullName: 'John Roe', firstName: 'John', lastName: 'Roe', email: 'john.roe@example.com', zip: '10001', country: 'US' };
const BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const ALIAS = 'jane.masked@aliases.simplelogin.io';

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');
const origLast = configMod.lastOptOutDaysAgo;
const origRecord = configMod.recordSuccess;
const origLog = loggerMod.logResult;

function setup() {
  const sent = [];
  const logged = [];
  const warned = [];
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = () => {};
  loggerMod.logResult = (name, status, detail) => logged.push({ name, status, detail });
  const origWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  const origLoad = Module._load;
  Module._load = function patched(request) {
    if (request === 'nodemailer') return { createTransport: () => ({ sendMail: async (mail) => { sent.push(mail); return {}; } }) };
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const email = require('../lib/email');
  return {
    email, sent, logged, warned,
    restore() {
      Module._load = origLoad;
      console.warn = origWarn;
      configMod.lastOptOutDaysAgo = origLast;
      configMod.recordSuccess = origRecord;
      loggerMod.logResult = origLog;
      delete require.cache[require.resolve('../lib/email')];
      require('../lib/email');
    },
  };
}

const send = (t, smtp, { cfg = {}, persons = [PERSON], relay = true } = {}) => t.email.sendOptOutEmails(
  [BROKER],
  persons.length > 1 ? { persons, email: { smtp }, ...cfg } : { person: persons[0], email: { smtp }, ...cfg },
  'linux',
  { submissionEmailFor: () => (relay ? ALIAS : undefined) },
);

test('BRK2-7: relay on and smtp.from is the real address: nothing is sent and the log says why', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'jane.doe@example.com', pass: 'pw', from: 'jane.doe@example.com' });
    assert.equal(t.sent.length, 0, 'the broker would see the real address in From and in the envelope');
    assert.equal(t.logged.at(-1).status, 'error');
    assert.match(t.logged.at(-1).detail, /relay/i);
    assert.match(t.logged.at(-1).detail, /email\.smtp\.from/);
    assert.ok(!t.logged.at(-1).detail.includes('jane.doe@example.com'), 'and the address itself is not printed');
  } finally { t.restore(); }
});

test('BRK2-7: with no smtp.from the default sender is smtp.user, which counts the same', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'Jane.Doe@Example.com', pass: 'pw' });
    assert.equal(t.sent.length, 0);
  } finally { t.restore(); }
});

test('BRK2-7: a display name around the address does not hide it', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'x', pass: 'pw', from: 'Jane Doe <jane.doe@example.com>' });
    assert.equal(t.sent.length, 0);
  } finally { t.restore(); }
});

test('BRK2-7: another person\'s real address as the sender leaks that person, so it is refused as well', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'x', pass: 'pw', from: 'john.roe@example.com' }, { persons: [PERSON, OTHER] });
    assert.equal(t.sent.length, 0);
  } finally { t.restore(); }
});

test('BRK2-7: a dedicated sender address sends as before, alias in the body and Reply-To', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'sender@mailer.example', pass: 'pw', from: 'optouts@mailer.example' });
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].from, 'optouts@mailer.example');
    assert.equal(t.sent[0].replyTo, ALIAS);
    assert.ok(!t.sent[0].text.includes('jane.doe@example.com'));
  } finally { t.restore(); }
});

test('BRK2-7: relay.failOpen: true sends anyway, with a warning', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'jane.doe@example.com', pass: 'pw', from: 'jane.doe@example.com' }, { cfg: { relay: { provider: 'simplelogin', failOpen: true } } });
    assert.equal(t.sent.length, 1);
    assert.ok(t.warned.some((w) => /email\.smtp\.from/.test(w)), t.warned.join('\n'));
    assert.ok(!t.warned.join('\n').includes('jane.doe@example.com'));
  } finally { t.restore(); }
});

test('BRK2-7: with no relay in use the real address is simply what is advertised: no check', async () => {
  const t = setup();
  try {
    await send(t, { host: 'smtp.example.com', user: 'jane.doe@example.com', pass: 'pw', from: 'jane.doe@example.com' }, { relay: false });
    assert.equal(t.sent.length, 1);
  } finally { t.restore(); }
});
