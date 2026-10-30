/**
 * test/logger-person-and-unverified.test.js
 *
 * CFG-13: results entries carried no person, so a two-person run produced an
 * audit that named only persons[0] and a diff that merged identical broker
 * rows. The watcher now tags the person being processed through
 * setCurrentPerson() and every logResult entry carries it.
 *
 * CORE-15b: the summary must keep three outcomes apart - accepted submission,
 * awaiting an email click, and "submitted but the result could not be read".
 * The last one used to share the errors bucket, and other packages now emit
 * `unverified`, so it needs its own count: it must never read as success and
 * must not be mislabelled as a failure either.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../lib/logger');

let origLog;
beforeEach(() => {
  origLog = console.log;
  console.log = () => {};
  logger.resetResults();
  logger.setCurrentPerson(null);
});
afterEach(() => {
  console.log = origLog;
  logger.setCurrentPerson(null);
  logger.resetResults();
});

// ── setCurrentPerson ─────────────────────────────────────────────────────────

test('logResult tags entries with the current person as "First Last"', () => {
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.logResult('Spokeo', 'success', 'ok');
  assert.equal(logger.results.succeeded[0].person, 'Jane Doe');
});

test('the person tag survives the JSON run log round trip', () => {
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.logResult('Spokeo', 'error', 'boom');
  const reloaded = JSON.parse(JSON.stringify(logger.results));
  assert.equal(reloaded.errors[0].person, 'Jane Doe');
});

test('setCurrentPerson(null) stops tagging and the key is omitted, not null', () => {
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.setCurrentPerson(null);
  logger.logResult('Spokeo', 'success');
  assert.equal('person' in logger.results.succeeded[0], false);
});

test('tagging follows whoever is current when the result is logged', () => {
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.logResult('Spokeo', 'success');
  logger.setCurrentPerson({ firstName: 'John', lastName: 'Smith' });
  logger.logResult('Spokeo', 'error', 'timeout');
  assert.equal(logger.results.succeeded[0].person, 'Jane Doe');
  assert.equal(logger.results.errors[0].person, 'John Smith');
});

test('a person with only a first name is tagged by that name; a blank person is untagged', () => {
  logger.setCurrentPerson({ firstName: 'Madonna' });
  logger.logResult('A', 'success');
  logger.setCurrentPerson({ firstName: '', lastName: '  ' });
  logger.logResult('B', 'success');
  assert.equal(logger.results.succeeded[0].person, 'Madonna');
  assert.equal('person' in logger.results.succeeded[1], false);
});

test('resetResults also clears the current person so tests and verify runs stay isolated', () => {
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.resetResults();
  logger.logResult('A', 'success');
  assert.equal('person' in logger.results.succeeded[0], false);
});

// ── unverified is its own outcome ────────────────────────────────────────────

test('unverified results land in their own bucket, not errors and not succeeded', () => {
  logger.logResult('Whitepages', 'unverified', 'no explicit confirmation - re-check next run');
  assert.equal(logger.STATUS_BUCKET.unverified, 'unverified');
  assert.equal(logger.results.unverified.length, 1);
  assert.equal(logger.results.unverified[0].broker, 'Whitepages');
  assert.equal(logger.results.errors.length, 0);
  assert.equal(logger.results.succeeded.length, 0);
});

test('resetResults empties the unverified bucket', () => {
  logger.logResult('Whitepages', 'unverified');
  logger.resetResults();
  assert.deepEqual(logger.results.unverified, []);
});

test('buildSummary counts unverified separately from submitted, errors and awaiting-confirm', () => {
  logger.logResult('A', 'success');
  logger.logResult('B', 'unverified', 'could not read the result page');
  logger.logResult('C', 'unverified');
  logger.logResult('D', 'error', 'timeout');
  logger.logResult('E', 'pending_confirm');

  const s = logger.buildSummary();

  assert.match(s, /Submitted \(form accepted\):\s+1\b/);
  assert.match(s, /Submitted, result unconfirmed:\s+2\b/);
  assert.match(s, /Errors:\s+1\b/);
  assert.match(s, /Awaiting email confirm:\s+1\b/);
});

test('buildSummary lists each unverified broker with its detail so the user can check it', () => {
  logger.logResult('Whitepages', 'unverified', 'no explicit confirmation - re-check next run');
  const s = logger.buildSummary();
  assert.match(s, /Whitepages/);
  assert.match(s, /no explicit confirmation/);
});

test('buildSummary omits the unverified block when there are none', () => {
  logger.logResult('A', 'success');
  const s = logger.buildSummary();
  assert.equal(/unconfirmed/i.test(s), false);
});

// ── wording ──────────────────────────────────────────────────────────────────

test('the summary calls a form submission "Submitted", never "Removed"', () => {
  logger.logResult('A', 'success');
  const s = logger.buildSummary();
  assert.match(s, /Submitted/);
  assert.equal(/removed/i.test(s), false, 'a submitted form is not a confirmed removal');
});

test('the drift section prints once setStateForSummary has been given a state', () => {
  // CORE-15b: nothing called setStateForSummary, so the drift section never
  // appeared. The watcher wiring is separate; this pins that the logger side works.
  const history = ['error', 'error', 'error'];
  const lastSuccess = new Date(Date.now() - 40 * 86400000).toISOString();
  logger.setStateForSummary({ optOuts: { Spokeo: { history, lastSuccess } } });
  try {
    const s = logger.buildSummary();
    assert.match(s, /Drift detected/);
    assert.match(s, /Spokeo/);
  } finally {
    logger.setStateForSummary(null);
  }
});
