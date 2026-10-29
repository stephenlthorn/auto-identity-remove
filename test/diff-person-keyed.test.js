/**
 * test/diff-person-keyed.test.js
 *
 * CFG-13: diffResults matched brokers by name alone. With two people in the
 * run, "Jane succeeded at Spokeo, John errored at Spokeo" looked like a
 * regression (Spokeo was in last run's succeeded list and is in this run's
 * errors list), and Jane's rows hid John's. Rows are now keyed by person AND
 * broker.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { diffResults } = require('../lib/diff');

const JANE = 'Jane Doe';
const JOHN = 'John Smith';

function run(over = {}) {
  return {
    succeeded: [], notFound: [], errors: [], skipped: [],
    captchaFailed: [], pendingConfirm: [], manual: [], unverified: [],
    ...over,
  };
}

const entry = (broker, person, status = 'success') => (person ? { broker, status, person } : { broker, status });

test('Jane succeeded and John errored at the same broker is not a regression', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE)] });
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    errors: [entry('Spokeo', JOHN, 'error')],
  });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.regressed, []);
  assert.deepEqual(diff.newExposures, []);
});

test('a real regression is attributed to the person it happened to', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE), entry('Spokeo', JOHN)] });
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    errors: [entry('Spokeo', JOHN, 'error')],
  });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.regressed, [`Spokeo (${JOHN})`]);
});

test('a broker newly removed for John while Jane was already removed counts once, for John', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE)] });
  const curr = run({ succeeded: [entry('Spokeo', JANE), entry('Spokeo', JOHN)] });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.newlyRemoved, [`Spokeo (${JOHN})`]);
});

test('John not being listed does not read as an exposure just because Jane was removed there', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE)] });
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    notFound: [entry('Spokeo', JOHN, 'notFound')],
  });
  assert.deepEqual(diffResults(prev, curr).newExposures, []);
});

test('a real new exposure is attributed to the person', () => {
  const prev = run({ succeeded: [entry('Radaris', JOHN), entry('Radaris', JANE)] });
  const curr = run({
    succeeded: [entry('Radaris', JANE)],
    notFound: [entry('Radaris', JOHN, 'notFound')],
  });
  assert.deepEqual(diffResults(prev, curr).newExposures, [`Radaris (${JOHN})`]);
});

test('a single person keeps plain broker names even when every entry is tagged', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE), entry('Radaris', JANE)] });
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    errors: [entry('Radaris', JANE, 'error')],
  });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.regressed, ['Radaris']);
});

test('a previous log written before entries carried a person still diffs by broker', () => {
  const prev = run({ succeeded: [entry('Spokeo'), entry('Radaris')] });
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    errors: [entry('Radaris', JANE, 'error')],
  });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.regressed, ['Radaris']);
  assert.deepEqual(diff.newlyRemoved, []);
});

test('an untagged current row matches a tagged previous row for the same broker', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE)] });
  const curr = run({ errors: [entry('Spokeo', null, 'error')] });
  assert.deepEqual(diffResults(prev, curr).regressed, ['Spokeo']);
});

test('an unverified submission is neither a removal nor a regression', () => {
  const prev = run({ succeeded: [entry('Spokeo', JANE)] });
  const curr = run({ unverified: [entry('Spokeo', JANE, 'unverified')] });
  const diff = diffResults(prev, curr);
  assert.deepEqual(diff.newlyRemoved, []);
  assert.deepEqual(diff.regressed, []);
});

test('with no previous run, every attempted row is listed per person, unverified included', () => {
  const curr = run({
    succeeded: [entry('Spokeo', JANE)],
    unverified: [entry('Whitepages', JOHN, 'unverified')],
  });
  const diff = diffResults(null, curr);
  assert.deepEqual(diff.newlyRemoved.sort(), [`Spokeo (${JANE})`, `Whitepages (${JOHN})`].sort());
  assert.match(diff.summary, /2 newly attempted/);
});
