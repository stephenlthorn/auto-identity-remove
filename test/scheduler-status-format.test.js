'use strict';
/**
 * test/scheduler-status-format.test.js
 *
 * R4: what `aidr schedule status` prints. The point of the command is to make a
 * broken job visible, so the broken states (installed but not loaded, a run that
 * crashed, a passphrase in the job file) must be said in words, not left to be
 * inferred from a missing line.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { formatScheduleStatus } = require('../lib/scheduler');

const NOW = Date.parse('2026-10-29T12:00:00.000Z');

const INSTALLED = {
  installed: true, kind: 'launchd', kinds: ['launchd'], schedule: 'monthly, day 1 at 09:00',
  target: '/opt/aidr/run.sh', active: true, env: {}, envVisible: true, plaintextPassphrase: false,
  location: '/Users/u/Library/LaunchAgents/com.auto-identity-remove.plist', lastRun: null,
};
const NOT_INSTALLED = {
  installed: false, kind: null, kinds: [], schedule: null, target: null, active: null,
  env: {}, plaintextPassphrase: false, location: null, lastRun: null,
};
const FINISHED = {
  startedAt: '2026-10-01T09:00:02.000Z', finishedAt: '2026-10-01T10:00:00.000Z', outcome: 'ok',
  counts: { succeeded: 40, errors: 0, skipped: 12 },
};

function format(status) {
  return formatScheduleStatus(status, { now: NOW });
}

describe('formatScheduleStatus', () => {
  it('says plainly when there is no schedule and how to add one', () => {
    const text = format(NOT_INSTALLED);
    assert.match(text, /Schedule: not installed/);
    assert.match(text, /aidr schedule install/);
  });

  it('describes an installed job: kind, when, what it runs, where it lives, that it is active', () => {
    const text = format(INSTALLED);
    assert.match(text, /Schedule: installed \(launchd\)/);
    assert.match(text, /When:\s+monthly, day 1 at 09:00/);
    assert.match(text, /Runs:\s+\/opt\/aidr\/run\.sh/);
    assert.match(text, /Where:\s+\/Users\/u\/Library\/LaunchAgents\/com\.auto-identity-remove\.plist/);
    assert.match(text, /Active:\s+yes/);
  });

  it('says a job that will not fire in capitals, with the fix', () => {
    const text = format({ ...INSTALLED, active: false });
    assert.match(text, /Active:\s+NO/);
    assert.match(text, /aidr schedule install/);
  });

  it('says unknown, not no, when the system could not be asked', () => {
    assert.match(format({ ...INSTALLED, active: null }), /Active:\s+unknown/);
  });

  it('warns about a passphrase in the job file without printing one', () => {
    const text = format({ ...INSTALLED, plaintextPassphrase: true });
    assert.match(text, /WARNING/);
    assert.match(text, /AIDR_PASSPHRASE_FILE/);
  });

  it('mentions a second job so uninstall is not a surprise', () => {
    assert.match(format({ ...INSTALLED, kind: 'systemd', kinds: ['systemd', 'cron'] }), /Also found: cron/);
  });

  it('says no run is recorded when there is no heartbeat', () => {
    assert.match(format(INSTALLED), /Last run: no run recorded yet/);
  });

  it('shows how the last run ended, how long ago, and the non-zero counts', () => {
    const text = format({ ...INSTALLED, lastRun: FINISHED });
    assert.match(text, /Last run: 2026-10-01T10:00:00\.000Z - ok \(28 days ago\)/);
    assert.match(text, /40 succeeded, 12 skipped/);
    assert.ok(!/0 errors/.test(text), 'zero counts are noise');
  });

  it('says a run that never finished crashed', () => {
    const text = format({ ...INSTALLED, lastRun: { startedAt: '2026-10-01T09:00:02.000Z', finishedAt: null, outcome: 'crashed', counts: {} } });
    assert.match(text, /never finished \(crashed\)/);
  });

  it('says a run in progress is still running', () => {
    const text = format({ ...INSTALLED, lastRun: { startedAt: '2026-10-29T11:00:00.000Z', finishedAt: null, outcome: 'running', counts: {} } });
    assert.match(text, /still running/);
    assert.match(text, /today/);
  });

  it('says an unreadable heartbeat is unreadable, not that nothing ran', () => {
    const text = format({ ...INSTALLED, lastRun: { startedAt: null, finishedAt: null, outcome: 'unknown', counts: {}, unreadable: true } });
    assert.match(text, /unreadable/);
    assert.ok(!/no run recorded/.test(text));
  });

  it('still shows the last run when no schedule is installed (a manual run counts)', () => {
    assert.match(format({ ...NOT_INSTALLED, lastRun: FINISHED }), /Last run: 2026-10-01T10:00:00\.000Z - ok/);
  });
});
