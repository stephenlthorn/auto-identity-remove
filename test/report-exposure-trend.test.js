/**
 * test/report-exposure-trend.test.js
 *
 * Fix 2: exposure trend wiring.
 *
 * Verifies:
 *   - exposureToReportAdapter in lib/exposure.js produces the
 *     { total_brokers_appearing, previous } shape that _scoreTrend expects
 *   - buildReportModel renders a real trend (up/down/same) when given the
 *     adapted exposure object
 *   - buildReportModel still says "not enough data" (direction: unknown) when
 *     exposure is null (no data passed)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel } = require('../lib/report');
const { exposureToReportAdapter, computeExposureScore, loadExposureHistory } = require('../lib/exposure');

const NOW = new Date('2026-06-09T12:00:00.000Z');

// ── exposureToReportAdapter ───────────────────────────────────────────────────

describe('exposureToReportAdapter', () => {
  it('returns listedCount as total_brokers_appearing and previous from history', () => {
    const summary = { score: 30, breakdown: {}, listedCount: 4, serpHits: 0, breachWeight: 0 };
    const history = [{ score: 50, listedCount: 7 }];
    const adapted = exposureToReportAdapter(summary, history);
    assert.equal(adapted.total_brokers_appearing, 4);
    assert.equal(adapted.previous, 7);
  });

  it('returns previous: null when history is empty', () => {
    const summary = { score: 20, breakdown: {}, listedCount: 2, serpHits: 0, breachWeight: 0 };
    const adapted = exposureToReportAdapter(summary, []);
    assert.equal(adapted.total_brokers_appearing, 2);
    assert.equal(adapted.previous, null);
  });

  it('returns previous: null when history is absent', () => {
    const summary = { score: 10, breakdown: {}, listedCount: 1, serpHits: 0, breachWeight: 0 };
    const adapted = exposureToReportAdapter(summary, null);
    assert.equal(adapted.total_brokers_appearing, 1);
    assert.equal(adapted.previous, null);
  });

  it('picks the last entry from history as previous', () => {
    const summary = { score: 5, breakdown: {}, listedCount: 1, serpHits: 0, breachWeight: 0 };
    const history = [
      { score: 80, listedCount: 10 },
      { score: 40, listedCount: 5 },
      { score: 20, listedCount: 3 },
    ];
    const adapted = exposureToReportAdapter(summary, history);
    assert.equal(adapted.previous, 3); // last history entry's listedCount
  });
});

// ── buildReportModel with adapted exposure ────────────────────────────────────

describe('buildReportModel with adapted exposure from exposureToReportAdapter', () => {
  it('renders improving trend when listedCount dropped vs previous', () => {
    const summary = { score: 10, breakdown: {}, listedCount: 2, serpHits: 0, breachWeight: 0 };
    const history = [{ score: 50, listedCount: 6 }];
    const adapted = exposureToReportAdapter(summary, history);

    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: adapted,
    });
    assert.equal(model.scoreTrend.direction, 'improving');
    assert.equal(model.scoreTrend.current, 2);
    assert.equal(model.scoreTrend.previous, 6);
    assert.equal(model.scoreTrend.delta, -4);
  });

  it('renders worsening trend when listedCount rose vs previous', () => {
    const summary = { score: 60, breakdown: {}, listedCount: 8, serpHits: 0, breachWeight: 0 };
    const history = [{ score: 20, listedCount: 3 }];
    const adapted = exposureToReportAdapter(summary, history);

    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: adapted,
    });
    assert.equal(model.scoreTrend.direction, 'worsening');
    assert.equal(model.scoreTrend.current, 8);
    assert.equal(model.scoreTrend.previous, 3);
    assert.equal(model.scoreTrend.delta, 5);
  });

  it('renders flat trend when listedCount unchanged vs previous', () => {
    const summary = { score: 30, breakdown: {}, listedCount: 4, serpHits: 0, breachWeight: 0 };
    const history = [{ score: 30, listedCount: 4 }];
    const adapted = exposureToReportAdapter(summary, history);

    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: adapted,
    });
    assert.equal(model.scoreTrend.direction, 'flat');
    assert.equal(model.scoreTrend.delta, 0);
  });

  it('reports unknown / not enough data when exposure is null', () => {
    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: null,
    });
    assert.equal(model.scoreTrend.direction, 'unknown');
    assert.equal(model.scoreTrend.current, null);
    assert.equal(model.scoreTrend.previous, null);
    assert.equal(model.scoreTrend.delta, null);
  });

  it('reports unknown when exposure is undefined (not passed)', () => {
    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
    });
    assert.equal(model.scoreTrend.direction, 'unknown');
  });
});
