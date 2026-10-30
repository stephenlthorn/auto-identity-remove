'use strict';
/**
 * test/heartbeat-offline-flag.test.js
 *
 * A run that could not reach most sites (lib/outage.js) says so in its heartbeat,
 * last-run.json, so `aidr schedule status` can tell the user why the last run
 * failed: the network or DNS, not the brokers. The file still holds numbers and
 * flags only, never a host name.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeHeartbeat, readHeartbeat, startHeartbeat } = require('../lib/heartbeat');
const { getScheduleStatus, formatScheduleStatus } = require('../lib/scheduler');

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-heartbeat-offline-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const at = (iso) => () => Date.parse(iso);
const stored = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const FINISHED = {
  startedAt: '2026-10-01T09:00:01.000Z',
  finishedAt: '2026-10-01T10:12:30.000Z',
  outcome: 'failed',
  counts: { dead: 900, skipped: 100 },
};
const noScheduler = () => ({ status: 127, stdout: '', stderr: 'not installed' });

describe('the heartbeat file', () => {
  it('stores offline: true for a run that ended offline, and reads it back', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed', counts: { dead: 900 }, offline: true });
    assert.equal(stored(file).offline, true);
    assert.equal(readHeartbeat(file).offline, true);
    assert.deepEqual(stored(file).counts, { dead: 900 }, 'counts stay numbers only');
  });

  it('carries no offline key on a normal run, so existing records read as before', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'ok', counts: { succeeded: 4 } });
    assert.equal('offline' in stored(file), false);
    assert.equal('offline' in readHeartbeat(file), false);
    startHeartbeat(file, { now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok', offline: false });
    assert.equal('offline' in stored(file), false, 'only true is a flag');
  });

  it('writeHeartbeat ignores an offline that is not exactly true, and a start record never has one', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { ...FINISHED, offline: 'yes' });
    assert.equal('offline' in stored(file), false);
    writeHeartbeat(file, { startedAt: FINISHED.startedAt, offline: true });
    assert.equal('offline' in stored(file), false);
  });

  it('keeps the flag on the full run a later partial run carries forward', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed', counts: { dead: 900 }, offline: true });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'ok' });
    assert.equal(readHeartbeat(file).lastFull.offline, true);
    assert.equal('offline' in readHeartbeat(file), false, 'the partial run itself was fine');
  });
});

describe('aidr schedule status', () => {
  const statusFor = (file) => getScheduleStatus({
    platform: 'linux', runner: noScheduler, homeDir: path.dirname(file), scriptPath: '/nowhere/run.sh',
    heartbeatPath: file, now: NOW,
  });

  it('says in one short line that the last run could not reach most sites', () => {
    const text = formatScheduleStatus({ installed: false, lastRun: { ...FINISHED, offline: true } }, { now: NOW });
    const line = text.split('\n').filter(l => /could not reach most sites/i.test(l));
    assert.equal(line.length, 1);
    assert.match(line[0], /network or DNS/i);
    assert.ok(line[0].trim().length < 90, `short: ${line[0]}`);
  });

  it('says nothing about it for a failed run that was not offline', () => {
    const text = formatScheduleStatus({ installed: false, lastRun: FINISHED }, { now: NOW });
    assert.doesNotMatch(text, /could not reach/i);
  });

  it('carries the flag into the --json status for the last full run', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'failed', counts: { dead: 900 }, offline: true });
    const status = statusFor(file);
    assert.equal(status.lastRun.offline, true);
    assert.equal(JSON.parse(JSON.stringify(status)).lastRun.offline, true);
    assert.match(formatScheduleStatus(status, { now: NOW }), /could not reach most sites/i);
  });

  it('carries the flag for a newer partial run too, without hiding the full one', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    startHeartbeat(file, { now: at('2026-10-01T09:00:00.000Z') }).finish({ outcome: 'ok', counts: { succeeded: 4 } });
    startHeartbeat(file, { partial: true, now: at('2026-10-02T09:00:00.000Z') }).finish({ outcome: 'failed', counts: { dead: 12 }, offline: true });
    const status = statusFor(file);
    assert.equal('offline' in status.lastRun, false);
    assert.equal(status.lastPartialRun.offline, true);
    assert.match(formatScheduleStatus(status, { now: NOW }), /could not reach most sites/i);
  });
});
