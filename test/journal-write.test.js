/**
 * test/journal-write.test.js
 *
 * R3: the run log used to be written once, at the very end. A crash, an OOM
 * kill or `docker stop` left nothing behind, so `--retry-failed` had no log to
 * read and the audit trail had a hole. openJournal() appends every result to
 * logs/run-<ts>.jsonl as it happens: one JSON line per write, owner-only, with
 * nothing buffered in the process (a kill -9 must lose no completed line).
 */

'use strict';

const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openJournal } = require('../lib/journal');

const SKIP_ON_WINDOWS = process.platform === 'win32';

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-journal-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  mock.restoreAll();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const modeOf = p => fs.statSync(p).mode & 0o777;

test('the first line is a run header carrying startedAt, mode, partial and filter', () => {
  const file = path.join(tmpDir(), 'run-2026-10-29T09-00-00.jsonl');
  const journal = openJournal(file, {
    startedAt: '2026-10-29T09:00:00.000Z',
    mode: 'run',
    partial: true,
    filter: { only: 'Spokeo', skip: null, retryFailed: false, resume: false },
  });
  journal.close();

  const [header] = lines(file);
  assert.deepEqual(header, {
    type: 'run',
    startedAt: '2026-10-29T09:00:00.000Z',
    mode: 'run',
    partial: true,
    filter: { only: 'Spokeo', skip: null, retryFailed: false, resume: false },
  });
});

test('the header has sane defaults when the watcher passes nothing', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  openJournal(file).close();

  const [header] = lines(file);
  assert.equal(header.type, 'run');
  assert.ok(!Number.isNaN(Date.parse(header.startedAt)), 'startedAt defaults to now');
  assert.equal(header.partial, false);
  assert.equal(header.mode, null);
  assert.equal(header.filter, null);
});

test('append writes one JSON line per entry, keeping person, host and any extra field', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append({ broker: 'Spokeo', status: 'success', detail: 'ok', time: '9:00:01 AM', person: 'Jane Doe' });
  journal.append({ broker: 'Acme Data', status: 'error', detail: 'boom', time: '9:00:02 AM', host: 'acme.example' });
  journal.append({ broker: 'Odd', status: 'manual', detail: '', time: '9:00:03 AM', note: 'extra field survives' });

  const [, one, two, three] = lines(file);
  assert.deepEqual(one, { broker: 'Spokeo', status: 'success', detail: 'ok', time: '9:00:01 AM', person: 'Jane Doe' });
  assert.equal(two.host, 'acme.example');
  assert.equal(three.note, 'extra field survives');
});

test('an append is readable by another process immediately, with no close (nothing is buffered)', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append({ broker: 'Spokeo', status: 'error', detail: 'boom', time: 't' });

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(onDisk.endsWith('\n'), 'every line is newline-terminated as written');
  assert.equal(onDisk.split('\n').filter(Boolean).length, 2, 'header + the entry');
});

test('each append is exactly one fs.writeSync of exactly one line', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const spy = mock.method(fs, 'writeSync');
  const journal = openJournal(file);
  journal.append({ broker: 'A', status: 'success', detail: '', time: 't' });
  journal.append({ broker: 'B', status: 'error', detail: 'x', time: 't' });
  journal.append({ broker: 'C', status: 'skipped', detail: '', time: 't' });

  assert.equal(spy.mock.callCount(), 4, 'one write for the header and one per entry');
  for (const call of spy.mock.calls) {
    const text = Buffer.isBuffer(call.arguments[1]) ? call.arguments[1].toString('utf8') : String(call.arguments[1]);
    assert.equal(text.split('\n').length, 2, 'a single trailing newline, nothing else');
    assert.ok(text.endsWith('\n'));
  }
});

test('the file is created 0600 and a missing parent directory 0700', { skip: SKIP_ON_WINDOWS }, () => {
  const parent = path.join(tmpDir(), 'logs');
  const file = path.join(parent, 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append({ broker: 'A', status: 'success', detail: '', time: 't' });
  journal.close();

  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(parent), 0o700);
});

