/**
 * test/journal-runs.test.js
 *
 * R3: logs/ holds run-<ts>.json (the summary, written at the end) and
 * run-<ts>.jsonl (the journal, written as it goes). findLatestRun() gives the
 * newest run as the summary when there is one and as the journal when the run
 * crashed before writing it; listRuns()/loadRun() are the same lookup for
 * callers that walk older runs too (the diff).
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openJournal, readJournal, listRuns, loadRun, findLatestRun, journalPathFor } = require('../lib/journal');

const SKIP_ON_WINDOWS = process.platform === 'win32';

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-runs-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: 't', ...extra });

function writeSummary(dir, stem, body) {
  fs.writeFileSync(path.join(dir, `${stem}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

// A journal that was never closed, i.e. the run died.
function writeCrashedJournal(dir, stem, entries, header = {}) {
  const journal = openJournal(path.join(dir, `${stem}.jsonl`), { startedAt: '2026-10-29T09:00:00.000Z', ...header });
  for (const e of entries) journal.append(e);
}

test('journalPathFor puts the journal next to the summary with the same timestamp', () => {
  assert.equal(journalPathFor('/x/logs/run-2026-10-29T09-00-00.json'), '/x/logs/run-2026-10-29T09-00-00.jsonl');
  assert.equal(journalPathFor('/x/logs/run-a'), '/x/logs/run-a.jsonl');
});

// ── listRuns ─────────────────────────────────────────────────────────────────

test('listRuns pairs a summary with its journal and orders newest first', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-27T09-00-00', {});
  writeSummary(dir, 'run-2026-10-28T09-00-00', {});
  fs.writeFileSync(path.join(dir, 'run-2026-10-28T09-00-00.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'run-2026-10-29T09-00-00.jsonl'), '');

  const runs = listRuns(dir);
  assert.deepEqual(runs.map(r => r.stem), ['run-2026-10-29T09-00-00', 'run-2026-10-28T09-00-00', 'run-2026-10-27T09-00-00']);
  assert.equal(runs[0].summaryPath, null, 'the newest run crashed: journal only');
  assert.ok(runs[0].journalPath.endsWith('run-2026-10-29T09-00-00.jsonl'));
  assert.ok(runs[1].summaryPath && runs[1].journalPath, 'a finished run has both');
  assert.equal(runs[2].journalPath, null, 'a run from before the journal existed has only a summary');
});

test('listRuns ignores everything that is not a run file', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-a', {});
  fs.writeFileSync(path.join(dir, 'audit-2026-10-29T09-00-00.md'), '');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
  fs.writeFileSync(path.join(dir, 'run-a.json.bak'), '{}');
  fs.mkdirSync(path.join(dir, 'complaints'));

  assert.deepEqual(listRuns(dir).map(r => r.stem), ['run-a']);
});

test('listRuns can leave out the current run by file name, absolute path, or either extension', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-a', {});
  writeSummary(dir, 'run-b', {});
  fs.writeFileSync(path.join(dir, 'run-b.jsonl'), '');

  assert.deepEqual(listRuns(dir, { exclude: 'run-b.json' }).map(r => r.stem), ['run-a']);
  assert.deepEqual(listRuns(dir, { exclude: path.join(dir, 'run-b.json') }).map(r => r.stem), ['run-a']);
  assert.deepEqual(listRuns(dir, { exclude: path.join(dir, 'run-b.jsonl') }).map(r => r.stem), ['run-a']);
});

test('listRuns on a missing directory is empty, not a throw', () => {
  assert.deepEqual(listRuns(path.join(tmpDir(), 'nope')), []);
});

// ── loadRun / findLatestRun ──────────────────────────────────────────────────

test('findLatestRun returns the summary JSON when the newest run has one', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-29T09-00-00', { runAt: 'summary', errors: [{ broker: 'Spokeo' }] });
  writeCrashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('Ignored', 'error')]);

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'summary');
  assert.equal(latest.log.runAt, 'summary');
  assert.ok(latest.path.endsWith('run-2026-10-29T09-00-00.json'));
});

test('findLatestRun returns the journal, rebuilt as results, when the newest run has no summary', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', { runAt: 'older summary' });
  writeCrashedJournal(dir, 'run-2026-10-29T09-00-00', [
    entry('Spokeo', 'error', { detail: 'boom', person: 'Jane Doe' }),
    entry('Radaris', 'success'),
  ]);

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'journal');
  assert.deepEqual(latest.log.errors.map(e => e.broker), ['Spokeo']);
  assert.equal(latest.log.errors[0].person, 'Jane Doe');
  assert.equal(latest.log.crashed, true);
  assert.equal(latest.log.partial, true);
  assert.equal(latest.journal.entries.length, 2);
});

test('a torn last line does not stop findLatestRun from using the rest of the journal', () => {
  const dir = tmpDir();
  writeCrashedJournal(dir, 'run-a', [entry('Spokeo', 'error')]);
  fs.appendFileSync(path.join(dir, 'run-a.jsonl'), '{"broker":"Half","status":"er');

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'journal');
  assert.deepEqual(latest.log.errors.map(e => e.broker), ['Spokeo']);
});

test('a journal-only run with no results (died at startup) does not shadow the last real run', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', { runAt: 'last good run' });
  writeCrashedJournal(dir, 'run-2026-10-29T09-00-00', []);

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'summary');
  assert.equal(latest.log.runAt, 'last good run');
});

test('an empty (zero-byte) journal is skipped the same way', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', { runAt: 'last good run' });
  fs.writeFileSync(path.join(dir, 'run-2026-10-29T09-00-00.jsonl'), '');

  assert.equal(findLatestRun(dir).log.runAt, 'last good run');
});

test('an unreadable newest summary falls back to its own journal', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-a', '{"truncated": ');
  writeCrashedJournal(dir, 'run-a', [entry('Spokeo', 'error')]);

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'journal');
  assert.deepEqual(latest.log.errors.map(e => e.broker), ['Spokeo']);
});

test('an unreadable newest summary with no journal is "no usable log", not a silent older run', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', { runAt: 'older' });
  writeSummary(dir, 'run-2026-10-29T09-00-00', 'not-valid-json{{{');

  assert.equal(findLatestRun(dir), null);
});

test('findLatestRun can leave out the run in progress', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-2026-10-28T09-00-00', { runAt: 'previous' });
  // The current run has already logged a failure to its own journal.
  writeCrashedJournal(dir, 'run-2026-10-29T09-00-00', [entry('Spokeo', 'error')]);

  assert.equal(findLatestRun(dir, { exclude: 'run-2026-10-29T09-00-00.json' }).log.runAt, 'previous');
});

test('findLatestRun on an empty or missing directory is null', () => {
  assert.equal(findLatestRun(tmpDir()), null);
  assert.equal(findLatestRun(path.join(tmpDir(), 'nope')), null);
});

test('loadRun reads one listed run on its own terms', () => {
  const dir = tmpDir();
  writeSummary(dir, 'run-a', { marker: 'a' });
  writeCrashedJournal(dir, 'run-b', [entry('Spokeo', 'error')]);
  const [newest, oldest] = listRuns(dir);

  assert.equal(loadRun(oldest).kind, 'summary');
  assert.equal(loadRun(oldest).log.marker, 'a');
  assert.equal(loadRun(newest).kind, 'journal');
});

// ── the real crash ───────────────────────────────────────────────────────────

test('a SIGKILLed run leaves every completed result on disk and findLatestRun reads them', { skip: SKIP_ON_WINDOWS }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run-2026-10-29T09-00-00.jsonl');
  const script = `
    const logger = require(${JSON.stringify(path.resolve(__dirname, '../lib/logger'))});
    const { openJournal } = require(${JSON.stringify(path.resolve(__dirname, '../lib/journal'))});
    logger.setJournal(openJournal(${JSON.stringify(file)}, { mode: 'run' }));
    logger.setCurrentPerson({ firstName: 'Jane', lastName: 'Doe' });
    logger.logResult('Spokeo', 'success', 'done');
    logger.logResult('Radaris', 'error', 'timeout');
    logger.logResult('Acme', 'captcha_failed', 'https://acme.example/optout');
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', 'the child really was killed, not exited');

  const read = readJournal(file);
  assert.equal(read.ended, false);
  assert.deepEqual(read.entries.map(e => e.broker), ['Spokeo', 'Radaris', 'Acme']);

  const latest = findLatestRun(dir);
  assert.equal(latest.kind, 'journal');
  assert.deepEqual(latest.log.errors.map(e => e.broker), ['Radaris']);
  assert.deepEqual(latest.log.captchaFailed.map(e => e.broker), ['Acme']);
  assert.equal(latest.log.errors[0].person, 'Jane Doe');
});
