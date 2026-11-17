/**
 * S5: with scan.unknown "skip", a broker found days ago is not skipped because a later scan
 * hit a bot wall (or, for an unvalidated search, came back empty): the fresh sighting stands.
 * S10: a scan dated in the future (a wrong clock on a NAS) never goes stale on its own, so a
 * record more than a day ahead is unusable.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideFoundOnly } = require('../lib/scan');
const { searchHash } = require('../lib/identity');

const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const daysAfter = (n) => daysBefore(-n);
const SEARCH = searchHash('https://x.example/search');
const SKIP = { scan: { unknown: 'skip' } };

const decide = (scan, over = {}) => decideFoundOnly({
  scan: { sh: SEARCH, ...scan }, searchable: true, validated: true, config: SKIP, now: NOW, searchHash: SEARCH, ...over,
});

// ── S5 ───────────────────────────────────────────────────────────────────────

test('S5: found 5 days ago, then an unknown 2 days ago: still submitted, with skip', () => {
  const d = decide({ at: daysBefore(2), outcome: 'unknown', reason: 'search failed: bot wall', lastFoundAt: daysBefore(5) });
  assert.equal(d.action, 'submit');
  assert.equal(d.basis, 'found');
  assert.match(d.reason, new RegExp(`listed \\(scan of ${daysBefore(5).slice(0, 10)}\\)`));
});

test('S5: a sighting older than scan.maxAgeDays no longer holds against an unknown', () => {
  const d = decide({ at: daysBefore(2), outcome: 'unknown', lastFoundAt: daysBefore(31) });
  assert.equal(d.action, 'skip');
  assert.equal(d.basis, 'unknown');
});

test('S5: the edge of the window counts, and the window is the configured one', () => {
  assert.equal(decide({ at: daysBefore(1), outcome: 'unknown', lastFoundAt: daysBefore(30) }).basis, 'found');
  const tight = { scan: { unknown: 'skip', maxAgeDays: 7 } };
  assert.equal(decide({ at: daysBefore(1), outcome: 'unknown', lastFoundAt: daysBefore(8) }, { config: tight }).basis, 'unknown');
  assert.equal(decide({ at: daysBefore(1), outcome: 'unknown', lastFoundAt: daysBefore(7) }, { config: tight }).basis, 'found');
});

test('S5: a LATER validated not_found beats the older sighting', () => {
  const d = decide({ at: daysBefore(2), outcome: 'not_found', lastFoundAt: daysBefore(5) });
  assert.equal(d.action, 'skip');
  assert.equal(d.basis, 'not_found');
});

test('S5: an empty result from an unvalidated search does not beat a fresh sighting either', () => {
  const d = decide({ at: daysBefore(2), outcome: 'not_found', lastFoundAt: daysBefore(5) }, { validated: false });
  assert.equal(d.action, 'submit');
  assert.equal(d.basis, 'found');
});

test('S5: the sighting must be from the same search: no hash match, no credit', () => {
  const d = decide({ at: daysBefore(2), outcome: 'unknown', lastFoundAt: daysBefore(5), sh: 'ffffffffffffffff' });
  assert.equal(d.basis, 'missing');
});

test('S5: with no sighting an unknown still follows scan.unknown', () => {
  assert.equal(decide({ at: daysBefore(2), outcome: 'unknown' }).action, 'skip');
  assert.equal(decide({ at: daysBefore(2), outcome: 'unknown' }, { config: {} }).action, 'submit');
});

// ── S10 ──────────────────────────────────────────────────────────────────────

test('S10: a record dated more than a day in the future is unusable, and says so', () => {
  for (const outcome of ['found', 'not_found']) {
    const d = decide({ at: daysAfter(3), outcome });
    assert.equal(d.basis, 'stale', outcome);
    assert.equal(d.action, 'skip', 'follows scan.unknown');
    assert.match(d.reason, /in the future/);
  }
  assert.equal(decide({ at: daysAfter(3), outcome: 'found' }, { config: {} }).action, 'submit');
});

test('S10: a small clock difference (under a day ahead) is tolerated', () => {
  assert.equal(decide({ at: daysAfter(0.5), outcome: 'found' }).basis, 'found');
});

test('S10: a sighting dated in the future does not rescue an unknown', () => {
  const d = decide({ at: daysBefore(1), outcome: 'unknown', lastFoundAt: daysAfter(3) });
  assert.equal(d.basis, 'unknown');
});
