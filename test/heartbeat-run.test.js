'use strict';
/**
 * test/heartbeat-run.test.js
 *
 * R4: the run-level helpers the watcher uses. startHeartbeat writes the start
 * record, finish() writes the end once (the shutdown handler and the normal end
 * of the run can both call it), and a heartbeat that cannot be written must
 * never fail a run. outcomeFromResults turns the run's results into the outcome
 * and the numbers-only counts.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startHeartbeat, readHeartbeat, outcomeFromResults } = require('../lib/heartbeat');

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-heartbeat-run-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function clock(...isoTimes) {
  const queue = isoTimes.map(t => Date.parse(t));
  return () => queue.length > 1 ? queue.shift() : queue[0];
}

describe('startHeartbeat', () => {
  it('writes the start record straight away: started, not finished', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    const hb = startHeartbeat(file, { now: clock('2026-10-01T09:00:00.000Z') });
    assert.equal(hb.startedAt, '2026-10-01T09:00:00.000Z');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.startedAt, '2026-10-01T09:00:00.000Z');
    assert.equal(stored.finishedAt, null);
    assert.equal(readHeartbeat(file, { now: Date.parse('2026-10-01T09:30:00.000Z') }).outcome, 'running');
  });

  it('finish() writes the end with the same start time, the outcome and the counts', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    const hb = startHeartbeat(file, { now: clock('2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z') });
    assert.equal(hb.finish({ outcome: 'partial', counts: { succeeded: 7, errors: 2 } }), true);
    const read = readHeartbeat(file);
    assert.equal(read.startedAt, '2026-10-01T09:00:00.000Z');
    assert.equal(read.finishedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(read.outcome, 'partial');
    assert.deepEqual(read.counts, { succeeded: 7, errors: 2 });
  });

  it('finish() only writes once: a later signal cannot overwrite the real end of the run', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    const hb = startHeartbeat(file);
    hb.finish({ outcome: 'ok', counts: { succeeded: 1 } });
    assert.equal(hb.finish({ outcome: 'failed' }), false);
    assert.equal(readHeartbeat(file).outcome, 'ok');
  });

  it('a heartbeat that cannot be written never fails the run; it is reported once per failure', () => {
    const dir = tmpDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory is needed');
    const errors = [];
    const hb = startHeartbeat(path.join(blocker, 'last-run.json'), { onError: err => errors.push(err) });
    assert.equal(errors.length, 1, 'the start write failure is reported');
    assert.doesNotThrow(() => hb.finish({ outcome: 'ok' }));
    assert.equal(errors.length, 2, 'and so is the end write failure');
  });

  it('finish() with a bad outcome is reported, not thrown', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    const errors = [];
    const hb = startHeartbeat(file, { onError: err => errors.push(err) });
    assert.doesNotThrow(() => hb.finish({ outcome: 'fine' }));
    assert.equal(errors.length, 1);
    assert.equal(readHeartbeat(file).outcome, 'running', 'the start record stays');
  });
});

describe('outcomeFromResults', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ broker: `B${i}` }));

  it('counts every result bucket by length and the generic pass by its stats', () => {
    const { counts } = outcomeFromResults({
      succeeded: rows(3), pendingConfirm: rows(2), unverified: rows(1), skipped: rows(4),
      notFound: rows(5), captchaFailed: rows(1), manual: rows(2), errors: rows(1), dead: rows(6),
      genericStats: { attempted: 90, submitted: 40, no_form_found: 30, error: 10, unverified: 2 },
    });
    assert.deepEqual(counts, {
      succeeded: 3, pendingConfirm: 2, unverified: 1, skipped: 4, notFound: 5,
      captchaFailed: 1, manual: 2, errors: 1, dead: 6,
      genericAttempted: 90, genericSubmitted: 40, genericNoForm: 30, genericErrors: 10, genericUnverified: 2,
    });
  });

  it('is ok when nothing errored, even if sites need a human (that is a to-do, not a broken job)', () => {
    assert.equal(outcomeFromResults({ succeeded: rows(10), manual: rows(5), captchaFailed: rows(3), errors: [] }).outcome, 'ok');
  });

  it('is ok for a run that found everything still fresh', () => {
    assert.equal(outcomeFromResults({ skipped: rows(50), errors: [] }).outcome, 'ok');
  });

  it('is partial when it finished with some errors', () => {
    assert.equal(outcomeFromResults({ succeeded: rows(10), errors: rows(2) }).outcome, 'partial');
    assert.equal(
      outcomeFromResults({ succeeded: rows(10), errors: [], genericStats: { attempted: 10, submitted: 5, error: 1 } }).outcome,
      'partial'
    );
  });

  it('is failed when there were errors and nothing else happened (no network, bad browser)', () => {
    assert.equal(outcomeFromResults({ errors: rows(50), succeeded: [], skipped: [] }).outcome, 'failed');
  });

  it('copes with results that are missing buckets or empty', () => {
    assert.deepEqual(outcomeFromResults({}), { outcome: 'ok', counts: {} });
    assert.deepEqual(outcomeFromResults(null), { outcome: 'ok', counts: {} });
  });
});
