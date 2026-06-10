// test/complaint-find-overdue.test.js
/**
 * Unit tests for lib/complaint.js findOverdue().
 *
 * findOverdue is PURE: it reads a plain state object and an injected `now`,
 * and returns the brokers still listed past their legal response window.
 * No clock, no disk, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findOverdue } = require('../lib/complaint');

// Fixed reference clock for every test: 2026-06-09T00:00:00Z.
const NOW = new Date('2026-06-09T00:00:00.000Z');

// Helper: an ISO timestamp `days` days before NOW.
function daysBefore(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeState(optOuts) {
  return { optOuts };
}

test('returns empty array when there are no opt-outs', () => {
  const out = findOverdue(makeState({}), { now: NOW });
  assert.deepEqual(out, []);
});

test('CCPA broker requested 50 days ago and still listed is overdue (window 45)', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(50) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
  assert.equal(out[0].requestedAt, daysBefore(50));
  assert.equal(out[0].daysOverdue, 5); // 50 - 45
  assert.equal(out[0].regime, 'ccpa');
});

test('CCPA broker requested 40 days ago is NOT overdue (under 45-day window)', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(40) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('GDPR broker requested 35 days ago is overdue (window 30)', () => {
  const state = makeState({
    AcmeEU: { lastSuccess: daysBefore(35), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'AcmeEU');
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].daysOverdue, 5); // 35 - 30
});

test('GDPR broker requested 28 days ago is NOT overdue (under 30-day window)', () => {
  const state = makeState({
    AcmeEU: { lastSuccess: daysBefore(28), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('falls back to pendingConfirm.since when lastSuccess is absent', () => {
  const state = makeState({
    InfoTracer: { pendingConfirm: { since: daysBefore(60), snippet: 'x' } },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'InfoTracer');
  assert.equal(out[0].requestedAt, daysBefore(60));
  assert.equal(out[0].daysOverdue, 15); // 60 - 45
});

test('falls back to verifiedStillListedAt when no lastSuccess/pendingConfirm', () => {
  const state = makeState({
    Radaris: { verifiedStillListedAt: daysBefore(70) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Radaris');
  assert.equal(out[0].requestedAt, daysBefore(70));
});

test('knowRequestedAt overrides lastSuccess when both present', () => {
  const state = makeState({
    Intelius: { knowRequestedAt: daysBefore(90), lastSuccess: daysBefore(10) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(90));
  assert.equal(out[0].daysOverdue, 45); // 90 - 45
});

test('falls back to lastAttempt when no other timestamp present', () => {
  const state = makeState({
    PeopleFinders: { lastAttempt: daysBefore(55) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'PeopleFinders');
  assert.equal(out[0].requestedAt, daysBefore(55));
});

test('entry with no usable timestamp is ignored', () => {
  const state = makeState({
    Ghost: { history: ['error'] },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('broker verified clear AFTER the request is not overdue', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(60), verifiedDeletedAt: daysBefore(2) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('broker verified clear BEFORE the request (then re-listed) is still overdue', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(60), verifiedDeletedAt: daysBefore(80) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
});

test('custom ccpaDays/gdprDays windows are honored', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(20) },
    AcmeEU: { lastSuccess: daysBefore(20), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW, ccpaDays: 10, gdprDays: 15 });
  const names = out.map(o => o.broker).sort();
  assert.deepEqual(names, ['AcmeEU', 'Spokeo']);
});

test('results are sorted by daysOverdue descending (most overdue first)', () => {
  const state = makeState({
    A: { lastSuccess: daysBefore(50) }, // 5 overdue
    B: { lastSuccess: daysBefore(100) }, // 55 overdue
    C: { lastSuccess: daysBefore(60) }, // 15 overdue
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out.map(o => o.broker), ['B', 'C', 'A']);
});

test('missing optOuts key is treated as empty', () => {
  const out = findOverdue({}, { now: NOW });
  assert.deepEqual(out, []);
});

test('defaults now to current time when omitted (does not throw)', () => {
  const state = makeState({ Spokeo: { lastSuccess: daysBefore(50) } });
  const out = findOverdue(state);
  assert.ok(Array.isArray(out));
});
