/**
 * test/journal-diff.test.js
 *
 * R3: a crashed run has a journal but no summary. As a diff baseline it is
 * worse than useless: diffing a full run against the few brokers a crashed run
 * got through reports hundreds of "newly removed" and hides real regressions
 * (the same trap CFG-15c closed for --only runs). A crashed run is treated as
 * partial, so the baseline skips it and uses the last run that finished.
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPreviousLog, isPartialLog, diffResults } = require('../lib/diff');
const { openJournal, resultsFromJournal, readJournal } = require('../lib/journal');

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-diff-journal-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: 't', ...extra });
const full = marker => ({ marker, runAt: marker, succeeded: [{ broker: 'Spokeo' }] });

function writeSummary(dir, stem, body) {
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(body));
}
function crashedJournal(dir, stem, entries, header = {}) {
  const journal = openJournal(path.join(dir, `${stem}.jsonl`), { startedAt: '2026-10-29T09:00:00.000Z', ...header });
  for (const e of entries) journal.append(e);
}

test('a crashed run is not the diff baseline: the last finished run is', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-27T09-00-00', full('last-finished'));
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('Spokeo', 'success')]);
  writeSummary(dir, 'run-2026-10-29T09-00-00', full('current'));

  const prev = loadPreviousLog(dir, 'run-2026-10-29T09-00-00.json');
  assert.equal(prev.marker, 'last-finished');
});

test('a crashed run is skipped even when it is the only earlier run', () => {
  const dir = tmpDir();
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('Spokeo', 'success')]);
  writeSummary(dir, 'run-2026-10-29T09-00-00', full('current'));

  assert.equal(loadPreviousLog(dir, 'run-2026-10-29T09-00-00.json'), null);
});

test('a journal rebuilt from a crash is a partial log by the diff\'s own test', () => {
  const dir = tmpDir();
  crashedJournal(dir, 'run-a', [entry('Spokeo', 'success')]);
  assert.equal(isPartialLog(resultsFromJournal(readJournal(path.join(dir, 'run-a.jsonl')))), true);
});

test('the current run\'s own journal is never its baseline, even once its summary exists', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', full('previous'));
  // The watcher has written this run's summary AND its journal exists next to it.
  writeSummary(dir, 'run-2026-10-29T09-00-00', full('current'));
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('Spokeo', 'success')]);

  assert.equal(loadPreviousLog(dir, path.join(dir, 'run-2026-10-29T09-00-00.json')).marker, 'previous');
});

test('a finished run keeps its summary as the baseline; its journal next to it changes nothing', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', full('finished'));
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('Other', 'error')]);
  writeSummary(dir, 'run-2026-10-29T09-00-00', full('current'));

  assert.equal(loadPreviousLog(dir, 'run-2026-10-29T09-00-00.json').marker, 'finished');
});

test('an unreadable summary whose journal survives still cannot become the baseline', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-27T09-00-00', full('older'));
  fs.writeFileSync(path.join(dir, 'run-2026-10-28T09-00-00.json'), '{"truncated": ');
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('Spokeo', 'success')]);
  writeSummary(dir, 'run-2026-10-29T09-00-00', full('current'));

  assert.equal(loadPreviousLog(dir, 'run-2026-10-29T09-00-00.json').marker, 'older');
});

test('skipping the crashed baseline keeps the diff honest: no flood of "newly removed"', () => {
  const dir = tmpDir();
  const lastFinished = { runAt: 'f', succeeded: [{ broker: 'A' }, { broker: 'B' }, { broker: 'C' }] };
  writeSummary(dir, 'run-2026-10-27T09-00-00', lastFinished);
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('A', 'success')]);

  const current = { succeeded: [{ broker: 'A' }, { broker: 'B' }, { broker: 'C' }], notFound: [], errors: [] };
  const prev = loadPreviousLog(dir, 'run-2026-10-29T09-00-00.json');
  assert.deepEqual(diffResults(prev, current).newlyRemoved, [], 'B and C were already succeeded in the finished run');
});

test('a run that finished with a summary but later runs crashed still diffs against the right one', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-26T09-00-00', full('oldest-finished'));
  writeSummary(dir, 'run-2026-10-27T09-00-00', full('newest-finished'));
  crashedJournal(dir, 'run-2026-10-28T09-00-00', [entry('Spokeo', 'success')]);
  crashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('Spokeo', 'error')]);
  writeSummary(dir, 'run-2026-10-30T09-00-00', full('current'));

  assert.equal(loadPreviousLog(dir, 'run-2026-10-30T09-00-00.json').marker, 'newest-finished');
});
