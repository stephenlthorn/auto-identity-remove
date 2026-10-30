/**
 * test/complaint-owner-and-fp.test.js
 *
 * CFG2-6. A complaint is signed by a configured person and asserts facts about
 * their data, so an entry may only become one when it is demonstrably theirs:
 *
 *   - Bob was removed from the config; his "Spokeo|Bob Probe" entry still sits in
 *     state.json. findOverdue returned it, the watcher found no person named Bob
 *     and fell back to persons[0], and a complaint went out "Signed, Ann" over
 *     Bob's record. A label that maps to nobody configured is skipped.
 *   - An entry stamped with another identity's fingerprint (Ann corrected her zip
 *     or email) says nothing about the current Ann; readEntry already calls that
 *     "never run". findOverdue now agrees.
 *
 * With no persons passed at all there is nothing to resolve against, and the
 * function behaves as it always did (complaint-find-overdue.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { findOverdue, findOverdueKnowRequests } = require('../lib/complaint');
const { personFingerprint } = require('../lib/identity');

const NOW = new Date('2026-06-09T00:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const listed = (days, extra = {}) => ({ lastSuccess: daysBefore(days), verifiedStillListedAt: daysBefore(1), ...extra });

const ANN = { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '73301', state: 'TX' };
const BOB = { firstName: 'Bob', lastName: 'Probe', email: 'bob@example.test', zip: '73301', state: 'TX' };

test('an entry whose person is no longer configured is not turned into a complaint (the CFG2-6 probe)', () => {
  const state = { optOuts: { 'Spokeo|Bob Probe': listed(100, { fp: 'deadbeefdeadbeef' }) } };
  assert.deepEqual(findOverdue(state, { now: NOW, persons: [ANN] }), []);
});

test('the same holds with several configured people: a removed person is skipped', () => {
  const carol = { firstName: 'Carol', lastName: 'Probe', email: 'carol@example.test', zip: '73301' };
  const state = { optOuts: { 'Spokeo|Bob Probe': listed(100), 'Spokeo|Ann Probe': listed(100) } };
  const out = findOverdue(state, { now: NOW, persons: [ANN, carol] });
  assert.deepEqual(out.map((o) => o.person), ['Ann Probe']);
});

test('an entry for a configured person still produces a complaint', () => {
  const state = { optOuts: { 'Spokeo|Ann Probe': listed(100) } };
  const out = findOverdue(state, { now: NOW, persons: [ANN, BOB] });
  assert.equal(out.length, 1);
  assert.equal(out[0].person, 'Ann Probe');
});

test('an entry stamped for a different identity is skipped (bare key, sole person)', () => {
  const stamp = personFingerprint({ ...ANN, zip: '99999' });
  const state = { optOuts: { Spokeo: listed(100, { fp: stamp }) } };
  assert.deepEqual(findOverdue(state, { now: NOW, persons: [ANN] }), []);
});

test('an entry stamped for a different identity is skipped (composite key)', () => {
  const stamp = personFingerprint({ ...ANN, email: 'someone-else@example.test' });
  const state = { optOuts: { 'Spokeo|Ann Probe': listed(100, { fp: stamp }) } };
  assert.deepEqual(findOverdue(state, { now: NOW, persons: [ANN, BOB] }), []);
});

test('an entry stamped for this identity, or not stamped at all, still counts', () => {
  const state = {
    optOuts: {
      Stamped: listed(100, { fp: personFingerprint(ANN) }),
      Unstamped: listed(100),
    },
  };
  const out = findOverdue(state, { now: NOW, persons: [ANN] });
  assert.deepEqual(out.map((o) => o.broker).sort(), ['Stamped', 'Unstamped']);
});

test('an entry carrying the first-generation fingerprint (phone included) still counts', () => {
  const legacy = crypto.createHash('sha256')
    .update(['ann', 'probe', '73301', 'ann@example.test', '5125550000'].join('\n')).digest('hex').slice(0, 16);
  const state = { optOuts: { Spokeo: listed(100, { fp: legacy }) } };
  const out = findOverdue(state, { now: NOW, persons: [{ ...ANN, phone: '5125550000' }] });
  assert.equal(out.length, 1);
});

test('with no persons to resolve against nothing is filtered (unchanged behaviour)', () => {
  const state = { optOuts: { 'Spokeo|Bob Probe': listed(100, { fp: 'deadbeefdeadbeef' }), Whitepages: listed(100) } };
  assert.equal(findOverdue(state, { now: NOW }).length, 2);
  assert.equal(findOverdue(state, { now: NOW, persons: [] }).length, 2);
});

test('when a person has both a bare and a composite entry, the fresher request decides', () => {
  const state = { optOuts: { Spokeo: listed(200), 'Spokeo|Ann Probe': { lastSuccess: daysBefore(3) } } };
  assert.deepEqual(findOverdue(state, { now: NOW, persons: [ANN] }), [], 'a request sent 3 days ago is not overdue');
});

test('the older of the two does not hide an overdue newer one', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysBefore(300) }, 'Spokeo|Ann Probe': listed(100) } };
  const out = findOverdue(state, { now: NOW, persons: [ANN] });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(100));
});

// ---- right-to-know follows the same ownership rules -------------------------

test('overdue right-to-know requests for a removed person or another identity are not reported', () => {
  const stamp = personFingerprint({ ...ANN, zip: '99999' });
  const state = {
    optOuts: {
      'Spokeo|Bob Probe': { knowRequestedAt: daysBefore(100) },
      Whitepages: { knowRequestedAt: daysBefore(100), fp: stamp },
      Radaris: { knowRequestedAt: daysBefore(100) },
    },
  };
  const out = findOverdueKnowRequests(state, { now: NOW, persons: [ANN] });
  assert.deepEqual(out.map((o) => o.broker), ['Radaris']);
});
