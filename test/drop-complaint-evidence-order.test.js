/**
 * test/drop-complaint-evidence-order.test.js
 *
 * A household that shrank to one person has a bare state entry and a "Broker|First Last"
 * entry for the same broker. They are one request, and the NEWEST still-listed evidence
 * decides, whichever entry the state file happens to list first. A reader that keeps the
 * first listing it meets would let an old all-clear cancel a newer sighting, and the person
 * would never get the complaint they are owed.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findDropOverdue } = require('../lib/complaint');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', city: 'Fresno', zip: '93701', email: 'jane@sample.example' };
const HOSTS = { 'Acme Data': 'https://www.acme-data.example/optout' };
const NOW = new Date('2026-12-15T00:00:00Z');

const find = (optOuts) => findDropOverdue({
  optOuts,
  drop: { 'Jane Sample': { submittedAt: '2026-09-01' } },
}, { persons: [JANE], registryHosts: { 'acme-data.example': ['CA'] }, hostFor: (name) => HOSTS[name], now: NOW });

test('the newest sighting wins even when the older entry is listed first', () => {
  const older = { verifiedStillListedAt: '2026-12-02T10:00:00Z', verifiedDeletedAt: '2026-12-10T10:00:00Z' };
  const newer = { verifiedStillListedAt: '2026-12-12T10:00:00Z' };
  for (const optOuts of [
    { 'Acme Data': older, 'Acme Data|Jane Sample': newer },
    { 'Acme Data|Jane Sample': newer, 'Acme Data': older },
  ]) {
    const rows = find(optOuts);
    assert.equal(rows.length, 1, 'seen again after the all-clear: one complaint, in either key order');
    assert.equal(rows[0].stillListedAt, '2026-12-12T10:00:00Z');
  }
});

test('an older sighting inside the window does not hide a newer one after it, in either key order', () => {
  const inside = { verifiedStillListedAt: '2026-11-20T10:00:00Z' };
  const after = { verifiedStillListedAt: '2026-12-05T10:00:00Z' };
  for (const optOuts of [
    { 'Acme Data': inside, 'Acme Data|Jane Sample': after },
    { 'Acme Data|Jane Sample': after, 'Acme Data': inside },
  ]) {
    const rows = find(optOuts);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stillListedAt, '2026-12-05T10:00:00Z');
  }
});
