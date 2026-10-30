/**
 * test/identity-fingerprint-phone.test.js
 *
 * CFG2-7. The identity fingerprint used to include the raw phone digits, so
 * adding a phone, or writing it +1 512... instead of 512..., made shouldSkip
 * answer "never run" for every broker: a mass re-run for a cosmetic edit, with
 * totalRuns reset to 1. And removing person B orphaned person A's composite
 * entries: with the person count back at one, readEntry looked only at the bare
 * key, which could be months stale.
 *
 * The fingerprint is now name + zip5 + email. State stamped with the old
 * five-field hash (the integration branch wrote it; released installs never
 * stamped anything) keeps matching while the phone is the same, was absent when
 * the entry was written, or differs only by a leading 1.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

const ANN = { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345', country: 'US' };
const BOB = { firstName: 'Bob', lastName: 'Probe', email: 'bob@example.test', zip: '12345', country: 'US' };

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// The pre-CFG2-7 digest, spelled out so the test does not depend on the code under test.
function legacyFp(person, phoneDigits) {
  const parts = [person.firstName, person.lastName, person.zip.slice(0, 5), person.email, phoneDigits]
    .map((v) => String(v).trim().toLowerCase());
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-fp-phone-'));
  cfg.setTestStatePath(path.join(dir, 'state.json'));
  const st = cfg.loadState();
  for (const k of Object.keys(st)) delete st[k];
  st.optOuts = {};
  try { return fn(st); } finally {
    cfg.setTestStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('adding a phone to a person who just ran still skips (the CFG2-7 probe)', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'ok', { person: ANN });
  assert.ok(cfg.shouldSkip('Spokeo', { person: ANN }));
  assert.ok(cfg.shouldSkip('Spokeo', { person: { ...ANN, phone: '5125550000' } }), 'phone added');
  assert.ok(cfg.shouldSkip('Spokeo', { person: { ...ANN, phone: '+1 512 555 0000' } }), 'phone with +1');
}));

test('re-running after a phone edit keeps one entry and counts the runs', () => withTempState((st) => {
  cfg.recordSuccess('Spokeo', 'ok', { person: { ...ANN, phone: '5125550000' } });
  cfg.recordSuccess('Spokeo', 'again', { person: { ...ANN, phone: '15125550000' } });
  assert.equal(st.optOuts.Spokeo.totalRuns, 2, 'the history survives a reformatted phone');
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ANN));
}));

test('a corrected zip or email is still a different identity', () => withTempState(() => {
  cfg.recordSuccess('Spokeo', 'ok', { person: ANN });
  assert.equal(cfg.shouldSkip('Spokeo', { person: { ...ANN, zip: '54321' } }), null);
  assert.equal(cfg.shouldSkip('Spokeo', { person: { ...ANN, email: 'ann2@example.test' } }), null);
}));

// ---- entries stamped by the five-field hash --------------------------------

test('an entry stamped with the legacy hash still matches the same person', () => withTempState((st) => {
  const withPhone = { ...ANN, phone: '5125550000' };
  st.optOuts.Spokeo = { lastSuccess: daysAgo(5), totalRuns: 4, fp: legacyFp(ANN, '5125550000') };
  assert.ok(cfg.shouldSkip('Spokeo', { person: withPhone }), 'same phone');
  assert.ok(cfg.shouldSkip('Spokeo', { person: { ...withPhone, phone: '(512) 555-0000' } }), 'same digits');
}));

test('a legacy entry written before the phone existed still matches after it is added', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: daysAgo(5), totalRuns: 4, fp: legacyFp(ANN, '') };
  assert.ok(cfg.shouldSkip('Spokeo', { person: { ...ANN, phone: '5125550000' } }));
}));

test('a legacy entry still matches when the phone only gained or lost a leading 1', () => withTempState((st) => {
  st.optOuts.A = { lastSuccess: daysAgo(5), fp: legacyFp(ANN, '5125550000') };
  st.optOuts.B = { lastSuccess: daysAgo(5), fp: legacyFp(ANN, '15125550000') };
  const p10 = { ...ANN, phone: '5125550000' };
  const p11 = { ...ANN, phone: '+1 (512) 555-0000' };
  assert.ok(cfg.shouldSkip('A', { person: p11 }));
  assert.ok(cfg.shouldSkip('B', { person: p10 }));
}));

test('a legacy entry for another identity does not match', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: daysAgo(5), fp: legacyFp(ANN, '5125550000') };
  assert.equal(cfg.shouldSkip('Spokeo', { person: { ...ANN, zip: '54321', phone: '5125550000' } }), null);
  assert.equal(cfg.shouldSkip('Spokeo', { person: { ...BOB, phone: '5125550000' } }), null);
}));

test('writing over a matching legacy entry keeps its history and restamps it', () => withTempState((st) => {
  st.optOuts.Spokeo = { lastSuccess: daysAgo(40), totalRuns: 4, history: ['success', 'error'], fp: legacyFp(ANN, '5125550000') };
  cfg.recordSuccess('Spokeo', 'again', { person: { ...ANN, phone: '5125550000' } });
  assert.equal(st.optOuts.Spokeo.totalRuns, 5);
  assert.deepEqual(st.optOuts.Spokeo.history, ['success', 'error', 'success']);
  assert.equal(st.optOuts.Spokeo.fp, cfg.personFingerprint(ANN));
}));

test('fingerprintMatches is exported and answers for both generations', () => {
  assert.equal(typeof cfg.fingerprintMatches, 'function');
  assert.equal(cfg.fingerprintMatches(cfg.personFingerprint(ANN), ANN), true);
  assert.equal(cfg.fingerprintMatches(legacyFp(ANN, ''), { ...ANN, phone: '5125550000' }), true);
  assert.equal(cfg.fingerprintMatches('deadbeefdeadbeef', ANN), false);
  assert.equal(cfg.fingerprintMatches(undefined, ANN), false);
});

// ---- the person count drops -------------------------------------------------

test('after person B is removed, A reads the fresher of the composite and bare entries', () => withTempState((st) => {
  st.optOuts.Whitepages = { lastSuccess: daysAgo(200), totalRuns: 1 };
  st.optOuts['Whitepages|Ann Probe'] = { lastSuccess: daysAgo(3), totalRuns: 2 };
  const skip = cfg.shouldSkip('Whitepages', { person: ANN, personCount: 1, personIndex: 0 });
  assert.ok(skip, 'the two-person-era entry is not ignored');
  assert.match(skip.reason, /3d ago/);
}));

test('the bare entry wins when it is the fresher one', () => withTempState((st) => {
  st.optOuts.Whitepages = { lastSuccess: daysAgo(2), totalRuns: 3 };
  st.optOuts['Whitepages|Ann Probe'] = { lastSuccess: daysAgo(100), totalRuns: 2 };
  const skip = cfg.shouldSkip('Whitepages', { person: ANN, personCount: 1, personIndex: 0 });
  assert.match(skip.reason, /2d ago/);
}));

test('a composite entry stamped for another identity is not adopted when the count drops', () => withTempState((st) => {
  st.optOuts['Whitepages|Ann Probe'] = { lastSuccess: daysAgo(3), fp: cfg.personFingerprint({ ...ANN, zip: '99999' }) };
  assert.equal(cfg.shouldSkip('Whitepages', { person: ANN, personCount: 1, personIndex: 0 }), null);
}));

test('readEntry in single-person mode with no composite entry is unchanged', () => {
  const st = { optOuts: { Whitepages: { lastSuccess: daysAgo(9) } } };
  assert.equal(cfg.readEntry(st, 'Whitepages', ANN, 1), st.optOuts.Whitepages);
  assert.equal(cfg.readEntry(st, 'Whitepages', null, 1), st.optOuts.Whitepages);
  assert.equal(cfg.readEntry({ optOuts: {} }, 'Whitepages', ANN, 1), undefined);
});

test('multi-person reads are unchanged: persons[1] never inherits the bare entry', () => {
  const st = { optOuts: { Whitepages: { lastSuccess: daysAgo(9) } } };
  assert.equal(cfg.readEntry(st, 'Whitepages', BOB, 2, { personIndex: 1 }), undefined);
  assert.equal(cfg.readEntry(st, 'Whitepages', ANN, 2, { personIndex: 0 }), st.optOuts.Whitepages);
});
