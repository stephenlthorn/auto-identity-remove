/**
 * test/brokers-phone.test.js
 *
 * Spam calls come from the phone number, not the name. The person record has
 * always carried `phone`, but no explicit broker ever submitted it, and the
 * sites that are keyed BY phone number (caller-ID apps, reverse phone lookups,
 * the Do Not Call Registry) were not on the list at all.
 *
 * These tests pin the phone section of brokers.js:
 *   - every phone-keyed form gets the number in the format that site expects
 *     (national digits for US forms, +E.164 for caller-ID apps)
 *   - a person with no usable number gets an honest skip, never an empty submit
 *   - USPhonebook targets its removal form, not the search box above it
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const US = {
  firstName: 'Alice', lastName: 'Anderson', fullName: 'Alice Anderson',
  email: 'alice@example.com', city: 'Austin', state: 'TX', zip: '73301',
  country: 'US', phone: '5125550000', phoneFormatted: '(512) 555-0000',
};

// Same loader as brokers-per-person.test.js: brokers.js reads config.json from
// its own directory, so load a copy beside a synthetic config.
function loadBrokersWithConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-brokers-phone-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const modPath = path.join(dir, 'brokers.js');
  delete require.cache[modPath];
  const mod = require(modPath);
  delete require.cache[modPath];
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

const brokers = loadBrokersWithConfig({ person: US });
const byName = name => {
  const b = brokers.forPerson(US).find(x => x.name === name);
  assert.ok(b, `expected a "${name}" entry in brokers.js`);
  return b;
};
const values = b => Object.values(b.formFields || {});

test('CallApp gets the number with its country code', () => {
  assert.ok(values(byName('CallApp')).includes('+15125550000'));
});

test('US phone lookup forms get the 10 national digits', () => {
  assert.ok(values(byName('NumLookup')).includes('5125550000'));
  assert.ok(values(byName('Sync.ME')).includes('5125550000'));
});

test('Truecaller is manual: it needs an SMS or WhatsApp message from the phone', () => {
  const t = byName('Truecaller');
  assert.equal(t.method, 'manual');
  assert.equal(t.optOutUrl, 'https://www.truecaller.com/unlisting');
  assert.match(t.notes, /SMS or WhatsApp/);
});

test('Sync.ME dismisses its modal cookie dialog before filling', () => {
  const sm = byName('Sync.ME');
  assert.match(sm.preClickSelector, /dialog\[open\]/);
  assert.equal(sm.captchaLikely, true);
});

test('phone-keyed entries carry no skipReason when the number is usable', () => {
  for (const name of ['CallApp', 'NumLookup', 'Sync.ME']) {
    assert.equal(byName(name).skipReason, undefined, `${name} should run`);
  }
});

test('a person with no phone gets an honest skip on every phone-keyed form', () => {
  const noPhone = { ...US, phone: '', phoneFormatted: '' };
  const list = brokers.forPerson(noPhone);
  for (const name of ['CallApp', 'NumLookup', 'Sync.ME']) {
    const b = list.find(x => x.name === name);
    assert.match(b.skipReason || '', /phone/i, `${name} must skip without a phone number`);
    assert.ok(!values(b).includes('undefined'), `${name} must not carry "undefined"`);
  }
});

test('a non-US number without a country code skips the E.164 form', () => {
  const uk = { ...US, country: 'GB', phone: '020 7946 0000', phoneFormatted: '020 7946 0000' };
  const list = brokers.forPerson(uk);
  const b = list.find(x => x.name === 'CallApp');
  assert.match(b.skipReason || '', /country code/i, 'CallApp cannot guess a country code');
});

test('a non-US number written with + is passed through as E.164', () => {
  const uk = { ...US, country: 'GB', phone: '+44 20 7946 0000', phoneFormatted: '+44 20 7946 0000' };
  const t = brokers.forPerson(uk).find(x => x.name === 'CallApp');
  assert.equal(t.skipReason, undefined);
  assert.ok(values(t).includes('+442079460000'));
});

test('an 11-digit US number with a leading 1 is normalized', () => {
  const p = { ...US, phone: '1-512-555-0000' };
  const list = brokers.forPerson(p);
  assert.ok(values(list.find(x => x.name === 'NumLookup')).includes('5125550000'));
  assert.ok(values(list.find(x => x.name === 'CallApp')).includes('+15125550000'));
});

test('Hiya and Eyecon are emailed at the addresses their own policies give', () => {
  const hiya = byName('Hiya');
  assert.equal(hiya.method, 'email');
  assert.equal(hiya.emailTo, 'DPO@hiya.com');
  // Hiya routes deletion mail by a subject line starting with this phrase.
  assert.equal(hiya.emailSubjectPrefix, 'Advanced Data Management');

  const eyecon = byName('Eyecon');
  assert.equal(eyecon.method, 'email');
  assert.equal(eyecon.emailTo, 'privacy@instabridge.com');
});

test('the Do Not Call Registry is a US-only manual step', () => {
  const dnc = byName('National Do Not Call Registry');
  assert.equal(dnc.method, 'manual');
  assert.equal(dnc.usOnly, true);
  assert.match(dnc.optOutUrl, /^https:\/\/www\.donotcall\.gov\//);
  assert.match(dnc.notes, /72 hours/);
});

test('USPhonebook fills its removal form, not the name search box', () => {
  const u = byName('USPhonebook');
  const sels = Object.keys(u.formFields).join(' ');
  assert.match(sels, /subject-firstname/);
  assert.match(sels, /subject-email/);
  assert.ok(!/input\[name\*="name" i\]/.test(sels), 'the old selector hit the search box');
  assert.equal(u.submitSelector, '#BRP');
});
