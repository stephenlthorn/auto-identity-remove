/**
 * test/identity-state.test.js
 *
 * R5: state entries carry an identity fingerprint (`fp`). An entry whose fp
 * differs from the current person's counts as never run, so a corrected zip or
 * email re-submits instead of waiting out a 90-day cooldown earned by the old
 * data, and two people with the same name stop inheriting each other's history.
 * Entries without an fp (every entry written before this) are trusted exactly
 * as before, so nothing re-runs on upgrade.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

const ALEX = { firstName: 'Alex', lastName: 'Tester', zip: '27312', email: 'alex.tester@example.net', phone: '3365550100' };
const ALEX_NEW_ZIP = { ...ALEX, zip: '27313' };
const SAM = { firstName: 'Sam', lastName: 'Tester', zip: '27312', email: 'sam.tester@example.net', phone: '3365550111' };

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-identity-'));
  cfg.setTestStatePath(path.join(dir, 'state.json'));
  const st = cfg.loadState();
  for (const k of Object.keys(st)) delete st[k];
  st.optOuts = {};
  try { return fn(st); } finally {
    cfg.setTestStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---- writers ---------------------------------------------------------------

test('recordSuccess stores the person fingerprint on the entry', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX));
}));

test('recordPendingConfirmation stores the person fingerprint on the entry', () => withTempState((st) => {
  cfg.recordPendingConfirmation('Spokeo', 'check your inbox', { person: ALEX });
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX));
}));

test('recordFailure stores the person fingerprint on the entry', () => withTempState((st) => {
  cfg.recordFailure('Spokeo', 'error', { person: ALEX });
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX));
}));

test('recordKnowRequest stamps the fingerprint of the person it already receives', () => withTempState((st) => {
  cfg.recordKnowRequest('Spokeo', ALEX, 2);
  assert.equal(st.optOuts['Spokeo|Alex Tester'].fp, cfg.personFingerprint(ALEX));
}));

test('writers called the old way (no person) write no fp and keep an existing one', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done');
  assert.equal('fp' in st.optOuts.Spokeo, false);

  cfg.recordSuccess('Spokeo', 'again', { person: ALEX });
  const stamped = st.optOuts.Spokeo.fp;
  cfg.recordFailure('Spokeo', 'error');
  cfg.recordPendingConfirmation('Spokeo', 'later');
  cfg.recordSuccess('Spokeo', 'and again');
  assert.equal(st.optOuts.Spokeo.fp, stamped);
}));

test('writers accept the full options object callers already build', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo|Alex Tester', 'done', { person: ALEX, personCount: 2, personIndex: 0 });
  assert.equal(st.optOuts['Spokeo|Alex Tester'].fp, cfg.personFingerprint(ALEX));
  assert.equal(st.optOuts['Spokeo|Alex Tester'].totalRuns, 1);
}));

test('the fingerprint reaches state.json on disk', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  const onDisk = JSON.parse(fs.readFileSync(cfg.getStatePath(), 'utf8'));
  assert.equal(onDisk.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX));
}));

test('the stored fingerprint is a hash, not the personal data it came from', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  const raw = fs.readFileSync(cfg.getStatePath(), 'utf8');
  for (const secret of ['alex.tester', 'Tester', '27312', '3365550100']) {
    assert.equal(raw.includes(secret), false, `state.json must not contain ${secret}`);
  }
}));

// ---- readers ---------------------------------------------------------------

test('a matching fingerprint is trusted: the 90-day cooldown applies', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  const skip = cfg.shouldSkip('Spokeo', { person: ALEX });
  assert.ok(skip, 'a fresh success for the same person must still skip');
  assert.match(skip.reason, /re-check in/);
}));

test('a mismatched fingerprint counts as never run for every reader', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  const o = { person: ALEX_NEW_ZIP };
  assert.equal(cfg.shouldSkip('Spokeo', o), null);
  assert.equal(cfg.lastOptOutDaysAgo('Spokeo', o), Infinity);
  assert.equal(cfg.lastAttemptDaysAgo('Spokeo', o), Infinity);
  assert.equal(cfg.isPendingConfirmation('Spokeo', o), false);
  assert.equal(cfg.readEntry(st, 'Spokeo', ALEX_NEW_ZIP, 1), undefined);
}));

test('a mismatched pending confirmation does not hold the corrected person back', () => withTempState(() => {
  cfg.recordPendingConfirmation('Spokeo', 'check your inbox', { person: ALEX });
  assert.ok(cfg.shouldSkip('Spokeo', { person: ALEX }), 'same person still waits out the 14-day window');
  assert.equal(cfg.shouldSkip('Spokeo', { person: { ...ALEX, email: 'alex.fixed@example.net' } }), null);
}));

test('entries without a fingerprint are trusted exactly as before', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: daysAgo(10), history: ['success'] };
  const skip = cfg.shouldSkip('Spokeo', { person: ALEX });
  assert.ok(skip, 'a legacy entry must keep suppressing the re-run');
  assert.ok(cfg.lastOptOutDaysAgo('Spokeo', { person: ALEX }) < 11);
  assert.equal(cfg.readEntry(st, 'Spokeo', ALEX, 1), st.optOuts.Spokeo);
}));

test('a lookup that names no person reads the literal key and ignores fingerprints', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  assert.ok(cfg.shouldSkip('Spokeo'));
  assert.ok(cfg.lastOptOutDaysAgo('Spokeo') < 1);
}));

test('multi-person: each person has their own entry and fingerprint', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo|Alex Tester', 'done', { person: ALEX });
  assert.ok(cfg.shouldSkip('Spokeo', { person: ALEX, personCount: 2, personIndex: 0 }));
  assert.equal(cfg.shouldSkip('Spokeo', { person: SAM, personCount: 2, personIndex: 1 }), null);
  assert.equal(cfg.readEntry(st, 'Spokeo', SAM, 2, { personIndex: 1 }), undefined);
}));

test('the legacy bare-key fallback for persons[0] checks the fingerprint too', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  assert.equal(cfg.readEntry(st, 'Spokeo', ALEX, 2, { personIndex: 0 }), st.optOuts.Spokeo);
  assert.equal(cfg.readEntry(st, 'Spokeo', ALEX_NEW_ZIP, 2, { personIndex: 0 }), undefined);
}));

test('a composite entry for another identity is never shadowed by the bare legacy key', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: daysAgo(5) };
  cfg.recordSuccess('Spokeo|Alex Tester', 'done', { person: ALEX });
  assert.equal(cfg.readEntry(st, 'Spokeo', ALEX_NEW_ZIP, 2, { personIndex: 0 }), undefined);
}));

test('two people with the same name no longer share history', () => withTempState(() => {
  const sr = { firstName: 'John', lastName: 'Smith', zip: '10001', email: 'john.sr@example.net', phone: '2125550101' };
  const jr = { ...sr, email: 'john.jr@example.net', phone: '2125550102' };
  cfg.recordSuccess('Spokeo|John Smith', 'done', { person: sr });
  assert.ok(cfg.shouldSkip('Spokeo', { person: sr, personCount: 2, personIndex: 0 }));
  assert.equal(cfg.shouldSkip('Spokeo', { person: jr, personCount: 2, personIndex: 1 }), null);
}));

// ---- writers meeting an entry that belongs to someone else -----------------

test('a success for a changed identity starts a fresh entry instead of inheriting the old one', () => withTempState((st) => {
  st.optOuts.Spokeo = {
    fp: cfg.personFingerprint(ALEX),
    lastSuccess: daysAgo(30),
    lastAttempt: daysAgo(30),
    lastDetail: 'old identity',
    totalRuns: 4,
    pendingConfirm: { since: daysAgo(40), snippet: 'old' },
    knowRequestedAt: daysAgo(50),
    history: ['success', 'success'],
  };
  cfg.recordSuccess('Spokeo', 'new identity', { person: ALEX_NEW_ZIP });
  const e = st.optOuts.Spokeo;
  assert.equal(e.fp, cfg.personFingerprint(ALEX_NEW_ZIP));
  assert.equal(e.totalRuns, 1, 'run count restarts for the new identity');
  assert.equal(e.lastDetail, 'new identity');
  assert.equal(e.pendingConfirm, undefined);
  assert.equal(e.knowRequestedAt, undefined);
  assert.ok(cfg.lastOptOutDaysAgo('Spokeo', { person: ALEX_NEW_ZIP }) < 1);
}));

test('broker-level history survives an identity change (drift and defunct are about the site)', () => withTempState((st) => {
  st.optOuts.Spokeo = { fp: cfg.personFingerprint(ALEX), lastSuccess: daysAgo(30), history: ['error', 'error'] };
  cfg.recordFailure('Spokeo', 'error', { person: ALEX_NEW_ZIP });
  assert.deepEqual(st.optOuts.Spokeo.history, ['error', 'error', 'error']);
  assert.equal(st.optOuts.Spokeo.lastSuccess, undefined, 'the old identity\'s success is not the new one\'s');
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX_NEW_ZIP));
}));

test('a pending confirmation for a changed identity does not keep the old success', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  cfg.recordPendingConfirmation('Spokeo', 'check your inbox', { person: ALEX_NEW_ZIP });
  assert.equal(st.optOuts.Spokeo.lastSuccess, undefined);
  assert.ok(st.optOuts.Spokeo.pendingConfirm);
  assert.deepEqual(cfg.getPendingConfirmations().map((p) => p.name), ['Spokeo']);
}));

test('a know request for a changed identity restarts the entry', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'done', { person: ALEX });
  cfg.recordKnowRequest('Spokeo', ALEX_NEW_ZIP, 1);
  assert.equal(st.optOuts.Spokeo.lastSuccess, undefined);
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX_NEW_ZIP));
  assert.ok(st.optOuts.Spokeo.knowRequestedAt);
}));

test('a success for the same identity keeps counting up', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'one', { person: ALEX });
  cfg.recordSuccess('Spokeo', 'two', { person: ALEX });
  assert.equal(st.optOuts.Spokeo.totalRuns, 2);
  assert.deepEqual(st.optOuts.Spokeo.history, ['success', 'success']);
}));

test('stamping a legacy entry keeps its history and last success', () => withTempState((st) => {
  const when = daysAgo(20);
  st.optOuts.Spokeo = { lastSuccess: when, history: ['success'], totalRuns: 3 };
  cfg.recordFailure('Spokeo', 'error', { person: ALEX });
  assert.equal(st.optOuts.Spokeo.lastSuccess, when);
  assert.equal(st.optOuts.Spokeo.totalRuns, 3);
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ALEX));
}));

test('the whole upgrade path: legacy entry, a re-run that stamps it, then a zip correction', () => withTempState(() => {
  const st = cfg.loadState();
  st.optOuts.Spokeo = { lastSuccess: daysAgo(10), history: ['success'] };
  assert.ok(cfg.shouldSkip('Spokeo', { person: ALEX }), 'upgrade alone re-runs nothing');

  st.optOuts.Spokeo.lastSuccess = daysAgo(100);
  assert.equal(cfg.shouldSkip('Spokeo', { person: ALEX }), null, 'the normal 90-day re-check still fires');
  cfg.recordSuccess('Spokeo', 'resubmitted', { person: ALEX });
  assert.ok(cfg.shouldSkip('Spokeo', { person: ALEX }));

  assert.equal(cfg.shouldSkip('Spokeo', { person: ALEX_NEW_ZIP }), null, 'the correction re-runs once the entry carries a fingerprint');
  cfg.recordSuccess('Spokeo', 'resubmitted again', { person: ALEX_NEW_ZIP });
  assert.ok(cfg.shouldSkip('Spokeo', { person: ALEX_NEW_ZIP }), 'and the cooldown then applies to the corrected identity');
}));
