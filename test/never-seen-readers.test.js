/**
 * A `never_seen` verify result (verifiedAbsentAt) means nothing was there, so
 * nothing was removed. No reader may count it as a removal, and none may count it as
 * "still listed" or "submitted but unverified" either (the score would carry 10 points
 * for a listing that never existed).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStillListed, computeExposureScore } = require('../lib/exposure');
const { buildReportModel, renderReportHtml } = require('../lib/report');
const { findOverdue } = require('../lib/complaint');

const NOW = new Date('2026-06-09T00:00:00.000Z');
const daysBefore = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

// ── score ────────────────────────────────────────────────────────────────────

test('exposure: a never_seen entry is not still listed and adds nothing to the score', () => {
  const entry = { lastSuccess: daysBefore(20), verifiedAbsentAt: daysBefore(5) };
  assert.equal(isStillListed(entry), false);
  const { score, listedCount } = computeExposureScore({ state: { optOuts: { Alpha: entry } } });
  assert.equal(listedCount, 0);
  assert.equal(score, 0);
});

test('exposure: a submitted-and-never-verified entry is still counted (unchanged)', () => {
  assert.equal(isStillListed({ lastSuccess: daysBefore(20) }), true);
});

test('exposure: a later sighting after an absent check makes it listed again', () => {
  assert.equal(isStillListed({ lastSuccess: daysBefore(20), verifiedAbsentAt: daysBefore(15), verifiedStillListedAt: daysBefore(2) }), true);
  assert.equal(isStillListed({ lastSuccess: daysBefore(20), verifiedStillListedAt: daysBefore(15), verifiedAbsentAt: daysBefore(2) }), false);
});

// ── report ───────────────────────────────────────────────────────────────────

test('report: a never_seen entry is not a verified removal, not submitted-unverified, not still listed', () => {
  const state = { optOuts: {
    Alpha: { lastSuccess: daysBefore(20), verifiedAbsentAt: daysBefore(5) },
    Beta: { lastSuccess: daysBefore(20), verifiedDeletedAt: daysBefore(5), verifiedStillListedAt: daysBefore(30) },
    Gamma: { lastSuccess: daysBefore(20) },
  } };
  const model = buildReportModel({ state, now: NOW });
  assert.deepEqual(model.removedVerified.map(r => r.broker), ['Beta']);
  assert.deepEqual(model.neverSeen.map(r => r.broker), ['Alpha']);
  assert.deepEqual(model.submitted.map(r => r.broker), ['Gamma']);
  assert.deepEqual(model.stillListed, []);
  assert.equal(model.actionsNeeded.length, 0);
});

test('report: the HTML says "never seen" apart from "removed"', () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysBefore(20), verifiedAbsentAt: daysBefore(5) } } };
  const html = renderReportHtml(buildReportModel({ state, now: NOW }));
  assert.match(html, /<h2>Never seen[^<]*<\/h2>\s*<ul><li>Alpha/);
  assert.match(html, /<h2>Verified removed<\/h2>\s*<p class="empty">None\.<\/p>/);
});

// ── complaints ───────────────────────────────────────────────────────────────

test('complaints: a never_seen entry is never a complaint', () => {
  const out = findOverdue({ optOuts: { Alpha: { lastSuccess: daysBefore(80), verifiedAbsentAt: daysBefore(60) } } }, { now: NOW });
  assert.deepEqual(out, []);
});

test('complaints: an absent check at or after the still-listed stamp cancels that evidence', () => {
  const base = { lastSuccess: daysBefore(80), verifiedStillListedAt: daysBefore(5) };
  assert.equal(findOverdue({ optOuts: { Alpha: base } }, { now: NOW }).length, 1);
  assert.deepEqual(findOverdue({ optOuts: { Alpha: { ...base, verifiedAbsentAt: daysBefore(2) } } }, { now: NOW }), []);
  assert.equal(findOverdue({ optOuts: { Alpha: { ...base, verifiedAbsentAt: daysBefore(30) } } }, { now: NOW }).length, 1);
});
