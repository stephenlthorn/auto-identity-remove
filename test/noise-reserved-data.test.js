/**
 * test/noise-reserved-data.test.js
 *
 * NET-14: --pollute generated first.last+tag@gmail.com addresses and live area
 * codes with random exchanges, so "bogus" records could land in a real person's
 * inbox or ring a real phone. Bogus data must be undeliverable by construction:
 * RFC 2606 reserved domains and the NANP fictional range 555-0100..555-0199.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateBogusPerson, STATE_AREA_CODES } = require('../lib/noise');

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

test('NET-14: bogus emails use only RFC 2606 reserved domains', () => {
  for (let i = 0; i < 100; i++) {
    const { email } = generateBogusPerson();
    const domain = email.split('@')[1];
    assert.ok(RESERVED_DOMAINS.includes(domain), `"${email}" is on a deliverable domain`);
  }
});

test('NET-14: bogus phones are in the fictional 555-0100..0199 range', () => {
  for (let i = 0; i < 100; i++) {
    const { phone, state } = generateBogusPerson();
    assert.match(phone, /^\d{3}55501\d{2}$/, `"${phone}" is not a 555-01xx number`);
    assert.ok(STATE_AREA_CODES[state].includes(phone.slice(0, 3)), 'area code still matches the state');
  }
});

test('NET-14: the bogus email is unique enough per record and not the gmail plus-tag shape', () => {
  const emails = new Set();
  for (let i = 0; i < 50; i++) emails.add(generateBogusPerson().email);
  assert.ok(emails.size > 40, 'emails should differ between records');
  for (const e of emails) assert.ok(!/gmail\.com$/i.test(e), `${e} must not be a gmail address`);
});

test('bogus person carries what a broker form needs (fullName, country) and is marked bogus', () => {
  const p = generateBogusPerson();
  assert.equal(p.fullName, `${p.firstName} ${p.lastName}`, 'name-only forms (ThatsThem, SearchPeopleFree) need fullName');
  assert.equal(p.country, 'US');
  assert.equal(p.isBogus, true, 'the marker lets the runner refuse to touch state for this person');
});
