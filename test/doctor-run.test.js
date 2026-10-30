'use strict';
/**
 * test/doctor-run.test.js
 *
 * R4: runDoctor now also checks the schedule, the run lock and the unattended
 * passphrase, and prints where every runtime path resolves when lib/paths.js
 * exists. The lock and heartbeat are looked for beside the state file, the same
 * place the watcher puts them, so an explicit rootDir (or AIDR_STATE_PATH) moves
 * them together.
 *
 * No real system is read: schedule state comes from an injected status or a fake
 * runner, and the module-level runner throws if anything reaches the real one.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scheduler = require('../lib/scheduler');
const secrets = require('../lib/secrets');
const { writeHeartbeat } = require('../lib/heartbeat');
const { runDoctor } = require('../lib/doctor');

const PERSON = { firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy-nets.org', zip: '22202' };
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const HOUR = 3600000;
const DAY = 24 * HOUR;
const PASS = 'doctor-run-passphrase';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-run-'));
  scheduler._setRunner(() => { throw new Error('the real runner was reached'); });
});
afterEach(() => {
  scheduler._setRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const NO_SCHEDULE = { installed: false, kind: null, kinds: [], schedule: null, target: null, active: null, env: {}, plaintextPassphrase: false, lastRun: null };
const INSTALLED = {
  installed: true, kind: 'cron', kinds: ['cron'], schedule: 'monthly, day 1 at 09:00', target: '/opt/aidr/run.sh',
  active: true, env: {}, envVisible: true, plaintextPassphrase: false, lastRun: null,
};

function writePlainConfig() {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ person: PERSON }));
}
function writeEncryptedConfig() {
  fs.writeFileSync(path.join(root, 'config.json.enc'), JSON.stringify(secrets.encryptConfig({ person: PERSON }, PASS)));
}

function doctor(opts = {}) {
  return runDoctor({
    rootDir: root,
    now: NOW,
    requirePlaywright: () => ({ chromium: { executablePath: () => path.join(root, 'chrome') } }),
    fsExists: () => true,
    tcpProbe: () => Promise.resolve(true),
    headRequest: () => Promise.resolve(200),
    printOutput: false,
    scheduleStatus: NO_SCHEDULE,
    ...opts,
  });
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .then(result => ({ result, lines }), error => { throw error; })
    .finally(() => { console.log = original; });
}

describe('runDoctor: the R4 checks', () => {
  it('adds schedule, lock and unattended-passphrase checks after the existing six, behind the home check (R0)', async () => {
    writePlainConfig();
    const results = await doctor();
    assert.deepEqual(results.map(r => r.name), ['home', 'config', 'playwright', 'smtp', 'capsolver', 'state', 'webhook', 'schedule', 'lock', 'unattended']);
  });

  it('counts the checks it runs in its header', async () => {
    writePlainConfig();
    const { lines } = await captureLog(() => doctor({ printOutput: true }));
    assert.ok(lines.some(line => /running 10 checks/.test(line)), lines.join('\n'));
  });

  it('prints nothing when printOutput is false', async () => {
    writePlainConfig();
    const { lines } = await captureLog(() => doctor());
    assert.deepEqual(lines, []);
  });

  it('finds the lock beside state.json and reports a stale one as a warning that does not fail the run', async () => {
    writePlainConfig();
    fs.writeFileSync(path.join(root, 'state.json.lock'), JSON.stringify({
      pid: 999999, host: os.hostname(), startedAt: new Date(NOW - 9 * HOUR).toISOString(), ts: new Date(NOW - 8 * HOUR).toISOString(),
    }));
    const results = await doctor();
    const lockResult = results.find(r => r.name === 'lock');
    assert.equal(lockResult.ok, true);
    assert.equal(lockResult.warn, true);
    assert.match(lockResult.hint, /stale/);
    assert.equal(results.exitCode, 0);
    assert.equal(results.summary.warnings, 1);
  });

  it('reads the heartbeat beside state.json and reports the last run for an installed job', async () => {
    writePlainConfig();
    writeHeartbeat(path.join(root, 'last-run.json'), {
      startedAt: new Date(NOW - 3 * DAY - HOUR).toISOString(), finishedAt: new Date(NOW - 3 * DAY).toISOString(), outcome: 'ok', counts: { succeeded: 3 },
    });
    const results = await doctor({ scheduleStatus: undefined, scheduleOptions: { platform: 'windows', runner: fakeSchtasks() } });
    const schedule = results.find(r => r.name === 'schedule');
    assert.equal(schedule.ok, true, schedule.hint);
    assert.ok(!schedule.warn);
    assert.match(schedule.hint, /last ran 3 days ago/);
  });

  it('warns about a monthly job that has not run in over 35 days', async () => {
    writePlainConfig();
    writeHeartbeat(path.join(root, 'last-run.json'), {
      startedAt: new Date(NOW - 50 * DAY - HOUR).toISOString(), finishedAt: new Date(NOW - 50 * DAY).toISOString(), outcome: 'ok',
    });
    const results = await doctor({ scheduleStatus: undefined, scheduleOptions: { platform: 'windows', runner: fakeSchtasks() } });
    assert.equal(results.find(r => r.name === 'schedule').warn, true);
    assert.equal(results.exitCode, 0);
  });

  it('accepts a status as a function', async () => {
    writePlainConfig();
    const results = await doctor({ scheduleStatus: () => INSTALLED });
    assert.match(results.find(r => r.name === 'schedule').hint, /cron job installed/);
  });

  it('reports a schedule it could not read as a failed check instead of crashing', async () => {
    writePlainConfig();
    const results = await doctor({ scheduleStatus: () => { throw new Error('crontab exploded'); } });
    const schedule = results.find(r => r.name === 'schedule');
    assert.equal(schedule.ok, false);
    assert.match(schedule.hint, /crontab exploded/);
  });

  it('fails the run when the config is encrypted and the installed job has no passphrase source', async () => {
    writeEncryptedConfig();
    const results = await doctor({ passphrase: PASS, scheduleStatus: INSTALLED });
    const unattended = results.find(r => r.name === 'unattended');
    assert.equal(unattended.ok, false);
    assert.equal(results.exitCode, 1);
  });

  it('skips the unattended check for a plaintext config', async () => {
    writePlainConfig();
    const results = await doctor({ scheduleStatus: INSTALLED });
    assert.match(results.find(r => r.name === 'unattended').hint, /skipped/);
  });

  it('keeps warnings out of the ok count and out of the exit code', async () => {
    writePlainConfig();
    fs.writeFileSync(path.join(root, 'state.json.lock'), 'not json');
    const old = new Date(NOW - 5 * HOUR);
    fs.utimesSync(path.join(root, 'state.json.lock'), old, old);
    const results = await doctor();
    assert.equal(results.summary.warnings, 1);
    assert.equal(results.summary.failed, 0);
    assert.equal(results.exitCode, 0);
  });

  /** Task Scheduler answering "there is a monthly task". */
  function fakeSchtasks() {
    const xml = '<Task><Triggers><CalendarTrigger><StartBoundary>2026-10-01T09:00:00</StartBoundary><ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth></ScheduleByMonth></CalendarTrigger></Triggers>' +
      '<Actions><Exec><Command>node.exe</Command><Arguments>watcher.js</Arguments></Exec></Actions></Task>';
    return (cmd, args) => {
      if (cmd === 'schtasks' && args[0] === '/Query') return { status: 0, stdout: xml, stderr: '' };
      throw new Error(`unscripted command: ${cmd} ${args.join(' ')}`);
    };
  }
});

