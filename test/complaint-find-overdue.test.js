// test/complaint-find-overdue.test.js
/**
 * Unit tests for lib/complaint.js findOverdue().
 *
 * findOverdue is PURE: it reads a plain state object and an injected `now`,
 * and returns the brokers that were asked to delete, are past their response
 * window, and were verified still listed after the deadline (NET-6). The
 * evidence rules themselves are in complaint-evidence.test.js.
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

// A deletion request `days` ago whose broker a verification pass found still
// listing the person yesterday (so after any response deadline).
function listed(days) {
  return { lastSuccess: daysBefore(days), verifiedStillListedAt: daysBefore(1) };
}

test('returns empty array when there are no opt-outs', () => {
  const out = findOverdue(makeState({}), { now: NOW });
  assert.deepEqual(out, []);
});

test('CCPA broker requested 50 days ago and still listed is overdue (window 45)', () => {
  const state = makeState({
    Spokeo: listed(50),
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
  assert.equal(out[0].requestedAt, daysBefore(50));
  assert.equal(out[0].daysOverdue, 5); // 50 - 45
  assert.equal(out[0].regime, 'generic', 'no person info: no statute is cited');
});

test('CCPA broker requested 40 days ago is NOT overdue (under 45-day window)', () => {
  const state = makeState({
    Spokeo: listed(40),
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

// Regime is derived from the matched person's country (B1), so these use a
// composite "Broker|First Last" key plus an EU person rather than the
// never-written entry.regime field.
const EU_PERSON = { firstName: 'Klaus', lastName: 'Mueller', country: 'DE' };

test('GDPR broker requested 35 days ago is overdue (window 30)', () => {
  const state = makeState({
    'AcmeEU|Klaus Mueller': listed(35),
  });
  const out = findOverdue(state, { now: NOW, persons: [EU_PERSON] });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'AcmeEU');
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].daysOverdue, 5); // 35 - 30
});

test('GDPR broker requested 28 days ago is NOT overdue (under 30-day window)', () => {
  const state = makeState({
    'AcmeEU|Klaus Mueller': listed(28),
  });
  const out = findOverdue(state, { now: NOW, persons: [EU_PERSON] });
  assert.deepEqual(out, []);
});

test('pendingConfirm.since is not a request date (the user never confirmed it)', () => {
  const state = makeState({
    InfoTracer: { pendingConfirm: { since: daysBefore(60), snippet: 'x' }, verifiedStillListedAt: daysBefore(1) },
  });
  assert.deepEqual(findOverdue(state, { now: NOW }), []);
});

test('verifiedStillListedAt alone is evidence, not a request', () => {
  const state = makeState({
    Radaris: { verifiedStillListedAt: daysBefore(70) },
  });
  assert.deepEqual(findOverdue(state, { now: NOW }), []);
});

test('knowRequestedAt never overrides lastSuccess (NET-6, codex #8)', () => {
  const state = makeState({
    Intelius: { knowRequestedAt: daysBefore(90), lastSuccess: daysBefore(60), verifiedStillListedAt: daysBefore(1) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(60));
  assert.equal(out[0].daysOverdue, 15); // 60 - 45
});

test('lastAttempt alone is not a request date', () => {
  const state = makeState({
    PeopleFinders: { lastAttempt: daysBefore(55), verifiedStillListedAt: daysBefore(1) },
  });
  assert.deepEqual(findOverdue(state, { now: NOW }), []);
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
    Spokeo: { lastSuccess: daysBefore(60), verifiedDeletedAt: daysBefore(80), verifiedStillListedAt: daysBefore(1) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
});

test('custom ccpaDays/gdprDays windows are honored', () => {
  // A bare key is only attributable with exactly one person, so Spokeo is
  // matched through a second, non-EU person and AcmeEU through its own key.
  const US = { firstName: 'Jane', lastName: 'Doe', country: 'US' };
  const multi = makeState({ 'Spokeo|Jane Doe': listed(20), 'AcmeEU|Klaus Mueller': listed(20) });
  const out = findOverdue(multi, { now: NOW, ccpaDays: 10, gdprDays: 15, persons: [US, EU_PERSON] });
  const names = out.map(o => o.broker).sort();
  assert.deepEqual(names, ['AcmeEU', 'Spokeo']);
  assert.equal(
    findOverdue(makeState({ Spokeo: listed(20) }), { now: NOW, ccpaDays: 10, gdprDays: 15 }).length,
    1,
    'bare key, no persons: the generic window follows ccpaDays'
  );
});

test('results are sorted by daysOverdue descending (most overdue first)', () => {
  const state = makeState({
    A: listed(50), // 5 overdue
    B: listed(100), // 55 overdue
    C: listed(60), // 15 overdue
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out.map(o => o.broker), ['B', 'C', 'A']);
});

test('missing optOuts key is treated as empty', () => {
  const out = findOverdue({}, { now: NOW });
  assert.deepEqual(out, []);
});

test('defaults now to current time when omitted (does not throw)', () => {
  const state = makeState({ Spokeo: listed(50) });
  const out = findOverdue(state);
  assert.ok(Array.isArray(out));
});
