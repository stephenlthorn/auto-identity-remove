/**
 * test/config-read-entry.test.js
 *
 * CFG-8: writer and reader keys disagreed.
 *
 *  - getPendingConfirmations / getPendingKnowRequests looked the broker
 *    definition up with the composite "Broker|First Last" key, so a multi-person
 *    run lost every broker's expectedSender.
 *  - Going from one person to two flips person 1 from the bare broker key to
 *    "Broker|Name", orphaning their history and re-submitting everything.
 *
 * readEntry() is the one reader: the entry for that person, and for persons[0]
 * only a fall back to the legacy bare key.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

const JOHN = { firstName: 'John', lastName: 'Smith' };
const JANE = { firstName: 'Jane', lastName: 'Smith' };

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-readentry-'));
  cfg.setTestStatePath(path.join(dir, 'state.json'));
  const st = cfg.loadState();
  for (const k of Object.keys(st)) delete st[k];
  st.optOuts = {};
  try { return fn(st); } finally {
    cfg.setTestStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const recent = () => new Date(Date.now() - 2 * 86400000).toISOString();

test('getPendingConfirmations finds expectedSender for a composite multi-person key', () => withTempState(() => {
  cfg.recordPendingConfirmation('Whitepages|John Smith', 'check your inbox');
  const out = cfg.getPendingConfirmations([{ name: 'Whitepages', expectedSender: 'x@whitepages.com' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Whitepages|John Smith');
  assert.equal(out[0].expectedSender, 'x@whitepages.com');
}));

test('getPendingConfirmations still works with a bare single-person key', () => withTempState(() => {
  cfg.recordPendingConfirmation('Whitepages', 'check your inbox');
  const out = cfg.getPendingConfirmations([{ name: 'Whitepages', expectedSender: 'x@whitepages.com' }]);
  assert.equal(out[0].expectedSender, 'x@whitepages.com');
}));

test('getPendingKnowRequests finds expectedSender for a composite multi-person key', () => withTempState(() => {
  cfg.recordKnowRequest('Whitepages', JOHN, 2);
  const out = cfg.getPendingKnowRequests([{ name: 'Whitepages', expectedSender: 'privacy@whitepages.com' }], { olderThanDays: 0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Whitepages|John Smith');
  assert.equal(out[0].expectedSender, 'privacy@whitepages.com');
}));

test('readEntry returns the composite entry for a multi-person run', () => withTempState((st) => {
  st.optOuts['Spokeo|Jane Smith'] = { lastSuccess: recent() };
  assert.equal(cfg.readEntry(st, 'Spokeo', JANE, 2, { personIndex: 1 }), st.optOuts['Spokeo|Jane Smith']);
}));

test('readEntry with one person (or no person) uses the bare key', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  assert.equal(cfg.readEntry(st, 'Spokeo', JOHN, 1), st.optOuts.Spokeo);
  assert.equal(cfg.readEntry(st, 'Spokeo', null, 2), st.optOuts.Spokeo);
  assert.equal(cfg.readEntry(st, 'Spokeo', undefined, undefined), st.optOuts.Spokeo);
}));

test('persons[0] falls back to the legacy bare key when going from one person to two', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent(), totalRuns: 4 };
  assert.equal(cfg.readEntry(st, 'Spokeo', JOHN, 2, { personIndex: 0 }), st.optOuts.Spokeo);
}));

test('persons[1] must NOT inherit persons[0]\'s legacy bare-key history', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  assert.equal(cfg.readEntry(st, 'Spokeo', JANE, 2, { personIndex: 1 }), undefined);
}));

test('without an index, no fallback happens (never guess who persons[0] is)', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  assert.equal(cfg.readEntry(st, 'Spokeo', JOHN, 2), undefined);
}));

test('persons[0] can also be identified by passing the persons array', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  const persons = [JOHN, JANE];
  assert.equal(cfg.readEntry(st, 'Spokeo', JOHN, 2, { persons }), st.optOuts.Spokeo);
  assert.equal(cfg.readEntry(st, 'Spokeo', JANE, 2, { persons }), undefined);
}));

test('the composite entry wins over the legacy one once both exist', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent(), totalRuns: 1 };
  st.optOuts['Spokeo|John Smith'] = { lastSuccess: recent(), totalRuns: 9 };
  assert.equal(cfg.readEntry(st, 'Spokeo', JOHN, 2, { personIndex: 0 }).totalRuns, 9);
}));

test('shouldSkip honours the legacy entry for persons[0] and not for persons[1]', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  const first = cfg.shouldSkip('Spokeo', { person: JOHN, personCount: 2, personIndex: 0 });
  assert.ok(first && /re-check/.test(first.reason), 'person 1 is still inside the 90-day window');
  assert.equal(cfg.shouldSkip('Spokeo', { person: JANE, personCount: 2, personIndex: 1 }), null);
}));

test('shouldSkip with a literal key (the old calling convention) is unchanged', () => withTempState((st) => {
  st.optOuts['Spokeo|Jane Smith'] = { lastSuccess: recent() };
  assert.ok(cfg.shouldSkip('Spokeo|Jane Smith'));
  assert.equal(cfg.shouldSkip('Spokeo'), null);
}));

test('the pending-confirmation helpers take the same person options', () => withTempState((st) => {
  st.optOuts.Spokeo = { pendingConfirm: { since: recent(), snippet: 's' }, lastAttempt: recent() };
  const o = { person: JOHN, personCount: 2, personIndex: 0 };
  assert.equal(cfg.isPendingConfirmation('Spokeo', o), true);
  assert.ok(cfg.lastAttemptDaysAgo('Spokeo', o) < 5);
  assert.equal(cfg.isPendingConfirmation('Spokeo', { ...o, person: JANE, personIndex: 1 }), false);
  assert.ok(cfg.shouldSkip('Spokeo', o).reason.includes('Pending'));
}));

test('lastOptOutDaysAgo takes the same person options', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: recent() };
  assert.ok(cfg.lastOptOutDaysAgo('Spokeo', { person: JOHN, personCount: 2, personIndex: 0 }) < 5);
  assert.equal(cfg.lastOptOutDaysAgo('Spokeo', { person: JANE, personCount: 2, personIndex: 1 }), Infinity);
}));
