/**
 * test/right-to-know.test.js
 *
 * Covers the PURE template builder in lib/right-to-know.js:
 *   - buildKnowRequest returns { subject, body }
 *   - regime routing by person.country (EU/GB -> GDPR, else CCPA)
 *   - explicit regime override wins over country
 *   - body cites the right legal basis (access/know, NOT erasure)
 *   - person fields are interpolated
 *
 * No I/O, no network, no state. Pure function only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKnowRequest, pickRegime } = require('../lib/right-to-know');

const US_PERSON = {
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

const EU_PERSON = {
  fullName: 'Max Mustermann',
  firstName: 'Max',
  lastName: 'Mustermann',
  city: 'Berlin',
  state: 'BE',
  zip: '10115',
  email: 'max@example.de',
  phoneFormatted: '+49 30 1234567',
  country: 'DE',
};

const BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };

test('pickRegime: EU country -> GDPR', () => {
  assert.equal(pickRegime('DE'), 'GDPR');
  assert.equal(pickRegime('gb'), 'GDPR');
});

test('pickRegime: US / non-EU / missing country string -> CCPA (country-only legacy meaning)', () => {
  assert.equal(pickRegime('US'), 'CCPA');
  assert.equal(pickRegime('AU'), 'CCPA');
  assert.equal(pickRegime(undefined), 'CCPA');
});

test('buildKnowRequest: California person -> CCPA right-to-know wording', () => {
  // The CCPA protects California residents only (NET-15); see
  // right-to-know-regime.test.js for the non-California cases.
  const ca = { ...US_PERSON, city: 'Fresno', state: 'CA', zip: '93650' };
  const { subject, body } = buildKnowRequest({ person: ca, broker: BROKER });
  assert.match(subject, /Right to Know/i);
  assert.match(subject, /Jane Doe/);
  assert.match(body, /CCPA/);
  assert.match(body, /categories of personal information/i);
  // It must NOT be an erasure request.
  assert.doesNotMatch(body, /erasure|right to be forgotten/i);
  // person fields interpolated
  assert.match(body, /Jane Doe/);
  assert.match(body, /Fresno, CA 93650/);
  assert.match(body, /jane@example\.com/);
});

test('buildKnowRequest: EU person -> GDPR Article 15 access wording', () => {
  const { subject, body } = buildKnowRequest({ person: EU_PERSON, broker: BROKER });
  assert.match(body, /GDPR/);
  assert.match(body, /Article 15/);
  assert.match(body, /right of access/i);
  assert.doesNotMatch(body, /Article 17|erasure/i);
  assert.match(body, /Max Mustermann/);
  assert.match(body, /Berlin, BE 10115/);
});

test('buildKnowRequest: explicit regime overrides country', () => {
  const { body } = buildKnowRequest({ person: US_PERSON, broker: BROKER, regime: 'GDPR' });
  assert.match(body, /Article 15/);
  assert.match(body, /GDPR/);
});

test('buildKnowRequest: subject includes broker-agnostic title and full name', () => {
  const { subject } = buildKnowRequest({ person: EU_PERSON, broker: BROKER });
  assert.match(subject, /Max Mustermann/);
  assert.match(subject, /Right to Know|Data Access/i);
});
