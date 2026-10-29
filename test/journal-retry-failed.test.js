/**
 * test/journal-retry-failed.test.js
 *
 * R3: `--retry-failed` reads the newest run's log. A run that crashed never
 * wrote its summary, so before the journal there was nothing to read (the user
 * got "no previous log found" and a full re-run, or worse, the failures of the
 * run BEFORE the crash). With the journal the failures up to the crash are
 * retried.
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadLastLog, extractFailedBrokers, makeBrokerPredicate } = require('../lib/filter');
const { openJournal } = require('../lib/journal');
const logger = require('../lib/logger');

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-retry-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: 't', ...extra });

function crashedJournal(dir, stem, entries) {
  const journal = openJournal(path.join(dir, `${stem}.jsonl`), { startedAt: '2026-10-29T09:00:00.000Z', mode: 'run' });
  for (const e of entries) journal.append(e);
}

test('retry-failed from a journal-only run retries what failed before the crash', () => {
  const dir = tmpDir();
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [
    entry('Spokeo', 'success'),
    entry('Radaris', 'error', { detail: 'timeout' }),
    entry('Acme', 'captcha_failed', { detail: 'https://acme.example/optout' }),
    entry('Pending Co', 'pending_confirm'),
    entry('Maybe Co', 'unverified'),
    entry('Gone Co', 'dead'),
    entry('Fresh Co', 'skipped'),
  ]);

  const failed = extractFailedBrokers(loadLastLog(dir));
  assert.deepEqual([...failed].sort(), ['Acme', 'Maybe Co', 'Pending Co', 'Radaris']);
});

test('the retry set from a journal drives the same include predicate the watcher builds', () => {
  const dir = tmpDir();
  crashedJournal(dir, 'run-a', [entry('Spokeo', 'success'), entry('Radaris', 'error')]);

  const include = makeBrokerPredicate({ retryFailedFromLog: extractFailedBrokers(loadLastLog(dir)) });
  assert.equal(include('radaris'), true);
  assert.equal(include('Spokeo'), false);
});

test('retry-failed prefers the newest run even when it is only a journal', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-28T09-00-00.json'), JSON.stringify({ errors: [{ broker: 'FromOldSummary' }] }));
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('FromCrashedJournal', 'error')]);

  const failed = extractFailedBrokers(loadLastLog(dir));
  assert.deepEqual([...failed], ['FromCrashedJournal'], 'the crashed run is the newest evidence');
});

test('a finished run still reads from its summary, not its journal', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-29T09-00-00.json'), JSON.stringify({ errors: [{ broker: 'FromSummary' }] }));
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('FromJournal', 'error')]);

  assert.deepEqual([...extractFailedBrokers(loadLastLog(dir))], ['FromSummary']);
});

test('a run that died before logging anything falls back to the last real log', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-28T09-00-00.json'), JSON.stringify({ errors: [{ broker: 'Spokeo' }] }));
  crashedJournal(dir, 'run-2026-10-29T09-00-00', []);

  assert.deepEqual([...extractFailedBrokers(loadLastLog(dir))], ['Spokeo']);
});

test('the run in progress is never its own retry source', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-28T09-00-00.json'), JSON.stringify({ errors: [{ broker: 'Spokeo' }] }));
  // The watcher has already opened this run's journal and logged one failure.
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('Radaris', 'error')]);

  const log = loadLastLog(dir, { exclude: path.join(dir, 'run-2026-10-29T09-00-00.json') });
  assert.deepEqual([...extractFailedBrokers(log)], ['Spokeo']);
});

test('the rebuilt log says it came from a journal and that the run did not finish', () => {
  const dir = tmpDir();
  crashedJournal(dir, 'run-a', [entry('Radaris', 'error')]);

  const log = loadLastLog(dir);
  assert.equal(log.source, 'journal');
  assert.equal(log.crashed, true);
  assert.equal(log.partial, true);
});

test('with no journal and no summary there is still no log (the watcher then runs everything)', () => {
  assert.equal(loadLastLog(tmpDir()), null);
});

test('end to end: results logged through the logger, process "dies", retry set is rebuilt', () => {
  const dir = tmpDir();
  const origLog = console.log;
  console.log = () => {};
  try {
    logger.resetResults();
    logger.setJournal(openJournal(path.join(dir, 'run-2026-10-29T09-00-00.jsonl'), { mode: 'run' }));
    logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
    logger.logResult('Spokeo', 'success', 'ok');
    logger.logResult('Radaris', 'error', 'boom');
    logger.logResult('Whitepages', 'unverified', 'result page unreadable');
    // No summary JSON is ever written and the journal is never closed.
  } finally {
    logger.setJournal(null);
    logger.setCurrentPerson(null);
    logger.resetResults();
    console.log = origLog;
  }

  assert.deepEqual([...extractFailedBrokers(loadLastLog(dir))].sort(), ['Radaris', 'Whitepages']);
});
