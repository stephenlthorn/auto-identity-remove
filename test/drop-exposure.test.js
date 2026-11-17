/**
 * test/drop-exposure.test.js
 *
 * The exposure score and DROP. A DROP request is a request, not evidence: the score
 * must never go down because of one, and a covered broker must never be counted as a
 * verified removal. The coverage is shown on its own line instead.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeExposureScore, formatScoreReport } = require('../lib/exposure');
const { dropCoveredCount } = require('../lib/drop');

const STATE = { optOuts: {
  Spokeo: { lastSuccess: '2026-09-01T00:00:00Z' },
  Acme: { verifiedStillListedAt: '2026-10-01T00:00:00Z' },
  Gone: { verifiedDeletedAt: '2026-10-01T00:00:00Z' },
} };

test('DROP coverage never changes a point of the score or the still-listed count', () => {
  const without = computeExposureScore({ state: STATE });
  const withDrop = computeExposureScore({ state: STATE, dropCovered: 600 });
  assert.equal(withDrop.score, without.score);
  assert.deepEqual(withDrop.breakdown, without.breakdown);
  assert.equal(withDrop.listedCount, without.listedCount);
  assert.equal(withDrop.dropCovered, 600);
  assert.equal(without.dropCovered, 0);
});

test('the report shows coverage on its own line, labelled as not a removal', () => {
  const summary = computeExposureScore({ state: STATE, dropCovered: 600 });
  const text = formatScoreReport(summary, []);
  assert.match(text, /covered by your DROP request\s*: 600/);
  assert.match(text, /not counted as removed/);
  assert.doesNotMatch(formatScoreReport(computeExposureScore({ state: STATE }), []), /DROP/);
});

test('a junk dropCovered value counts as zero', () => {
  assert.equal(computeExposureScore({ state: STATE, dropCovered: -5 }).dropCovered, 0);
  assert.equal(computeExposureScore({ state: STATE, dropCovered: 'lots' }).dropCovered, 0);
});

test('dropCoveredCount: the California registry broker count when a California person has a request, else 0', () => {
  const jane = { firstName: 'Jane', lastName: 'Sample', state: 'CA' };
  const bob = { firstName: 'Bob', lastName: 'Sample', state: 'TX' };
  const recorded = { drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
  assert.equal(dropCoveredCount({ persons: [jane, bob], state: recorded, registryCount: 412 }), 412);
  assert.equal(dropCoveredCount({ persons: [jane], state: {}, registryCount: 412 }), 0);
  assert.equal(dropCoveredCount({ persons: [bob], state: { drop: { 'Bob Sample': { submittedAt: '2026-09-01' } } }, registryCount: 412 }), 0);
});
