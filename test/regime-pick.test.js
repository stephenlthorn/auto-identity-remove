// test/regime-pick.test.js
/**
 * lib/regime.js is the single source for "which privacy law does this person
 * get cited under" (NET-15): EU/EEA/UK membership, the GDPR / CCPA / generic
 * choice, response windows, and a name/contact fallback so no template ever
 * prints the literal word "undefined".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const regime = require('../lib/regime');

test('EEA-only states and the UK count as GDPR countries, not just the EU-27', () => {
  for (const cc of ['NO', 'IS', 'LI', 'GB', 'DE', 'FR', 'SE', 'IE', 'no', 'gb']) {
    assert.equal(regime.isGdprCountry(cc), true, `${cc} should be GDPR`);
  }
});

test('non-EEA countries (including Switzerland) are not GDPR countries', () => {
  for (const cc of ['US', 'CH', 'AU', 'CA', 'JP', '', undefined, null]) {
    assert.equal(regime.isGdprCountry(cc), false, `${cc} should not be GDPR`);
  }
});

test('regimeFor: an EU, EEA or UK person is gdpr', () => {
  assert.equal(regime.regimeFor({ country: 'DE', state: 'BE' }), 'gdpr');
  assert.equal(regime.regimeFor({ country: 'NO' }), 'gdpr');
  assert.equal(regime.regimeFor({ country: 'GB' }), 'gdpr');
});

test('regimeFor: only California residents are ccpa', () => {
  assert.equal(regime.regimeFor({ country: 'US', state: 'CA' }), 'ccpa');
  assert.equal(regime.regimeFor({ country: 'us', state: 'ca' }), 'ccpa');
  assert.equal(regime.regimeFor({ state: 'CA' }), 'ccpa', 'country defaults to US');
});

test('regimeFor: everyone else is generic (no statute is cited)', () => {
  assert.equal(regime.regimeFor({ country: 'US', state: 'TX' }), 'generic');
  assert.equal(regime.regimeFor({ country: 'AU', state: 'NSW' }), 'generic');
  assert.equal(regime.regimeFor({ country: 'CH' }), 'generic');
  assert.equal(regime.regimeFor({}), 'generic');
  assert.equal(regime.regimeFor(null), 'generic');
});

test('regimeFor: a non-US country never gets CCPA just because its state code is CA', () => {
  assert.equal(regime.regimeFor({ country: 'MX', state: 'CA' }), 'generic');
});

test('responseDays: GDPR is one month, everyone else gets the 45-day window', () => {
  assert.equal(regime.responseDays('gdpr'), 30);
  assert.equal(regime.responseDays('ccpa'), 45);
  assert.equal(regime.responseDays('generic'), 45);
});

test('fullName falls back to first + last and never returns undefined', () => {
  assert.equal(regime.fullName({ fullName: 'Jane Q Doe', firstName: 'Jane', lastName: 'Doe' }), 'Jane Q Doe');
  assert.equal(regime.fullName({ firstName: 'Jane', lastName: 'Doe' }), 'Jane Doe');
  assert.equal(regime.fullName({ firstName: 'Jane' }), 'Jane');
  assert.equal(regime.fullName({}), '(name not provided)');
  assert.equal(regime.fullName(null), '(name not provided)');
});

test('identityLines omits fields the person did not supply instead of printing undefined', () => {
  const lines = regime.identityLines({ firstName: 'Jane', lastName: 'Doe', email: 'j@example.com' });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /undefined|null/);
  assert.match(text, /Name: Jane Doe/);
  assert.match(text, /Email: j@example\.com/);
  assert.doesNotMatch(text, /Phone:/, 'no phone supplied -> no Phone line');
  assert.doesNotMatch(text, /Location:/, 'no address supplied -> no Location line');
});

test('identityLines uses phone when phoneFormatted is missing and formats the location', () => {
  const text = regime.identityLines({
    fullName: 'Jane Doe', city: 'Austin', state: 'TX', zip: '73301',
    email: 'j@example.com', phone: '5125550000',
  }).join('\n');
  assert.match(text, /Location: Austin, TX 73301/);
  assert.match(text, /Phone: 5125550000/);
});
