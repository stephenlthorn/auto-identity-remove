'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel } = require('../lib/report');

// ── Factory helpers (no shared mutable state) ──────────────────────────────────

const BROKERS = [
  { name: 'Spokeo', expectedSender: 'privacy@spokeo.com' },
  { name: 'Radaris' },
  { name: 'BeenVerified' },
  { name: 'MyLife' },
];

function makeState(optOuts) {
  return { optOuts };
}

// A fixed "now" so day-based gates are deterministic.
const NOW = new Date('2026-06-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// ── period ─────────────────────────────────────────────────────────────────────

describe('buildReportModel period', () => {
  it('derives the period as YYYY-MM from the provided now', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.equal(model.period, '2026-06');
  });
});

// ── removedVerified ──────────────────────────────────────────────────────────

describe('buildReportModel removedVerified', () => {
  it('lists brokers whose verifiedDeletedAt is newer than lastSuccess', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, [
      { broker: 'Spokeo', verifiedAt: daysAgo(10) },
    ]);
  });

  it('does not list a broker whose verifiedDeletedAt is older than lastSuccess', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(5), verifiedDeletedAt: daysAgo(40) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, []);
  });
});

// ── submitted ────────────────────────────────────────────────────────────────

describe('buildReportModel submitted', () => {
  it('lists brokers with a lastSuccess that are not yet verified-clear', () => {
    const state = makeState({
      Radaris: { lastSuccess: daysAgo(3) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, [
      { broker: 'Radaris', lastSuccess: daysAgo(3) },
    ]);
  });

  it('excludes from submitted any broker already in removedVerified', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, []);
    assert.equal(model.removedVerified.length, 1);
  });
});

// ── stillListed ──────────────────────────────────────────────────────────────

describe('buildReportModel stillListed', () => {
  it('lists brokers re-listed after a successful submit', () => {
    const state = makeState({
      BeenVerified: { lastSuccess: daysAgo(30), verifiedStillListedAt: daysAgo(2) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.stillListed, [
      { broker: 'BeenVerified', verifiedStillListedAt: daysAgo(2) },
    ]);
  });
});

// ── awaitingConfirmation ──────────────────────────────────────────────────────

describe('buildReportModel awaitingConfirmation', () => {
  it('lists pending-confirm brokers with sender hint from the broker def', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(3), snippet: 'check inbox' } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.awaitingConfirmation, [
      { broker: 'Spokeo', since: daysAgo(3), expectedSender: 'privacy@spokeo.com' },
    ]);
  });

  it('omits a broker from awaitingConfirmation once a later success exists', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(1), pendingConfirm: { since: daysAgo(10) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.awaitingConfirmation, []);
  });
});

// ── errors ───────────────────────────────────────────────────────────────────

describe('buildReportModel errors', () => {
  it('lists brokers whose most recent history entry is error', () => {
    const state = makeState({
      MyLife: { history: ['success', 'error'] },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.errors, [
      { broker: 'MyLife', lastHistory: 'error' },
    ]);
  });
});

// ── actionsNeeded ────────────────────────────────────────────────────────────

describe('buildReportModel actionsNeeded', () => {
  it('flags confirm_email for pending older than staleAfterDays', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(20) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW, staleAfterDays: 14 });
    const confirm = model.actionsNeeded.find(a => a.broker === 'Spokeo');
    assert.equal(confirm.kind, 'confirm_email');
  });

  it('does NOT flag confirm_email for pending newer than staleAfterDays', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(3) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW, staleAfterDays: 14 });
    assert.equal(model.actionsNeeded.find(a => a.broker === 'Spokeo'), undefined);
  });

  it('flags still_listed for a broker re-listed after success', () => {
    const state = makeState({
      BeenVerified: { lastSuccess: daysAgo(30), verifiedStillListedAt: daysAgo(2) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    const action = model.actionsNeeded.find(a => a.broker === 'BeenVerified');
    assert.equal(action.kind, 'still_listed');
  });

  it('flags manual for captcha_failed or error as the latest history', () => {
    const state = makeState({
      Radaris: { history: ['captcha_failed'] },
      MyLife: { history: ['success', 'error'] },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    const kinds = model.actionsNeeded.filter(a => a.kind === 'manual').map(a => a.broker).sort();
    assert.deepEqual(kinds, ['MyLife', 'Radaris']);
  });

  it('returns an empty action list when nothing needs the user', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.actionsNeeded, []);
  });
});

// ── scoreTrend ───────────────────────────────────────────────────────────────

describe('buildReportModel scoreTrend', () => {
  it('reports improving when exposure dropped versus previous', () => {
    const model = buildReportModel({
      state: makeState({}),
      brokers: BROKERS,
      now: NOW,
      exposure: { total_brokers_appearing: 2, previous: 5 },
    });
    assert.deepEqual(model.scoreTrend, { current: 2, previous: 5, delta: -3, direction: 'improving' });
  });

  it('reports worsening when exposure grew versus previous', () => {
    const model = buildReportModel({
      state: makeState({}),
      brokers: BROKERS,
      now: NOW,
      exposure: { total_brokers_appearing: 6, previous: 4 },
    });
    assert.deepEqual(model.scoreTrend, { current: 6, previous: 4, delta: 2, direction: 'worsening' });
  });

  it('reports flat / null-previous safely when no exposure data provided', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.deepEqual(model.scoreTrend, { current: null, previous: null, delta: null, direction: 'unknown' });
  });
});

// ── robustness ───────────────────────────────────────────────────────────────

describe('buildReportModel robustness', () => {
  it('handles an empty state without throwing', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, []);
    assert.deepEqual(model.submitted, []);
    assert.deepEqual(model.stillListed, []);
    assert.deepEqual(model.awaitingConfirmation, []);
    assert.deepEqual(model.errors, []);
    assert.deepEqual(model.actionsNeeded, []);
  });

  it('tolerates a missing optOuts object', () => {
    const model = buildReportModel({ state: {}, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, []);
  });
});
