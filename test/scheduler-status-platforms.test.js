'use strict';
/**
 * test/scheduler-status-platforms.test.js
 *
 * R4: `aidr schedule status` has to say whether the job this tool installed is
 * there, when it fires, what it runs and which AIDR_* variables it carries (a
 * scheduled run of an encrypted config needs AIDR_PASSPHRASE_FILE in the job).
 * One reader per platform, each looking only for OUR job: the launchd label, the
 * systemd user timer, our marker-tagged (or legacy) cron line, the schtasks task.
 *
 * Nothing here touches the real system: every command goes through a fake
 * runner that throws on any command the test did not script, and every file is
 * read from a temp home.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scheduler = require('../lib/scheduler');
const { writeHeartbeat } = require('../lib/heartbeat');
const { getScheduleStatus, buildPlist, buildSystemdUnits, buildCronLine } = scheduler;

const LABEL = 'com.auto-identity-remove';
const TIMER = 'auto-identity-remove.timer';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

let home;
let heartbeatPath;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-sched-status-'));
  heartbeatPath = path.join(home, 'last-run.json');
  // A missed injection must fail loudly, never reach launchctl, systemctl or crontab.
  scheduler._setRunner(() => { throw new Error('the real runner was reached'); });
});
afterEach(() => {
  scheduler._setRunner(null);
  fs.rmSync(home, { recursive: true, force: true });
});

/** A runner that answers only the commands in `script`; anything else throws. */
function fakeRunner(script) {
  const calls = [];
  const runner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const key = [cmd, ...(args || [])].join(' ');
    if (!(key in script)) throw new Error(`unscripted command: ${key}`);
    const answer = script[key];
    return typeof answer === 'function' ? answer(input) : answer;
  };
  runner.calls = calls;
  return runner;
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (status, stderr = '') => ({ status, stdout: '', stderr });

function status(opts) {
  return getScheduleStatus({ homeDir: home, heartbeatPath, now: NOW, ...opts });
}

