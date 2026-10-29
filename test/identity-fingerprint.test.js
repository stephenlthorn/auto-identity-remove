/**
 * test/identity-fingerprint.test.js
 *
 * R5: personFingerprint() is the identity half of a state entry. Two runs for the
 * same person must hash alike however the config was formatted, and any change
 * that makes the removal request describe a different person (a corrected zip or
 * email, a new phone number, a different name) must change the hash.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { personFingerprint } = require('../lib/config');

const base = () => ({
  firstName: 'Alex',
  lastName: 'Tester',
  zip: '27312',
  email: 'alex.tester@example.net',
  phone: '3365550100',
  country: 'US',
});

test('is the first 16 hex characters of a sha256', () => {
  assert.match(personFingerprint(base()), /^[0-9a-f]{16}$/);
});

test('is stable across calls and does not mutate the person', () => {
  const p = base();
  const before = JSON.stringify(p);
  assert.equal(personFingerprint(p), personFingerprint(p));
  assert.equal(JSON.stringify(p), before);
});

test('ignores case, outer whitespace and repeated inner whitespace', () => {
  const messy = {
    ...base(),
    firstName: '  ALEX ',
    lastName: 'tester  ',
    email: '  Alex.Tester@EXAMPLE.net ',
  };
  assert.equal(personFingerprint(messy), personFingerprint(base()));
  assert.equal(
    personFingerprint({ ...base(), firstName: 'Mary   Ann' }),
    personFingerprint({ ...base(), firstName: 'mary ann' }),
  );
});

test('phone counts by its digits only', () => {
  const formatted = { ...base(), phone: '(336) 555-0100' };
  assert.equal(personFingerprint(formatted), personFingerprint(base()));
  assert.equal(personFingerprint({ ...base(), phone: '336.555.0100' }), personFingerprint(base()));
});

test('a US zip counts by its first 5 characters (ZIP+4 does not change identity)', () => {
  assert.equal(personFingerprint({ ...base(), zip: '27312-1234' }), personFingerprint(base()));
  assert.equal(personFingerprint({ ...base(), zip: ' 27312 ' }), personFingerprint(base()));
  assert.equal(personFingerprint({ ...base(), zip: '273121234', country: 'us' }), personFingerprint(base()));
});

test('a missing country is treated as US', () => {
  const noCountry = { ...base() };
  delete noCountry.country;
  assert.equal(personFingerprint({ ...noCountry, zip: '27312-9999' }), personFingerprint(base()));
});

test('a non-US postal code is kept whole (only case and spacing are normalized)', () => {
  const ca = { ...base(), country: 'CA', zip: 'K1A 0A6' };
  assert.equal(personFingerprint({ ...ca, zip: 'k1a   0a6' }), personFingerprint(ca));
  assert.notEqual(personFingerprint({ ...ca, zip: 'K1A 0B1' }), personFingerprint(ca));
});

test('correcting the zip changes the fingerprint', () => {
  assert.notEqual(personFingerprint({ ...base(), zip: '27313' }), personFingerprint(base()));
});

test('correcting the email changes the fingerprint', () => {
  assert.notEqual(personFingerprint({ ...base(), email: 'alex@example.net' }), personFingerprint(base()));
});

test('a new phone number changes the fingerprint', () => {
  assert.notEqual(personFingerprint({ ...base(), phone: '3365550199' }), personFingerprint(base()));
});

test('a different name changes the fingerprint (John Smith Sr and Jr do not share history)', () => {
  const sr = { firstName: 'John', lastName: 'Smith', zip: '10001', email: 'john.sr@example.net', phone: '2125550101' };
  const jr = { ...sr, email: 'john.jr@example.net', phone: '2125550102' };
  assert.notEqual(personFingerprint(sr), personFingerprint(jr));
  assert.notEqual(personFingerprint({ ...base(), lastName: 'Testers' }), personFingerprint(base()));
});

test('field boundaries cannot be smuggled: moving text between fields changes the hash', () => {
  const a = { firstName: 'Ann', lastName: 'Bell', zip: '12345', email: 'x@example.net', phone: '' };
  const b = { firstName: 'Ann B', lastName: 'ell', zip: '12345', email: 'x@example.net', phone: '' };
  assert.notEqual(personFingerprint(a), personFingerprint(b));
});

test('uses person.email (the real address), never the relay alias passed beside it', () => {
  const p = { ...base(), submissionEmail: 'relay-abc@relay.example.net', relayAlias: 'relay-abc@relay.example.net' };
  assert.equal(personFingerprint(p), personFingerprint(base()));
});

test('absent optional fields hash the same as blank ones', () => {
  const sparse = { firstName: 'Alex', lastName: 'Tester', zip: '27312', email: 'alex.tester@example.net' };
  assert.equal(personFingerprint(sparse), personFingerprint({ ...sparse, phone: '' }));
  assert.equal(personFingerprint(sparse), personFingerprint({ ...sparse, phone: null }));
});

test('the digest is over the documented normalized fields, newline separated', () => {
  const expected = crypto
    .createHash('sha256')
    .update(['alex', 'tester', '27312', 'alex.tester@example.net', '3365550100'].join('\n'))
    .digest('hex')
    .slice(0, 16);
  assert.equal(personFingerprint(base()), expected);
});

test('no person means no fingerprint', () => {
  assert.equal(personFingerprint(null), null);
  assert.equal(personFingerprint(undefined), null);
  assert.equal(personFingerprint('Alex Tester'), null);
});
