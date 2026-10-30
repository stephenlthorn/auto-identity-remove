// test/right-to-know-regime.test.js
/**
 * NET-15: a right-to-know request cites the CCPA only for California
 * residents, GDPR Article 15 for EEA/UK residents (including NO, IS, LI), and
 * no statute for everyone else. No template prints "undefined".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKnowRequest, pickRegime } = require('../lib/right-to-know');

const BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };

const TX = {
  fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe',
  city: 'Austin', state: 'TX', zip: '73301',
  email: 'jane@example.com', phoneFormatted: '(512) 555-0000', country: 'US',
};
const CA = { ...TX, city: 'Fresno', state: 'CA', zip: '93650' };
const NO = {
  fullName: 'Ola Nordmann', firstName: 'Ola', lastName: 'Nordmann',
  city: 'Oslo', state: '', zip: '0150',
  email: 'ola@example.no', phoneFormatted: '+47 22 00 00 00', country: 'NO',
};

test('a Texas resident is not told the CCPA applies to them', () => {
  const { body } = buildKnowRequest({ person: TX, broker: BROKER });
  assert.doesNotMatch(body, /CCPA|California/);
  assert.match(body, /disclos/i);
  assert.match(body, /privacy policy|applicable (privacy )?law/i);
  assert.doesNotMatch(body, /erasure|right to be forgotten|delete/i);
});

test('a California resident gets the CCPA right-to-know wording', () => {
  const { body } = buildKnowRequest({ person: CA, broker: BROKER });
  assert.match(body, /California Consumer Privacy Act/);
  assert.match(body, /45 days/);
});

test('a Norwegian resident (EEA, not EU) gets GDPR Article 15', () => {
  const { body } = buildKnowRequest({ person: NO, broker: BROKER });
  assert.match(body, /Article 15/);
  assert.match(body, /GDPR/);
});

test('an explicit regime override still wins', () => {
  const { body } = buildKnowRequest({ person: TX, broker: BROKER, regime: 'CCPA' });
  assert.match(body, /California Consumer Privacy Act/);
});

test('pickRegime(person) is three-way; pickRegime(country) keeps its old two-way meaning', () => {
  assert.equal(pickRegime(TX), 'GENERIC');
  assert.equal(pickRegime(CA), 'CCPA');
  assert.equal(pickRegime(NO), 'GDPR');
  assert.equal(pickRegime('NO'), 'GDPR');
  assert.equal(pickRegime('US'), 'CCPA', 'country-only callers cannot tell California apart');
});

for (const [label, person] of [
  ['generic', { firstName: 'Jane', lastName: 'Doe', state: 'TX', country: 'US' }],
  ['ccpa', { firstName: 'Jane', lastName: 'Doe', state: 'CA', country: 'US' }],
  ['gdpr', { firstName: 'Max', lastName: 'Mustermann', country: 'DE' }],
]) {
  test(`${label} template with only firstName/lastName never prints undefined`, () => {
    const { subject, body } = buildKnowRequest({ person, broker: BROKER });
    assert.doesNotMatch(subject, /undefined/);
    assert.doesNotMatch(body, /undefined/);
    assert.match(subject, new RegExp(`${person.firstName} ${person.lastName}`));
    assert.match(body, new RegExp(`Name: ${person.firstName} ${person.lastName}`));
  });
}