function installPlist(opts = {}) {
  const file = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildPlist(opts.scriptPath || '/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: opts.env || {} }));
  return file;
}

function installUnits(opts = {}) {
  const dir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const { service, timer } = buildSystemdUnits(opts.scriptPath || '/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: opts.env || {} });
  fs.writeFileSync(path.join(dir, 'auto-identity-remove.service'), service);
  fs.writeFileSync(path.join(dir, 'auto-identity-remove.timer'), timer);
  return dir;
}

const NOT_INSTALLED = {
  installed: false, kind: null, kinds: [], schedule: null, target: null, active: null,
  env: {}, plaintextPassphrase: false,
};

describe('getScheduleStatus on macOS (launchd)', () => {
  it('reports no job when there is no plist, without asking launchctl anything', () => {
    const runner = fakeRunner({});
    const result = status({ platform: 'macos', runner });
    assert.deepEqual({ ...result, lastRun: undefined, location: undefined }, { ...NOT_INSTALLED, lastRun: undefined, location: undefined });
    assert.equal(runner.calls.length, 0);
  });

  it('reads what our plist says: when it fires, what it runs, the AIDR_* paths it carries', () => {
    installPlist({ env: { AIDR_PASSPHRASE_FILE: '/home/u/.aidr-pass', AIDR_STATE_PATH: '/data/state.json', AIDR_PASSPHRASE: 'must-not-be-carried' } });
    const runner = fakeRunner({ [`launchctl list ${LABEL}`]: ok('{ "Label" = "com.auto-identity-remove"; };') });
    const result = status({ platform: 'macos', runner });
    assert.equal(result.installed, true);
    assert.equal(result.kind, 'launchd');
    assert.deepEqual(result.kinds, ['launchd']);
    assert.equal(result.schedule, 'monthly, day 1 at 09:00');
    assert.equal(result.target, '/opt/aidr/run.sh');
    assert.equal(result.active, true);
    assert.deepEqual(result.env, { AIDR_PASSPHRASE_FILE: '/home/u/.aidr-pass', AIDR_STATE_PATH: '/data/state.json' });
    assert.equal(result.location, path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`));
  });

  it('reads a script path that needed XML escaping', () => {
    installPlist({ scriptPath: '/Users/a&b/<aidr>/run.sh' });
    const result = status({ platform: 'macos', runner: fakeRunner({ [`launchctl list ${LABEL}`]: ok() }) });
    assert.equal(result.target, '/Users/a&b/<aidr>/run.sh');
  });

  it('says installed-but-not-loaded: a plist that launchd does not know never fires', () => {
    installPlist();
    const result = status({ platform: 'macos', runner: fakeRunner({ [`launchctl list ${LABEL}`]: fail(113, 'Could not find service') }) });
    assert.equal(result.installed, true);
    assert.equal(result.active, false);
  });

  it('says unknown, not "not loaded", when launchctl itself cannot run', () => {
    installPlist();
    const result = status({ platform: 'macos', runner: fakeRunner({ [`launchctl list ${LABEL}`]: fail(127, 'spawn launchctl ENOENT') }) });
    assert.equal(result.installed, true);
    assert.equal(result.active, null);
  });

  it('flags a passphrase written into the plist and never echoes its value', () => {
    const file = installPlist();
    const secret = 'correct-horse-battery-staple';
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      '</dict>\n    <key>RunAtLoad',
      `    <key>AIDR_PASSPHRASE</key>\n        <string>${secret}</string>\n    </dict>\n    <key>RunAtLoad`
    ));
    const result = status({ platform: 'macos', runner: fakeRunner({ [`launchctl list ${LABEL}`]: ok() }) });
    assert.equal(result.plaintextPassphrase, true);
    assert.ok(!JSON.stringify(result).includes(secret), 'the passphrase must not appear anywhere in the status');
  });

  it('never looks at crontab on macOS', () => {
    const runner = fakeRunner({});
    status({ platform: 'macos', runner });
    assert.ok(runner.calls.every(call => call.cmd !== 'crontab'));
  });
});

describe('getScheduleStatus on Linux (systemd user timer, then cron)', () => {
  const NO_CRONTAB = { 'crontab -l': fail(1, 'no crontab for user') };

  it('reports no job when there are no unit files and no cron line', () => {
    const runner = fakeRunner(NO_CRONTAB);
    const result = status({ platform: 'linux', runner });
    assert.equal(result.installed, false);
    assert.equal(result.kind, null);
    assert.deepEqual(runner.calls.map(c => c.cmd), ['crontab'], 'systemctl is only asked when a unit exists');
  });

  it('reads our unit files and asks systemd whether the timer is enabled', () => {
    const dir = installUnits({ scriptPath: '/home/u/My Files/100%/run.sh', env: { AIDR_PASSPHRASE_FILE: '/home/u/pass', AIDR_CONFIG_PATH: '/etc/aidr/config.json' } });
    const runner = fakeRunner({ ...NO_CRONTAB, [`systemctl --user is-enabled ${TIMER}`]: ok('enabled\n') });
    const result = status({ platform: 'linux', runner });
    assert.equal(result.installed, true);
    assert.equal(result.kind, 'systemd');
    assert.deepEqual(result.kinds, ['systemd']);
    assert.equal(result.schedule, 'monthly, day 1 at 09:00');
    assert.equal(result.target, '/home/u/My Files/100%/run.sh');
    assert.equal(result.active, true);
    assert.deepEqual(result.env, { AIDR_PASSPHRASE_FILE: '/home/u/pass', AIDR_CONFIG_PATH: '/etc/aidr/config.json' });
    assert.equal(result.location, dir);
  });

  it('says installed-but-disabled when the timer is not enabled', () => {
    installUnits();
    const runner = fakeRunner({ ...NO_CRONTAB, [`systemctl --user is-enabled ${TIMER}`]: { status: 1, stdout: 'disabled\n', stderr: '' } });
    const result = status({ platform: 'linux', runner });
    assert.equal(result.installed, true);
    assert.equal(result.active, false);
  });

  it('says unknown when there is no user session bus to ask (ssh, containers)', () => {
    installUnits();
    const runner = fakeRunner({ ...NO_CRONTAB, [`systemctl --user is-enabled ${TIMER}`]: fail(1, 'Failed to connect to bus: No medium found') });
    assert.equal(status({ platform: 'linux', runner }).active, null);
  });

  it('finds our marker-tagged cron line among the user\'s own, with the AIDR_* it carries', () => {
    const line = buildCronLine('/home/u/aidr/run.sh', '/home/u/aidr/logs', { nodeBinDir: '/opt/node/bin', env: { AIDR_PASSPHRASE_FILE: '/home/u/pass' } });
    const crontab = ['MAILTO=""', '0 3 * * * /usr/bin/backup --tag=$(date +\\%F)', line, ''].join('\n');
    const result = status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': ok(crontab) }), scriptPath: '/home/u/aidr/run.sh' });
    assert.equal(result.installed, true);
    assert.equal(result.kind, 'cron');
    assert.deepEqual(result.kinds, ['cron']);
    assert.equal(result.schedule, 'monthly, day 1 at 09:00');
    assert.equal(result.target, '/home/u/aidr/run.sh');
    assert.equal(result.active, true);
    assert.deepEqual(result.env, { AIDR_PASSPHRASE_FILE: '/home/u/pass' });
  });

  it('reads a cron script path that needed shell quoting and % escaping', () => {
    const line = buildCronLine("/home/u/it's 100%/run.sh", '/home/u/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    const result = status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': ok(line + '\n') }) });
    assert.equal(result.target, "/home/u/it's 100%/run.sh");
  });

  it('finds the legacy line, but only for this install\'s script', () => {
    const crontab = '0 9 1 * * /bin/bash /home/u/aidr/run.sh\n';
    const mine = status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': ok(crontab) }), scriptPath: '/home/u/aidr/run.sh' });
    assert.equal(mine.installed, true);
    assert.equal(mine.target, '/home/u/aidr/run.sh');
    const other = status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': ok(crontab) }), scriptPath: '/somewhere/else/run.sh' });
    assert.equal(other.installed, false, 'a line for a different run.sh is some other project\'s job');
  });

  it('ignores a hand-written line that merely mentions the script, and a comment holding only the marker', () => {
    const crontab = [
      '0 6 * * 1 /bin/bash /home/u/aidr/run.sh --dry-run',
      '# auto-identity-remove',
      '',
    ].join('\n');
    const result = status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': ok(crontab) }), scriptPath: '/home/u/aidr/run.sh' });
    assert.equal(result.installed, false);
  });

  it('treats "no crontab" and a missing crontab command alike: no cron job', () => {
    assert.equal(status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': fail(1, 'no crontab for u') }) }).installed, false);
    assert.equal(status({ platform: 'linux', runner: fakeRunner({ 'crontab -l': fail(127, 'ENOENT') }) }).installed, false);
  });

  it('lists every kind it finds and reports the first (a cron line left behind by an older install)', () => {
    installUnits();
    const line = buildCronLine('/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    const runner = fakeRunner({ 'crontab -l': ok(line + '\n'), [`systemctl --user is-enabled ${TIMER}`]: ok('enabled\n') });
    const result = status({ platform: 'linux', runner });
    assert.equal(result.kind, 'systemd');
    assert.deepEqual(result.kinds, ['systemd', 'cron']);
  });

  it('treats an unknown platform like Linux, the way the installer does', () => {
    const runner = fakeRunner(NO_CRONTAB);
    assert.equal(status({ platform: 'freebsd', runner }).installed, false);
    assert.equal(runner.calls[0].cmd, 'crontab');
  });
});

describe('getScheduleStatus on Windows (Task Scheduler)', () => {
  const QUERY = 'schtasks /Query /TN auto-identity-remove /XML';
  const TASK_XML = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-10-29T09:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth>
          <Day>1</Day>
        </DaysOfMonth>
      </ScheduleByMonth>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"C:\\Program Files\\nodejs\\node.exe"</Command>
      <Arguments>"C:\\aidr &amp; co\\watcher.js"</Arguments>
    </Exec>
  </Actions>
</Task>`;

  it('reports no job when the task does not exist', () => {
    const result = status({ platform: 'windows', runner: fakeRunner({ [QUERY]: fail(1, 'ERROR: The system cannot find the file specified.') }) });
    assert.equal(result.installed, false);
    assert.equal(result.kind, null);
  });

  it('reads the task XML (locale independent): trigger, command line, enabled', () => {
    const result = status({ platform: 'windows', runner: fakeRunner({ [QUERY]: ok(TASK_XML) }) });
    assert.equal(result.installed, true);
    assert.equal(result.kind, 'schtasks');
    assert.equal(result.schedule, 'monthly, day 1 at 09:00');
    assert.equal(result.target, '"C:\\Program Files\\nodejs\\node.exe" "C:\\aidr & co\\watcher.js"');
    assert.equal(result.active, true);
  });

  it('cannot see the job environment (a task does not carry one) and says so with an empty env', () => {
    const result = status({ platform: 'windows', runner: fakeRunner({ [QUERY]: ok(TASK_XML) }) });
    assert.deepEqual(result.env, {});
    assert.equal(result.envVisible, false);
  });

  it('says installed-but-disabled for a disabled task', () => {
    const disabled = TASK_XML.replace('<Settings>\n    <Enabled>true</Enabled>', '<Settings>\n    <Enabled>false</Enabled>');
    assert.equal(status({ platform: 'windows', runner: fakeRunner({ [QUERY]: ok(disabled) }) }).active, false);
  });

  it('still reports the job when the XML is not in a shape it knows', () => {
    const result = status({ platform: 'windows', runner: fakeRunner({ [QUERY]: ok('<Task/>') }) });
    assert.equal(result.installed, true);
    assert.equal(result.schedule, null);
    assert.equal(result.target, null);
  });
});

describe('getScheduleStatus: the last run', () => {
  it('comes from the heartbeat: when it started, how it ended, the counts', () => {
    writeHeartbeat(heartbeatPath, {
      startedAt: '2026-10-01T09:00:02.000Z', finishedAt: '2026-10-01T10:00:00.000Z', outcome: 'partial', counts: { errors: 2 },
    });
    const result = status({ platform: 'windows', runner: fakeRunner({ 'schtasks /Query /TN auto-identity-remove /XML': fail(1) }) });
    assert.deepEqual(result.lastRun, {
      startedAt: '2026-10-01T09:00:02.000Z', finishedAt: '2026-10-01T10:00:00.000Z', outcome: 'partial', counts: { errors: 2 },
    });
  });

  it('is null when nothing has run', () => {
    const result = status({ platform: 'windows', runner: fakeRunner({ 'schtasks /Query /TN auto-identity-remove /XML': fail(1) }) });
    assert.equal(result.lastRun, null);
  });

  it('reads a run that never finished as crashed', () => {
    writeHeartbeat(heartbeatPath, { startedAt: '2026-10-01T09:00:00.000Z' });
    const result = status({ platform: 'windows', runner: fakeRunner({ 'schtasks /Query /TN auto-identity-remove /XML': fail(1) }) });
    assert.equal(result.lastRun.outcome, 'crashed');
  });
});

describe('the runner seam', () => {
  it('uses the module runner when none is passed, so one stub covers a whole test file', () => {
    installPlist();
    const runner = fakeRunner({ [`launchctl list ${LABEL}`]: ok() });
    scheduler._setRunner(runner);
    assert.equal(status({ platform: 'macos' }).active, true);
    assert.equal(runner.calls.length, 1);
  });
});
