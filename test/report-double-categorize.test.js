/**
 * test/report-double-categorize.test.js
 *
 * Fix 3: an entry that is still-listed with a lastSuccess must appear ONLY in
 * stillListed, NOT also in submitted.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel } = require('../lib/report');

const NOW = new Date('2026-06-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('buildReportModel double-categorize fix (Fix 3)', () => {
  it('a still-listed entry with lastSuccess appears ONLY in stillListed, not in submitted', () => {
    const state = {
      optOuts: {
        // lastSuccess 30 days ago, but verified still-listed 2 days ago - re-listed
        DoubleCase: {
          lastSuccess: daysAgo(30),
          verifiedStillListedAt: daysAgo(2),
        },
      },
    };

    const model = buildReportModel({
      state,
      brokers: [{ name: 'DoubleCase' }],
      now: NOW,
    });

    // Must be in stillListed
    const inStillListed = model.stillListed.some(e => e.broker === 'DoubleCase');
    assert.ok(inStillListed, 'Expected DoubleCase in stillListed');

    // Must NOT be in submitted
    const inSubmitted = model.submitted.some(e => e.broker === 'DoubleCase');
    assert.ok(!inSubmitted, 'DoubleCase should NOT appear in submitted when still-listed');
  });

  it('a submitted-only entry (lastSuccess, no still-listed) still appears in submitted', () => {
    const state = {
      optOuts: {
        NormalSubmit: { lastSuccess: daysAgo(10) },
      },
    };

    const model = buildReportModel({
      state,
      brokers: [{ name: 'NormalSubmit' }],
      now: NOW,
    });

    const inSubmitted = model.submitted.some(e => e.broker === 'NormalSubmit');
    assert.ok(inSubmitted, 'NormalSubmit should appear in submitted');
    const inStillListed = model.stillListed.some(e => e.broker === 'NormalSubmit');
    assert.ok(!inStillListed, 'NormalSubmit should NOT appear in stillListed');
  });

  it('a still-listed entry without lastSuccess appears in stillListed but not submitted', () => {
    const state = {
      optOuts: {
        NoSuccess: { verifiedStillListedAt: daysAgo(5) },
      },
    };

    const model = buildReportModel({
      state,
      brokers: [{ name: 'NoSuccess' }],
      now: NOW,
    });

    const inStillListed = model.stillListed.some(e => e.broker === 'NoSuccess');
    assert.ok(inStillListed, 'NoSuccess should appear in stillListed');
    const inSubmitted = model.submitted.some(e => e.broker === 'NoSuccess');
    assert.ok(!inSubmitted, 'NoSuccess should NOT appear in submitted');
  });
});
