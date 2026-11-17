/**
 * test/drop-complaint-days-overdue.test.js
 *
 * "Days overdue" counts whole days since the deadline day began. A part of a day is not
 * a day: a complaint must not say 16 days when only 15 and a half have passed.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findDropOverdue } = require('../lib/complaint');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', city: 'Fresno', zip: '93701', email: 'jane@sample.example' };
const overdueAt = (now) => findDropOverdue({
  optOuts: { 'Acme Data': { verifiedStillListedAt: '2026-12-02T10:00:00Z' } },
  drop: { 'Jane Sample': { submittedAt: '2026-09-01' } },
}, {
  persons: [JANE],
  registryHosts: { 'acme-data.example': ['CA'] },
  hostFor: () => 'https://www.acme-data.example/optout',
  now: new Date(now),
})[0].daysOverdue;

test('daysOverdue rounds down: the deadline is 2026-11-30, so 15 and a half days is 15', () => {
  assert.equal(overdueAt('2026-12-15T00:00:00Z'), 15);
  assert.equal(overdueAt('2026-12-15T12:00:00Z'), 15);
  assert.equal(overdueAt('2026-12-15T23:59:00Z'), 15);
  assert.equal(overdueAt('2026-12-16T00:00:00Z'), 16);
});
