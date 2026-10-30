// test/complaint-regime-multiperson.test.js
/**
 * Covers the 2026-06-10 review findings owned by lib/complaint.js:
 *   B1 - regime is derived from the person (lib/regime.js), NOT from a
 *        never-written entry.regime. EEA/UK persons route GDPR (30d),
 *        California residents CCPA (45d), everyone else generic (45d).
 *   B2 - findOverdue splits the composite state key "Broker|First Last" so it
 *        returns { broker: <plain name>, person: <"First Last"> } and callers'
 *        brokerMap.get(broker) hits.
 *
 * findOverdue stays PURE: state object + injected `now` + optional persons.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findOverdue } = require('../lib/complaint');

const NOW = new Date('2026-06-09T00:00:00.000Z');

function daysBefore(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const US_PERSON = { firstName: 'Jane', lastName: 'Doe', country: 'US', state: 'TX' };
const CA_PERSON = { ...US_PERSON, state: 'CA' };
const EU_PERSON = { firstName: 'Klaus', lastName: 'Mueller', country: 'DE' };

// ── B1: regime derived from person.country ──────────────────────────────────

test('B1: EU person routes GDPR (30-day window) even without entry.regime', () => {
  const state = {
    optOuts: {
      'Acme|Klaus Mueller': { lastSuccess: daysBefore(35), verifiedStillListedAt: daysBefore(1) }, // 35 > 30 -> overdue
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [EU_PERSON] });
  assert.equal(out.length, 1);
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].daysOverdue, 5); // 35 - 30
});

test('B1: EU person requested 32 days ago is CCPA-safe but GDPR-overdue', () => {
  // Under the old dead-code path this would be classified CCPA (45d) and NOT
  // overdue. With country-derived GDPR (30d) it IS overdue.
  const state = {
    optOuts: {
      'Acme|Klaus Mueller': { lastSuccess: daysBefore(32), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [EU_PERSON] });
  assert.equal(out.length, 1, 'GDPR 30-day window must flag a 32-day-old EU request');
  assert.equal(out[0].regime, 'gdpr');
});

test('B1/NET-15: a California person routes CCPA (45-day window)', () => {
  const state = {
    optOuts: {
      'Acme|Jane Doe': { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [CA_PERSON] });
  assert.equal(out.length, 1);
  assert.equal(out[0].regime, 'ccpa');
  assert.equal(out[0].daysOverdue, 5); // 50 - 45
});

test('NET-15: a US person outside California is generic, with the same 45-day window', () => {
  const state = {
    optOuts: {
      'Acme|Jane Doe': { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [US_PERSON] });
  assert.equal(out[0].regime, 'generic');
  assert.equal(out[0].daysOverdue, 5);
});

test('B1: a never-written entry.regime is ignored; country wins', () => {
  // Even if some legacy state carried entry.regime, the derivation is by country.
  const state = {
    optOuts: {
      'Acme|Klaus Mueller': { lastSuccess: daysBefore(35), verifiedStillListedAt: daysBefore(1), regime: 'ccpa' },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [EU_PERSON] });
  assert.equal(out[0].regime, 'gdpr');
});

// ── B2: composite key split ─────────────────────────────────────────────────

test('B2: composite key is split into plain broker + person', () => {
  const state = {
    optOuts: {
      'Acme|Jane Doe': { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [US_PERSON] });
  assert.equal(out[0].broker, 'Acme', 'broker must be the plain name, no |Name suffix');
  assert.equal(out[0].person, 'Jane Doe');
});

test('B2: bare (single-person) key still works and has no person suffix', () => {
  const state = {
    optOuts: {
      Spokeo: { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [US_PERSON] });
  assert.equal(out[0].broker, 'Spokeo');
  // Single-person / bare key: the one configured person supplies the regime (NET-9).
  assert.equal(out[0].regime, 'generic');
});

test('B2: composite key with no matching person is skipped, not signed over someone else (CFG2-6)', () => {
  const state = {
    optOuts: {
      'Acme|Unknown Person': { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  // It used to come back with regime 'generic' and the watcher then fell back to
  // persons[0] as the complainant. No configured person owns it: no complaint.
  assert.deepEqual(findOverdue(state, { now: NOW, persons: [US_PERSON] }), []);
});

test('B2: without persons supplied, a bare name still works (45-day window, generic)', () => {
  const state = {
    optOuts: {
      Spokeo: { lastSuccess: daysBefore(50), verifiedStillListedAt: daysBefore(1) },
    },
  };
  const out = findOverdue(state, { now: NOW });
  assert.equal(out[0].broker, 'Spokeo');
  assert.equal(out[0].regime, 'generic');
  assert.equal(out[0].daysOverdue, 5);
});