test('an existing parent directory is left exactly as it was', { skip: SKIP_ON_WINDOWS }, () => {
  const parent = tmpDir();
  fs.chmodSync(parent, 0o755);

  openJournal(path.join(parent, 'run-a.jsonl')).close();
  assert.equal(modeOf(parent), 0o755, 'the journal only creates a missing directory, it does not chmod one it did not make');
});

test('a journal that already exists with a loose mode is tightened to 0600', { skip: SKIP_ON_WINDOWS }, () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  fs.writeFileSync(file, '', { mode: 0o644 });
  fs.chmodSync(file, 0o644);

  openJournal(file).close();
  assert.equal(modeOf(file), 0o600);
});

test('close writes an end line with finishedAt and counts, and ends the file', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append({ broker: 'A', status: 'success', detail: '', time: 't' });
  journal.close({ finishedAt: '2026-10-29T09:30:00.000Z', counts: { succeeded: 1, errors: 0 } });

  const all = lines(file);
  assert.deepEqual(all[all.length - 1], { type: 'end', finishedAt: '2026-10-29T09:30:00.000Z', counts: { succeeded: 1, errors: 0 } });
});

test('close with no arguments tallies the counts from what was appended, by results bucket', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append({ broker: 'A', status: 'success', detail: '', time: 't' });
  journal.append({ broker: 'B', status: 'success', detail: '', time: 't' });
  journal.append({ broker: 'C', status: 'captcha_failed', detail: 'url', time: 't' });
  journal.append({ broker: 'D', status: 'unverified', detail: '', time: 't' });
  journal.append({ broker: 'E', status: 'no-such-status', detail: '', time: 't' });
  journal.close();

  const end = lines(file).pop();
  assert.equal(end.type, 'end');
  assert.ok(!Number.isNaN(Date.parse(end.finishedAt)));
  assert.equal(end.counts.succeeded, 2);
  assert.equal(end.counts.captchaFailed, 1);
  assert.equal(end.counts.unverified, 1);
  assert.equal(end.counts.errors, 1, 'an unknown status lands in errors, exactly as logResult buckets it');
  assert.equal(end.counts.dead, 0);
});

test('an interrupted close is recorded as such', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.close({ interrupted: true });
  assert.equal(lines(file).pop().interrupted, true);
});

test('close is idempotent and appends after close are ignored, never thrown', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.close();
  journal.close();

  assert.doesNotThrow(() => journal.append({ broker: 'Late', status: 'error', detail: 'after close', time: 't' }));
  const all = lines(file);
  assert.equal(all.filter(l => l.type === 'end').length, 1, 'one end line, however often close runs');
  assert.ok(!all.some(l => l.broker === 'Late'));
});

test('a write failure never throws into the run: it warns once and stops journaling', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const warnings = [];
  let first = true;
  const failingFs = {
    ...fs,
    writeSync: (...args) => {
      // Let the header through, fail every entry after it.
      if (first) { first = false; return fs.writeSync(...args); }
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
  };
  const journal = openJournal(file, {}, { fs: failingFs, warn: message => warnings.push(message) });

  assert.doesNotThrow(() => journal.append({ broker: 'A', status: 'success', detail: '', time: 't' }));
  assert.doesNotThrow(() => journal.append({ broker: 'B', status: 'success', detail: '', time: 't' }));
  assert.doesNotThrow(() => journal.close());
  assert.equal(warnings.length, 1, 'one warning, not one per entry');
  assert.match(warnings[0], /ENOSPC/);
});

test('an unopenable journal path degrades to a no-op journal instead of aborting the run', () => {
  const blocker = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(blocker, 'x');
  const warnings = [];
  // The "directory" is a regular file, so neither mkdir nor open can succeed.
  const journal = openJournal(path.join(blocker, 'run-a.jsonl'), {}, { warn: m => warnings.push(m) });

  assert.doesNotThrow(() => journal.append({ broker: 'A', status: 'success', detail: '', time: 't' }));
  assert.doesNotThrow(() => journal.close());
  assert.equal(warnings.length, 1);
});

test('non-object appends are ignored', () => {
  const file = path.join(tmpDir(), 'run-a.jsonl');
  const journal = openJournal(file);
  journal.append(null);
  journal.append('a string');
  journal.close();
  assert.equal(lines(file).length, 2, 'header and end only');
});
