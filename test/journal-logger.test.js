/**
 * test/journal-logger.test.js
 *
 * R3: lib/logger.js gains setJournal(journal|null). While one is set, every
 * logResult() entry is appended to it as it happens. With none set nothing
 * changes, so every existing logger test keeps passing untouched.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logger = require('../lib/logger');
const { openJournal, readJournal, resultsFromJournal } = require('../lib/journal');

let origLog;
let dir;
beforeEach(() => {
  origLog = console.log;
  console.log = () => {};
  logger.resetResults();
  logger.setCurrentPerson(null);
  logger.setJournal(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-journal-logger-'));
});
afterEach(() => {
  console.log = origLog;
  logger.setJournal(null);
  logger.setCurrentPerson(null);
  logger.resetResults();
  fs.rmSync(dir, { recursive: true, force: true });
});

const journalFile = () => path.join(dir, 'run-a.jsonl');

test('with no journal set, logResult behaves exactly as before', () => {
  logger.logResult('Spokeo', 'success', 'ok');
  assert.equal(logger.results.succeeded.length, 1);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written anywhere');
});

test('while a journal is set, every logResult entry is appended as it happens', () => {
  logger.setJournal(openJournal(journalFile()));
  logger.logResult('Spokeo', 'success', 'ok');
  // No close: the entry must already be on disk.
  assert.deepEqual(readJournal(journalFile()).entries.map(e => e.broker), ['Spokeo']);

  logger.logResult('Radaris', 'error', 'boom');
  assert.deepEqual(readJournal(journalFile()).entries.map(e => e.broker), ['Spokeo', 'Radaris']);
});

test('the journaled entry is the same entry the results bucket holds, person and host included', () => {
  logger.setJournal(openJournal(journalFile()));
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  logger.logResult('Acme Data', 'dead', 'HTTP 404', { host: 'acme.example' });

  const [journaled] = readJournal(journalFile()).entries;
  assert.deepEqual(journaled, logger.results.dead[0]);
  assert.equal(journaled.person, 'Jane Doe');
  assert.equal(journaled.host, 'acme.example');
});

test('a journal replayed through resultsFromJournal reproduces the live buckets', () => {
  logger.setJournal(openJournal(journalFile()));
  logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
  for (const status of Object.keys(logger.STATUS_BUCKET)) logger.logResult(`b-${status}`, status, 'd');
  logger.setCurrentPerson({ firstName: 'John', lastName: 'Roe' });
  logger.logResult('Spokeo', 'error', 'second person');
  logger.logResult('Odd', 'not-a-status', 'falls into errors');

  const rebuilt = resultsFromJournal(readJournal(journalFile()));
  for (const bucket of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors', 'dead', 'pendingConfirm', 'unverified']) {
    assert.deepEqual(rebuilt[bucket], logger.results[bucket], `${bucket} matches`);
  }
});

test('setJournal(null) stops journaling; results still accumulate', () => {
  logger.setJournal(openJournal(journalFile()));
  logger.logResult('A', 'success');
  logger.setJournal(null);
  logger.logResult('B', 'success');

  assert.deepEqual(readJournal(journalFile()).entries.map(e => e.broker), ['A']);
  assert.equal(logger.results.succeeded.length, 2);
});

test('a journal that throws never breaks logResult', () => {
  logger.setJournal({ append() { throw new Error('disk on fire'); }, close() {} });
  assert.doesNotThrow(() => logger.logResult('Spokeo', 'success', 'ok'));
  assert.equal(logger.results.succeeded.length, 1, 'the in-memory result is kept regardless');
});

test('resetResults leaves the journal attached: it is a record, not run state', () => {
  logger.setJournal(openJournal(journalFile()));
  logger.logResult('A', 'success');
  logger.resetResults();
  logger.logResult('B', 'error');

  assert.deepEqual(readJournal(journalFile()).entries.map(e => e.broker), ['A', 'B']);
});

test('the journal sees an entry before the console line, so a crash mid-print loses nothing', () => {
  const seen = [];
  logger.setJournal({ append: entry => seen.push(['journal', entry.broker]), close() {} });
  console.log = () => seen.push(['console']);
  logger.logResult('Spokeo', 'success');
  assert.deepEqual(seen.map(s => s[0]), ['journal', 'console']);
});
