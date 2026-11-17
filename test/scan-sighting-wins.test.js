/**
 * S4: a sighting (a scan's lastFoundAt, or verifiedStillListedAt) that is NEWER than
 * verifiedAbsentAt or verifiedDeletedAt wins everywhere: verify re-checks it, the score
 * counts it as listed, the report lists it as listed. A fresh scan `found` with no
 * opt-out entry also counts as listed in the score.
 *
 * The reachable story: submitted on day 0, `aidr verify` on day 8 sees an empty page
 * (never_seen), `aidr scan` on day 18 finds the listing.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runVerify } = require('../lib/verify-loop');
const { isStillListed, computeExposureScore } = require('../lib/exposure');
const { buildReportModel, renderReportHtml } = require('../lib/report');
const { searchHash } = require('../lib/identity');

const NOW = new Date('2026-06-30T00:00:00.000Z');
const daysBefore = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const JANE = { firstName: 'Jane', lastName: 'Sample' };

// day 0 submitted, day 8 verify found nothing, day 18 a scan found it again (now is day 20)
const SUBMITTED = daysBefore(20);
const ABSENT = daysBefore(12);
const SCAN_SAW_IT = daysBefore(2);
const ALPHA_SEARCH = searchHash('https://alpha.example/search');

const reachable = (overrides = {}) => ({
  optOuts: { Alpha: { lastSuccess: SUBMITTED, verifiedAbsentAt: ABSENT, ...overrides } },
  scans: { Alpha: { at: SCAN_SAW_IT, outcome: 'found', lastFoundAt: SCAN_SAW_IT, listingUrl: 'https://alpha.example/listing/1', sh: ALPHA_SEARCH } },
});

// ── verify ───────────────────────────────────────────────────────────────────

const broker = { name: 'Alpha', method: 'direct-form', optOutUrl: 'https://alpha.example/o', searchUrl: 'https://alpha.example/search', listingPattern: /listing/i };
const context = { newPage: async () => ({ close: async () => {} }) };
const verifyWith = (state, findUrl) => runVerify(context, [broker], [JANE], { state, findUrl });

test('verify re-checks an entry found absent when a scan saw the listing after that', async () => {
  const state = reachable();
  let searched = 0;
  const result = await verifyWith(state, async () => { searched += 1; return 'https://alpha.example/listing/1'; });
  assert.equal(searched, 1);
  assert.deepEqual(result.still_listed.map(e => e.broker), ['Alpha']);
  assert.ok(state.optOuts.Alpha.verifiedStillListedAt);
});

test('verify re-checks an entry verified clear when a scan saw the listing after that', async () => {
  const state = reachable({ verifiedAbsentAt: undefined, verifiedDeletedAt: ABSENT });
  let searched = 0;
  await verifyWith(state, async () => { searched += 1; return null; });
  assert.equal(searched, 1);
});

test('verify still skips an absent check that no later sighting contradicts', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: SUBMITTED, verifiedAbsentAt: ABSENT } } };
  let searched = 0;
  const result = await verifyWith(state, async () => { searched += 1; return null; });
  assert.equal(searched, 0);
  assert.match(result.skipped[0].reason, /already found absent/);
});

test('a sighting OLDER than the absent check does not override it', async () => {
  const state = reachable();
  state.scans.Alpha.lastFoundAt = daysBefore(15);
  let searched = 0;
  await verifyWith(state, async () => { searched += 1; return null; });
  assert.equal(searched, 0);
});

// ── score ────────────────────────────────────────────────────────────────────

test('exposure: a scan sighting newer than the absent check makes the entry listed again', () => {
  const state = reachable();
  assert.equal(computeExposureScore({ state }).listedCount, 1);
});

test('exposure: the same entry without the scan is still not listed', () => {
  const state = { optOuts: reachable().optOuts };
  assert.equal(computeExposureScore({ state }).listedCount, 0);
});

test('exposure: a scan sighting older than a verified removal does not count', () => {
  const state = reachable({ verifiedAbsentAt: undefined, verifiedDeletedAt: daysBefore(1) });
  assert.equal(computeExposureScore({ state }).listedCount, 0);
});

test('exposure: a fresh scan found with no opt-out entry counts as listed; one that found nothing does not', () => {
  const found = { optOuts: {}, scans: { Alpha: { at: daysBefore(1), outcome: 'found', lastFoundAt: daysBefore(1) } } };
  assert.equal(computeExposureScore({ state: found }).listedCount, 1);
  const five = { optOuts: {}, scans: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(n => [n, { at: daysBefore(1), outcome: 'found', lastFoundAt: daysBefore(1) }])) };
  assert.equal(computeExposureScore({ state: five }).listedCount, 5);
  const none = { optOuts: {}, scans: { Alpha: { at: daysBefore(1), outcome: 'not_found' }, Beta: { at: daysBefore(1), outcome: 'unknown', reason: 'x' } } };
  assert.equal(computeExposureScore({ state: none }).listedCount, 0);
});

test('exposure: a run sighting (source run) with no opt-out entry also counts, and is not double counted with its entry', () => {
  const both = {
    optOuts: { Alpha: { lastSuccess: daysBefore(3) } },
    scans: { Alpha: { at: daysBefore(3), outcome: 'found', lastFoundAt: daysBefore(3), source: 'run' } },
  };
  assert.equal(computeExposureScore({ state: both }).listedCount, 1);
});

test('isStillListed is unchanged when no scan is given', () => {
  assert.equal(isStillListed({ lastSuccess: daysBefore(20), verifiedAbsentAt: daysBefore(5) }), false);
  assert.equal(isStillListed({ lastSuccess: daysBefore(20) }), true);
});

// ── report ───────────────────────────────────────────────────────────────────

test('report: a scan sighting after the absent check lists it as listed, not under "Never seen"', () => {
  const model = buildReportModel({ state: reachable(), now: NOW });
  assert.deepEqual(model.stillListed.map(r => r.broker), ['Alpha']);
  assert.deepEqual(model.neverSeen, []);
  assert.deepEqual(model.submitted, []);
  assert.equal(model.actionsNeeded.filter(a => a.kind === 'still_listed').length, 1);
  const html = renderReportHtml(model);
  assert.match(html, /Alpha/);
});

test('report: a scan sighting after a verified removal lists it as listed, not as removed', () => {
  const model = buildReportModel({ state: reachable({ verifiedAbsentAt: undefined, verifiedDeletedAt: ABSENT }), now: NOW });
  assert.deepEqual(model.removedVerified, []);
  assert.deepEqual(model.stillListed.map(r => r.broker), ['Alpha']);
});

test('report: without the scan the same entry is "Never seen", as before', () => {
  const model = buildReportModel({ state: { optOuts: reachable().optOuts }, now: NOW });
  assert.deepEqual(model.neverSeen.map(r => r.broker), ['Alpha']);
  assert.deepEqual(model.stillListed, []);
});

test('report: a sighting older than the last submission is not evidence about it', () => {
  const state = reachable();
  state.scans.Alpha.lastFoundAt = daysBefore(30);
  const model = buildReportModel({ state, now: NOW });
  assert.deepEqual(model.stillListed, []);
  assert.deepEqual(model.neverSeen.map(r => r.broker), ['Alpha']);
});
