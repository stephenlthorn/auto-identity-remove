// test/complaint-regime-single-person.test.js
/**
 * NET-9 / NET-15: a single-person config stores bare state keys ("Spokeo", not
 * "Spokeo|Jane Doe"), so the regime used to be unknowable and always CCPA:
 * a German user got California AG and FTC complaints on a 45-day window.
 * The bare key now resolves to the one configured person, and agencies follow
 * the person's regime (California -> CA AG + FTC, EEA/UK -> DPA, else FTC).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findOverdue, buildComplaintsForBroker } = require('../lib/complaint');

const NOW = new Date('2026-06-09T00:00:00.000Z');
const daysBefore = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const listed = (requestedDaysAgo) => ({
  lastSuccess: daysBefore(requestedDaysAgo),
  verifiedStillListedAt: daysBefore(1),
});

const DE = { firstName: 'Klaus', lastName: 'Mueller', country: 'DE', city: 'Berlin' };
const CA = { firstName: 'Jane', lastName: 'Doe', country: 'US', state: 'CA' };
const TX = { firstName: 'Tom', lastName: 'Roe', country: 'US', state: 'TX' };

test('NET-9: a bare key with one German person is gdpr, and 35 days is overdue', () => {
  const out = findOverdue({ optOuts: { Spokeo: listed(35) } }, { now: NOW, persons: [DE] });
  assert.equal(out.length, 1);
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].daysOverdue, 5);
});

test('NET-9: a bare key with one California person is ccpa', () => {
  const out = findOverdue({ optOuts: { Spokeo: listed(50) } }, { now: NOW, persons: [CA] });
  assert.equal(out[0].regime, 'ccpa');
});

test('NET-15: a bare key with one Texas person is generic (45-day window, no CCPA)', () => {
  const out = findOverdue({ optOuts: { Spokeo: listed(50) } }, { now: NOW, persons: [TX] });
  assert.equal(out[0].regime, 'generic');
  assert.equal(out[0].daysOverdue, 5);
});

test('NET-9: a bare key is ambiguous once there are several persons, so it is not attributed to anyone', () => {
  const out = findOverdue({ optOuts: { Spokeo: listed(50) } }, { now: NOW, persons: [DE, CA] });
  assert.deepEqual(out, [], 'signing the wrong person\'s name on a complaint is worse than none');
});

test('NET-9: composite keys still resolve their own person in a multi-person config', () => {
  const out = findOverdue(
    { optOuts: { 'Spokeo|Klaus Mueller': listed(35), 'Spokeo|Jane Doe': listed(35) } },
    { now: NOW, persons: [DE, CA] }
  );
  assert.deepEqual(out.map(o => [o.person, o.regime]), [['Klaus Mueller', 'gdpr']], 'Jane is inside her 45 days');
});

test('NET-15: agencies follow the regime - generic gets only the FTC, not the California AG', () => {
  const broker = { name: 'Spokeo' };
  const mk = (regime) => buildComplaintsForBroker({
    person: { fullName: 'P', ...TX },
    broker,
    overdue: { requestedAt: daysBefore(60), stillListedAt: daysBefore(2), daysOverdue: 15, regime },
  }).map(c => c.agency);

  assert.deepEqual(mk('generic'), ['FTC']);
  assert.deepEqual(mk('ccpa').sort(), ['CA_AG', 'FTC']);
  assert.deepEqual(mk('gdpr'), ['EU_DPA']);
});

test('NET-15: the generic FTC complaint does not cite the CCPA', () => {
  const [c] = buildComplaintsForBroker({
    person: { fullName: 'Tom Roe', ...TX },
    broker: { name: 'Spokeo' },
    overdue: { requestedAt: daysBefore(60), stillListedAt: daysBefore(2), daysOverdue: 15, regime: 'generic' },
  });
  assert.equal(c.agency, 'FTC');
  assert.doesNotMatch(c.body, /CCPA|California Consumer Privacy Act/);
  assert.match(c.body, /Federal Trade Commission/);
});

test('NET-15: a sparse person (no fullName) never prints undefined in a complaint', () => {
  const [c] = buildComplaintsForBroker({
    person: { firstName: 'Tom', lastName: 'Roe' },
    broker: { name: 'Spokeo' },
    overdue: { requestedAt: daysBefore(60), stillListedAt: daysBefore(2), daysOverdue: 15, regime: 'generic' },
  });
  assert.doesNotMatch(c.body, /undefined/);
  assert.match(c.body, /Tom Roe/);
});
