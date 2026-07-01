// test/resume-checkpoint.test.js
/**
 * B22: --resume must match the checkpoint via stateKey, not bare broker.name.
 *
 * saveCheckpoint stores the composite key "Broker|First Last" in multi-person
 * mode. The resume matcher must compute the same composite key per broker so it
 * finds the checkpoint instead of silently re-running everything.
 *
 * findResumeIndex(brokers, checkpoint, person, totalPersons) is PURE and
 * returns the index of the broker whose stateKey equals the checkpoint, or -1.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findResumeIndex } = require('../lib/config');

const BROKERS = [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }];
const JANE = { firstName: 'Jane', lastName: 'Doe' };

test('single-person: matches on the bare broker name', () => {
  assert.equal(findResumeIndex(BROKERS, 'Bravo', JANE, 1), 1);
});

test('multi-person: matches on the composite stateKey', () => {
  assert.equal(findResumeIndex(BROKERS, 'Bravo|Jane Doe', JANE, 2), 1);
});

test('multi-person: a bare checkpoint does NOT spuriously match the composite key', () => {
  // Under the old bare-name matcher this returned an index; now it must miss.
  assert.equal(findResumeIndex(BROKERS, 'Bravo', JANE, 2), -1);
});

test('returns -1 when the checkpoint broker is not in the list', () => {
  assert.equal(findResumeIndex(BROKERS, 'Zeta|Jane Doe', JANE, 2), -1);
});

test('returns -1 for a null/empty checkpoint', () => {
  assert.equal(findResumeIndex(BROKERS, null, JANE, 1), -1);
  assert.equal(findResumeIndex(BROKERS, '', JANE, 1), -1);
});
