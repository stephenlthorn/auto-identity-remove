/**
 * test/drop-complaint-clear-order.test.js
 *
 * When one broker has two state entries for the same person (the bare name and the
 * "Broker|First Last" one), the LATEST all-clear is the one that can cancel a sighting.
 * Taking the first all-clear it meets would let an old clear sit in front of a newer
 * one, and the person would be sent a complaint for a broker that verified the data gone.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findDropOverdue } = require('../lib/complaint');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', city: 'Fresno', zip: '93701', email: 'jane@sample.example' };
const find = (optOuts) => findDropOverdue({
  optOuts,
  drop: { 'Jane Sample': { submittedAt: '2026-09-01' } },
}, {
  persons: [JANE],
  registryHosts: { 'acme-data.example': ['CA'] },
  hostFor: () => 'https://www.acme-data.example/optout',
  now: new Date('2026-12-15T00:00:00Z'),
});

test('the latest all-clear cancels a sighting, whichever entry is read first', () => {
  const clearedEarly = { verifiedStillListedAt: '2026-12-05T10:00:00Z', verifiedDeletedAt: '2026-12-02T10:00:00Z' };
  const clearedLate = { verifiedDeletedAt: '2026-12-10T10:00:00Z' };
  for (const optOuts of [
    { 'Acme Data': clearedEarly, 'Acme Data|Jane Sample': clearedLate },
    { 'Acme Data|Jane Sample': clearedLate, 'Acme Data': clearedEarly },
  ]) {
    assert.deepEqual(find(optOuts), [], 'seen on 12-05, cleared on 12-10: no complaint');
  }
});
