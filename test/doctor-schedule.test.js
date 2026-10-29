'use strict';
/**
 * test/doctor-schedule.test.js
 *
 * R4: `aidr doctor` has to say whether the monthly job exists, is loaded, and has
 * actually run lately. A job that was installed and quietly stopped firing is
 * the failure this exists to catch, so a last run older than 35 days (one month
 * plus slack) is a warning, as is a last run that failed or crashed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkSchedule } = require('../lib/doctor');

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

const NOT_INSTALLED = { installed: false, kind: null, kinds: [], schedule: null, target: null, active: null, env: {}, lastRun: null };
const INSTALLED = {
  installed: true, kind: 'cron', kinds: ['cron'], schedule: 'monthly, day 1 at 09:00', target: '/opt/aidr/run.sh',
  active: true, env: {}, plaintextPassphrase: false, lastRun: null,
};
const ranDaysAgo = (days, outcome = 'ok') => ({
  startedAt: iso(NOW - days * DAY - 3600000), finishedAt: iso(NOW - days * DAY), outcome, counts: {},
});

function check(status, opts) {
  return checkSchedule(status, { now: NOW, ...opts });
}

describe('checkSchedule', () => {
  it('is a skip, not a failure, when no schedule is installed, and says how to add one', () => {
    const r = check(NOT_INSTALLED);
    assert.equal(r.ok, true);
    assert.match(r.hint, /skipped/);
    assert.match(r.hint, /aidr schedule install/);
  });

  it('is fine when the job is loaded and ran recently: kind, when it fires, when it last ran', () => {
    const r = check({ ...INSTALLED, lastRun: ranDaysAgo(3) });
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
    assert.match(r.hint, /cron job installed/);
    assert.match(r.hint, /monthly, day 1 at 09:00/);
    assert.match(r.hint, /last ran 3 days ago/);
    assert.match(r.hint, /ok/);
  });

  it('fails when the job is installed but not loaded: it will never fire', () => {
    const r = check({ ...INSTALLED, kind: 'launchd', active: false, lastRun: ranDaysAgo(3) });
    assert.equal(r.ok, false);
    assert.match(r.hint, /not loaded|not enabled/);
    assert.match(r.hint, /aidr schedule install/);
  });

  it('says so, without failing, when it could not tell whether the job is loaded', () => {
    const r = check({ ...INSTALLED, active: null, lastRun: ranDaysAgo(3) });
    assert.equal(r.ok, true);
    assert.match(r.hint, /could not (check|tell)/);
  });

  it('is fine for a new install with no run recorded yet', () => {
    const r = check(INSTALLED);
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
    assert.match(r.hint, /no run recorded yet/);
  });

  it('warns when the last run is more than 35 days old: the monthly job is not firing', () => {
    const r = check({ ...INSTALLED, lastRun: ranDaysAgo(36) });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.hint, /36 days ago/);
    assert.match(r.hint, /35/);
  });

  it('does not warn at exactly 35 days (a month plus slack)', () => {
    const r = check({ ...INSTALLED, lastRun: ranDaysAgo(35) });
    assert.ok(!r.warn);
  });

  it('counts the age from when the run finished, or started when it never finished', () => {
    const finished = { startedAt: iso(NOW - 40 * DAY), finishedAt: iso(NOW - 2 * DAY), outcome: 'ok', counts: {} };
    assert.ok(!check({ ...INSTALLED, lastRun: finished }).warn);
    const neverFinished = { startedAt: iso(NOW - 40 * DAY), finishedAt: null, outcome: 'crashed', counts: {} };
    assert.match(check({ ...INSTALLED, lastRun: neverFinished }).hint, /40 days ago/);
  });

  it('takes the stale limit from staleDays', () => {
    assert.equal(check({ ...INSTALLED, lastRun: ranDaysAgo(10) }, { staleDays: 7 }).warn, true);
    assert.ok(!check({ ...INSTALLED, lastRun: ranDaysAgo(10) }, { staleDays: 14 }).warn);
  });

  it('warns when the last run failed or crashed, even if recent', () => {
    for (const outcome of ['failed', 'crashed']) {
      const r = check({ ...INSTALLED, lastRun: ranDaysAgo(2, outcome) });
      assert.equal(r.warn, true, outcome);
      assert.match(r.hint, new RegExp(outcome));
    }
  });

  it('does not warn about a partial run (some brokers errored; the job itself worked)', () => {
    const r = check({ ...INSTALLED, lastRun: ranDaysAgo(2, 'partial') });
    assert.ok(!r.warn);
    assert.match(r.hint, /partial/);
  });

  it('does not warn about a run that is in progress', () => {
    const running = { startedAt: iso(NOW - 3600000), finishedAt: null, outcome: 'running', counts: {} };
    const r = check({ ...INSTALLED, lastRun: running });
    assert.ok(!r.warn);
    assert.match(r.hint, /running/);
  });

  it('warns about a heartbeat file it cannot read', () => {
    const unreadable = { startedAt: null, finishedAt: null, outcome: 'unknown', counts: {}, unreadable: true };
    const r = check({ ...INSTALLED, lastRun: unreadable });
    assert.equal(r.warn, true);
    assert.match(r.hint, /last-run\.json/);
  });

  it('mentions a manual run when nothing is scheduled but a heartbeat exists', () => {
    const r = check({ ...NOT_INSTALLED, lastRun: ranDaysAgo(3) });
    assert.equal(r.ok, true);
    assert.match(r.hint, /skipped/);
  });
});
