/**
 * test/setup-schedule-result.test.js
 *
 * CLI2-4, the setup wizard's half: after "Schedule to run automatically?" it
 * printed a green "[crontab] crontab error: ..." line and went on to "Setup
 * complete!". A failed install has to be said plainly and has to fail setup.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { describeScheduleResult } = require('../setup');

test('an installed schedule is reported as installed and does not fail setup', () => {
  const shown = describeScheduleResult({ ok: true, method: 'crontab', detail: 'Crontab entry added.' });
  assert.equal(shown.failed, false);
  assert.match(shown.text, /^✅ \[crontab\] Crontab entry added\./);
});

test('a schedule the OS refused is NOT installed, says why, and fails setup', () => {
  const shown = describeScheduleResult({ ok: false, method: 'crontab', detail: 'crontab error: permission denied\n   Manually add: 0 9 1 * * x' });
  assert.equal(shown.failed, true);
  assert.match(shown.text, /NOT installed/);
  assert.match(shown.text, /permission denied/);
  assert.doesNotMatch(shown.text, /^✅/);
});

test('a result with no verdict at all is not trusted as installed', () => {
  assert.equal(describeScheduleResult({ method: 'launchd', detail: 'launchctl error: x' }).failed, true);
  assert.equal(describeScheduleResult(undefined).failed, true);
});

test("the wizard's schedule step, against an installer that refuses, ends NOT installed and failed", () => {
  // The step is driven on its own (the rest of the wizard writes PII), in a child
  // process whose installer is replaced before setup.js loads; HOME and every
  // AIDR_* path are in a temp dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-schedule-'));
  try {
    const preload = path.join(dir, 'refuse-scheduler.js');
    fs.writeFileSync(preload, `
      const scheduler = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'scheduler'))});
      scheduler.installSchedule = () => ({ ok: false, method: 'crontab', detail: 'crontab error: refused by the test' });
    `);
    const driver = path.join(dir, 'drive.js');
    fs.writeFileSync(driver, `
      require(${JSON.stringify(preload)});
      const setup = require(${JSON.stringify(path.join(__dirname, '..', 'setup.js'))});
      setup.runScheduleStep({ confirm: async () => true, close() {} }).then((r) => {
        process.stdout.write(JSON.stringify(r));
      });
    `);
    const r = spawnSync(process.execPath, [driver], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, AIDR_HOME: dir, AIDR_STATE_PATH: path.join(dir, 'state.json'), AIDR_CONFIG_PATH: path.join(dir, 'config.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.split('\n').pop()), { asked: true, failed: true });
    assert.match(r.stdout, /NOT installed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
