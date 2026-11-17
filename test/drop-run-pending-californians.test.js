/**
 * test/drop-run-pending-californians.test.js
 *
 * `pending` tells the caller it may open the DROP page for somebody. It is for California
 * residents who have no recorded request, never for a person the platform is not for.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runDrop } = require('../lib/drop');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', country: 'US', email: 'jane@sample.example' };
const BOB = { firstName: 'Bob', lastName: 'Sample', state: 'TX', country: 'US', email: 'bob@sample.example' };
const run = (persons, state = {}) => runDrop({ persons, state, options: {}, registryCount: 0, today: '2026-11-17', save: () => {} });

test('a person outside California is never pending', () => {
  assert.equal(run([BOB]).pending, false);
});

test('a California person with no record is pending, and with a record is not', () => {
  assert.equal(run([JANE]).pending, true);
  const recorded = { drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
  assert.equal(run([JANE], recorded).pending, false);
});

test('somebody else in California being pending does not depend on a non-resident in the same run', () => {
  assert.equal(run([BOB, JANE]).pending, true);
});
