'use strict';
/**
 * test/heartbeat-partial-run.test.js
 *
 * CLI2-10: a filtered run (--only, --skip, --retry-failed, --captchas) overwrote
 * last-run.json with its own "ok", so one `aidr run --only Spokeo` after a monthly
 * run that failed (or was killed) made `aidr schedule status` and `aidr doctor`
 * report a healthy job. The heartbeat now says whether the run was partial, a
 * partial run carries the last FULL run's record forward, and the status reports
 * the last full run.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startHeartbeat, readHeartbeat } = require('../lib/heartbeat');
const { getScheduleStatus, formatScheduleStatus } = require('../lib/scheduler');

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-heartbeat-partial-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const at = (iso) => () => Date.parse(iso);
const stored = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('a partial run', () => {
  it('is recorded as partial, and a full run is not', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'ok' });
    assert.equal('partial' in stored(file), false, 'a full run carries no partial marker');
    assert.equal(readHeartbeat(file).partial, undefined);

    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    assert.equal(stored(file).partial, true);
    assert.equal(readHeartbeat(file).partial, true);
  });

  it('carries the last full run forward, whatever it ended as', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    const clock = (...t) => { const q = t.map(Date.parse); return () => (q.length > 1 ? q.shift() : q[0]); };
    startHeartbeat(file, { now: clock('2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z') })
      .finish({ outcome: 'failed', counts: { errors: 40 } });

    const partial = startHeartbeat(file, { partial: true, now: at('2026-10-05T09:00:00.000Z') });
    let read = readHeartbeat(file, { now: Date.parse('2026-10-05T09:01:00.000Z') });
    assert.equal(read.outcome, 'running', 'the partial run is in progress');
    assert.equal(read.partial, true);
    assert.equal(read.lastFull.outcome, 'failed', 'the failed full run is still there while it runs');
    assert.deepEqual(read.lastFull.counts, { errors: 40 });

    partial.finish({ outcome: 'ok', counts: { succeeded: 1 } });
    read = readHeartbeat(file);
    assert.equal(read.outcome, 'ok');
    assert.equal(read.lastFull.outcome, 'failed', 'and after it ends: a partial ok does not launder a failed monthly run');
    assert.equal(read.lastFull.startedAt, '2026-10-01T09:00:00.000Z');
  });

  it('a full run that never finished stays visible, as crashed once it is old enough', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }); // killed: no end record
    startHeartbeat(file, { partial: true, now: at('2026-10-09T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const read = readHeartbeat(file, { now: Date.parse('2026-10-09T10:00:00.000Z') });
    assert.equal(read.lastFull.outcome, 'crashed');
    assert.equal(read.lastFull.finishedAt, null);
  });

  it('a second partial run keeps the same last full run', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'partial', counts: { errors: 3 } });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    startHeartbeat(file, { partial: true, now: at('2026-10-03T09:00:00.000Z') }).finish({ outcome: 'failed' });
    const read = readHeartbeat(file);
    assert.equal(read.outcome, 'failed');
    assert.equal(read.lastFull.outcome, 'partial');
    assert.equal(read.lastFull.startedAt, '2026-10-01T09:00:00.000Z');
  });

  it('with no full run before it, has no lastFull', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    assert.equal(readHeartbeat(file).lastFull, null);
  });

  it('a full run after it replaces the whole record: the new full run is the last full run', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed' });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    startHeartbeat(file, { now: at('2026-11-01T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const read = readHeartbeat(file);
    assert.equal(read.partial, undefined);
    assert.equal(read.lastFull, undefined);
    assert.equal(read.outcome, 'ok');
  });

  it('survives a damaged previous file: nothing to carry, no throw', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    fs.writeFileSync(file, '{not json');
    assert.doesNotThrow(() => startHeartbeat(file, { partial: true }).finish({ outcome: 'ok' }));
    assert.equal(readHeartbeat(file).lastFull, null);
  });

  it('a carried record that is not well formed is dropped, not written', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    fs.writeFileSync(file, JSON.stringify({ startedAt: '2026-10-01T09:00:00.000Z', finishedAt: '2026-10-01T10:00:00.000Z', outcome: 'ok', counts: {}, partial: true, lastFull: { startedAt: 'yesterday', outcome: 'fine' } }));
    startHeartbeat(file, { partial: true }).finish({ outcome: 'ok' });
    assert.equal('lastFull' in stored(file), false);
  });

  it('holds numbers only, as before: no name or broker can ride along in lastFull', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'ok', counts: { succeeded: 2, 'Jane Doe': 1 } });
    startHeartbeat(file, { partial: true }).finish({ outcome: 'ok' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('Jane'));
  });
});

describe('schedule status reports the last FULL run', () => {
  const heartbeatPath = () => path.join(tmpDir(), 'last-run.json');
  const status = (file, extra = {}) => getScheduleStatus({
    platform: 'linux', homeDir: tmpDir(), scriptPath: '/x/run.sh', heartbeatPath: file,
    runner: () => ({ status: 127, stdout: '', stderr: '' }), ...extra,
  });

  it('a partial ok after a failed full run still reads as failed', () => {
    const file = heartbeatPath();
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed', counts: { errors: 9 } });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok', counts: { succeeded: 1 } });

    const s = status(file);
    assert.equal(s.lastRun.outcome, 'failed', 'the last full run, not the last run');
    assert.equal(s.lastRun.startedAt, '2026-10-01T09:00:00.000Z');
    assert.equal(s.lastPartialRun.outcome, 'ok');
    assert.equal(s.lastPartialRun.startedAt, '2026-10-02T09:00:00.000Z');
  });

  it('with no partial run, lastRun is the record and lastPartialRun is null', () => {
    const file = heartbeatPath();
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const s = status(file);
    assert.equal(s.lastRun.outcome, 'ok');
    assert.equal(s.lastPartialRun, null);
  });

  it('with only a partial run so far, there is no last full run to report', () => {
    const file = heartbeatPath();
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const s = status(file);
    assert.equal(s.lastRun, null);
    assert.equal(s.lastPartialRun.outcome, 'ok');
  });

  it('the text names the last full run and mentions the newer partial one', () => {
    const file = heartbeatPath();
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed' });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const text = formatScheduleStatus(status(file), { now: Date.parse('2026-10-03T09:00:00.000Z') });
    assert.match(text, /Last run: .* - failed/);
    assert.match(text, /Partial:\s+.*ok/);
    assert.match(text, /does not count/);
  });

  it('the text says there is no full run when only a partial one exists', () => {
    const file = heartbeatPath();
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    const text = formatScheduleStatus(status(file), { now: Date.parse('2026-10-03T09:00:00.000Z') });
    assert.match(text, /Last run: no full run recorded yet/);
    assert.match(text, /Partial:/);
  });
});