describe('runDoctor: where the paths resolve', () => {
  it('prints describePaths() when it is available, whatever shape it returns', async () => {
    writePlainConfig();
    const shapes = {
      string: () => 'config   /data/config.json\nstate    /data/state.json',
      array: () => ['config   /data/config.json', 'state    /data/state.json'],
      object: () => ({ config: '/data/config.json', state: '/data/state.json' }),
    };
    for (const [shape, describePaths] of Object.entries(shapes)) {
      const { result, lines } = await captureLog(() => doctor({ printOutput: true, describePaths }));
      const text = lines.join('\n');
      assert.match(text, /config\s+\/data\/config\.json/, shape);
      assert.match(text, /state\s+\/data\/state\.json/, shape);
      assert.match(result.paths, /\/data\/state\.json/, shape);
    }
  });

  it('prints nothing about paths when none are described', async () => {
    writePlainConfig();
    const { result, lines } = await captureLog(() => doctor({ printOutput: true, describePaths: null }));
    assert.equal(result.paths, undefined);
    assert.ok(!lines.some(line => /Paths/.test(line)));
  });

  it('survives a describePaths that throws', async () => {
    writePlainConfig();
    const results = await doctor({ describePaths: () => { throw new Error('boom'); } });
    assert.equal(results.paths, undefined);
    assert.equal(results.exitCode, 0);
  });

  it('keeps the paths out of the check list', async () => {
    writePlainConfig();
    const results = await doctor({ describePaths: () => 'config /x' });
    assert.ok(!results.some(r => r.name === 'paths'));
    assert.equal(results.paths, 'config /x');
  });
});
