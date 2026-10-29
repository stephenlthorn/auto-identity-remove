/**
 * test/journal-read.test.js
 *
 * R3: readJournal() is what `--retry-failed` and the diff fall back on after a
 * crash, so it must survive exactly the damage a crash does: a missing end
 * line, a half-written last line, an empty file.
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openJournal, readJournal, resultsFromJournal } = require('../lib/journal');
const { STATUS_BUCKET } = require('../lib/logger');

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-journal-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: '9:00:00 AM', ...extra });

test('a cleanly closed journal reads back with its header, entries in order, and ended: true', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file, { startedAt: '2026-10-29T09:00:00.000Z', mode: 'run' });
  journal.append(entry('A', 'success', { person: 'Jane Doe' }));
  journal.append(entry('B', 'error'));
  journal.close({ counts: { succeeded: 1, errors: 1 } });

  const read = readJournal(file);
  assert.equal(read.header.type, 'run');
  assert.equal(read.header.startedAt, '2026-10-29T09:00:00.000Z');
  assert.deepEqual(read.entries.map(e => e.broker), ['A', 'B']);
  assert.equal(read.entries[0].person, 'Jane Doe');
  assert.equal(read.ended, true);
  assert.deepEqual(read.end.counts, { succeeded: 1, errors: 1 });
});

test('a crashed run (no close) reads back every completed entry with ended: false', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file, { startedAt: '2026-10-29T09:00:00.000Z' });
  journal.append(entry('A', 'success'));
  journal.append(entry('B', 'captcha_failed', { detail: 'https://b.example/optout' }));
  // The process dies here: no close(), no end line.

  const read = readJournal(file);
  assert.equal(read.ended, false);
  assert.equal(read.end, null);
  assert.deepEqual(read.entries.map(e => e.broker), ['A', 'B']);
  assert.equal(read.entries[1].detail, 'https://b.example/optout');
});

test('a torn final line (killed mid-write) is skipped and every earlier line survives', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append(entry('A', 'success'));
  journal.append(entry('B', 'error', { detail: 'boom' }));
  fs.appendFileSync(file, '{"broker":"C","status":"succ');

  const read = readJournal(file);
  assert.deepEqual(read.entries.map(e => e.broker), ['A', 'B']);
  assert.equal(read.ended, false);
  assert.equal(read.corruptLines, 0, 'a torn tail is the expected crash shape, not corruption');
});

test('a complete last line that merely lacks its newline is kept', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append(entry('A', 'success'));
  fs.appendFileSync(file, JSON.stringify(entry('B', 'error')));

  assert.deepEqual(readJournal(file).entries.map(e => e.broker), ['A', 'B']);
});

test('a torn end line does not make the run look ended', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append(entry('A', 'success'));
  fs.appendFileSync(file, '{"type":"end","finishedAt":"2026-10-29T09:');

  const read = readJournal(file);
  assert.equal(read.ended, false);
  assert.equal(read.entries.length, 1);
});

test('a corrupt line in the middle is skipped and counted, the rest still reads', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append(entry('A', 'success'));
  fs.appendFileSync(file, 'this is not json\n');
  journal.append(entry('C', 'error'));

  const read = readJournal(file);
  assert.deepEqual(read.entries.map(e => e.broker), ['A', 'C']);
  assert.equal(read.corruptLines, 1);
});

test('blank lines and non-object JSON lines are ignored', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  fs.writeFileSync(file, `\n${JSON.stringify(entry('A', 'success'))}\n\n42\n"text"\nnull\n${JSON.stringify(entry('B', 'error'))}\n`);

  assert.deepEqual(readJournal(file).entries.map(e => e.broker), ['A', 'B']);
});

test('an empty journal (killed between open and the header) reads as no header, no entries', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  fs.writeFileSync(file, '');

  assert.deepEqual(readJournal(file), { header: null, entries: [], ended: false, end: null, corruptLines: 0 });
});

test('a missing or unreadable journal reads as null, never throws', () => {
  const dir = tmpDir();
  assert.equal(readJournal(path.join(dir, 'does-not-exist.jsonl')), null);
  assert.equal(readJournal(dir), null, 'a directory is not a journal');
});

test('only the first run header counts; a header appended later is not an entry', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  openJournal(file, { startedAt: '2026-10-29T09:00:00.000Z' }).append(entry('A', 'success'));
  openJournal(file, { startedAt: '2026-10-29T09:00:00.000Z' }).append(entry('B', 'error'));

  const read = readJournal(file);
  assert.equal(read.header.startedAt, '2026-10-29T09:00:00.000Z');
  assert.deepEqual(read.entries.map(e => e.broker), ['A', 'B']);
});

// ── resultsFromJournal ───────────────────────────────────────────────────────

test('resultsFromJournal buckets every status exactly where logResult would', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  for (const status of Object.keys(STATUS_BUCKET)) journal.append(entry(`b-${status}`, status));
  journal.append(entry('b-unknown', 'something-new'));

  const results = resultsFromJournal(readJournal(file));
  for (const [status, bucket] of Object.entries(STATUS_BUCKET)) {
    assert.ok(results[bucket].some(e => e.broker === `b-${status}`), `${status} belongs in ${bucket}`);
  }
  assert.ok(results.errors.some(e => e.broker === 'b-unknown'), 'an unknown status is an error, as in logResult');
});

test('resultsFromJournal returns the full results shape with every bucket present', () => {
  const results = resultsFromJournal({ header: null, entries: [], ended: false });
  for (const bucket of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors', 'dead', 'pendingConfirm', 'unverified']) {
    assert.deepEqual(results[bucket], [], `${bucket} is an empty array, not undefined`);
  }
});

test('resultsFromJournal keeps person and host on the rebuilt entries', () => {
  const results = resultsFromJournal({
    header: { type: 'run', startedAt: '2026-10-29T09:00:00.000Z', partial: false, filter: null },
    entries: [entry('Acme Data', 'dead', { person: 'Jane Doe', host: 'acme.example' })],
    ended: false,
  });
  assert.equal(results.dead[0].person, 'Jane Doe');
  assert.equal(results.dead[0].host, 'acme.example');
  assert.equal(results.runAt, '2026-10-29T09:00:00.000Z');
});

test('a run rebuilt from a journal is always partial: it has no summary to prove it finished', () => {
  const crashed = resultsFromJournal({ header: { type: 'run', partial: false, filter: null }, entries: [], ended: false });
  assert.equal(crashed.partial, true);
  assert.equal(crashed.crashed, true);

  const endedButUnsummarised = resultsFromJournal({ header: { type: 'run', partial: false, filter: null }, entries: [], ended: true, end: { type: 'end' } });
  assert.equal(endedButUnsummarised.partial, true, 'no summary JSON means nothing vouches for a full run');
  assert.equal(endedButUnsummarised.crashed, false);
});

test('a header filter is carried onto the rebuilt run', () => {
  const filter = { only: 'Spokeo', skip: null, retryFailed: false, resume: false };
  const results = resultsFromJournal({ header: { type: 'run', partial: true, filter }, entries: [], ended: false });
  assert.deepEqual(results.filter, filter);
});

test('an interrupted end line still counts as crashed work', () => {
  const results = resultsFromJournal({ header: null, entries: [], ended: true, end: { type: 'end', interrupted: true } });
  assert.equal(results.crashed, true);
});
