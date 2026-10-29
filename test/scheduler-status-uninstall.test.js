'use strict';
/**
 * test/scheduler-status-uninstall.test.js
 *
 * R4: `aidr schedule uninstall` removes the job this tool installed and nothing
 * else. The cron case is the dangerous one - it rewrites the user's whole
 * crontab - so every line that is not ours must come back byte for byte, and a
 * hand-written line that merely mentions the script is never touched. Running it
 * twice is fine: the second run finds nothing and says so.
 *
 * Nothing here touches the real system: every command goes through a fake
 * runner that throws on any command the test did not script, and every file
 * lives in a temp home.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scheduler = require('../lib/scheduler');
const { uninstallSchedule, getScheduleStatus, buildPlist, buildSystemdUnits, buildCronLine } = scheduler;

const LABEL = 'com.auto-identity-remove';
const TIMER = 'auto-identity-remove.timer';
const SCRIPT = '/home/u/aidr/run.sh';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-sched-uninstall-'));
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
    calls.push({ cmd, args, input, key: [cmd, ...(args || [])].join(' ') });
    const key = [cmd, ...(args || [])].join(' ');
    if (!(key in script)) throw new Error(`unscripted command: ${key}`);
    const answer = script[key];
    return typeof answer === 'function' ? answer(input) : answer;
  };
  runner.calls = calls;
  runner.keys = () => calls.map(c => c.key);
  return runner;
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (status, stderr = '') => ({ status, stdout: '', stderr });

function uninstall(opts) {
  return uninstallSchedule({ homeDir: home, scriptPath: SCRIPT, uid: 501, ...opts });
}

describe('uninstallSchedule on macOS (launchd)', () => {
  const agents = () => path.join(home, 'Library', 'LaunchAgents');
  const plist = () => path.join(agents(), `${LABEL}.plist`);
  function installPlist() {
    fs.mkdirSync(agents(), { recursive: true });
    fs.writeFileSync(plist(), buildPlist('/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: {} }));
    fs.writeFileSync(path.join(agents(), 'com.someone.else.plist'), '<plist>not ours</plist>');
  }
  /** launchctl that remembers whether the job is loaded. */
  function launchctl({ bootout = 0, unload = 0 } = {}) {
    let loaded = true;
    return fakeRunner({
      [`launchctl list ${LABEL}`]: () => (loaded ? ok('{ };') : fail(113, 'Could not find service')),
      [`launchctl bootout gui/501/${LABEL}`]: () => { if (bootout === 0) loaded = false; return bootout === 0 ? ok() : fail(bootout, 'Boot-out failed'); },
      [`launchctl unload ${plist()}`]: () => { if (unload === 0) loaded = false; return unload === 0 ? ok() : fail(unload, 'unload failed'); },
    });
  }

  it('boots the job out of launchd, then deletes our plist and only our plist', () => {
    installPlist();
    const runner = launchctl();
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(result.kinds, ['launchd']);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(plist()), false);
    assert.equal(fs.readFileSync(path.join(agents(), 'com.someone.else.plist'), 'utf8'), '<plist>not ours</plist>');
    const keys = runner.keys();
    assert.ok(keys.indexOf(`launchctl bootout gui/501/${LABEL}`) !== -1, 'bootout was called');
    assert.ok(runner.calls.every(c => c.cmd === 'launchctl'), 'only launchctl');
  });

  it('falls back to launchctl unload when bootout is refused (older macOS)', () => {
    installPlist();
    const runner = launchctl({ bootout: 5 });
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, true);
    assert.ok(runner.keys().includes(`launchctl unload ${plist()}`));
    assert.equal(fs.existsSync(plist()), false);
  });

  it('keeps the plist and says so when the job cannot be unloaded: deleting it would leave a job nobody can find', () => {
    installPlist();
    const runner = launchctl({ bootout: 5, unload: 5 });
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /launchctl bootout gui\/501\/com\.auto-identity-remove/);
    assert.equal(fs.existsSync(plist()), true);
  });

  it('removes the plist even when launchctl cannot run at all', () => {
    installPlist();
    const runner = fakeRunner({
      [`launchctl list ${LABEL}`]: fail(127, 'ENOENT'),
      [`launchctl bootout gui/501/${LABEL}`]: fail(127, 'ENOENT'),
      [`launchctl unload ${plist()}`]: fail(127, 'ENOENT'),
    });
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(plist()), false);
  });

  it('boots out a job that is still loaded after its plist was deleted by hand', () => {
    fs.mkdirSync(agents(), { recursive: true });
    const runner = launchctl();
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, true);
    assert.ok(runner.keys().includes(`launchctl bootout gui/501/${LABEL}`));
  });

  it('is idempotent: with nothing installed it changes nothing and says so', () => {
    const runner = fakeRunner({ [`launchctl list ${LABEL}`]: fail(113, 'Could not find service') });
    const result = uninstall({ platform: 'macos', runner });
    assert.equal(result.removed, false);
    assert.deepEqual(result.kinds, []);
    assert.deepEqual(result.errors, []);
    assert.match(result.detail, /no schedule/i);
    assert.deepEqual(runner.keys(), [`launchctl list ${LABEL}`], 'nothing is booted out or deleted');
  });

  it('can be run twice in a row', () => {
    installPlist();
    const runner = launchctl();
    assert.equal(uninstall({ platform: 'macos', runner }).removed, true);
    assert.equal(uninstall({ platform: 'macos', runner }).removed, false);
  });

  it('never looks at crontab on macOS', () => {
    installPlist();
    const runner = launchctl();
    uninstall({ platform: 'macos', runner });
    assert.ok(runner.calls.every(c => c.cmd !== 'crontab'));
  });
});

describe('uninstallSchedule on Linux: systemd user timer', () => {
  const unitDir = () => path.join(home, '.config', 'systemd', 'user');
  function installUnits() {
    fs.mkdirSync(unitDir(), { recursive: true });
    const { service, timer } = buildSystemdUnits('/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    fs.writeFileSync(path.join(unitDir(), 'auto-identity-remove.service'), service);
    fs.writeFileSync(path.join(unitDir(), 'auto-identity-remove.timer'), timer);
    fs.writeFileSync(path.join(unitDir(), 'other.service'), '[Unit]\nDescription=not ours\n');
  }
  const NO_CRONTAB = { 'crontab -l': fail(1, 'no crontab for u') };

  it('disables the timer, deletes our two unit files only, then reloads systemd', () => {
    installUnits();
    const runner = fakeRunner({
      ...NO_CRONTAB,
      [`systemctl --user disable --now ${TIMER}`]: ok(),
      'systemctl --user daemon-reload': ok(),
    });
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(result.kinds, ['systemd']);
    assert.deepEqual(fs.readdirSync(unitDir()), ['other.service']);
    const keys = runner.keys();
    assert.ok(keys.indexOf(`systemctl --user disable --now ${TIMER}`) < keys.indexOf('systemctl --user daemon-reload'),
      'disable first, reload after the files are gone');
  });

  it('still deletes the unit files when systemctl is missing, and says it could not disable', () => {
    installUnits();
    const runner = fakeRunner({
      ...NO_CRONTAB,
      [`systemctl --user disable --now ${TIMER}`]: fail(127, 'ENOENT'),
      'systemctl --user daemon-reload': fail(127, 'ENOENT'),
    });
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(fs.readdirSync(unitDir()), ['other.service']);
    assert.ok(result.warnings.some(w => /systemctl/.test(w)), 'the caller is told the timer could not be disabled');
  });

  it('with no unit files it never calls systemctl', () => {
    const runner = fakeRunner(NO_CRONTAB);
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, false);
    assert.ok(runner.calls.every(c => c.cmd !== 'systemctl'));
  });
});

describe('uninstallSchedule on Linux: cron', () => {
  const OUR_LINE = buildCronLine(SCRIPT, '/home/u/aidr/logs', { nodeBinDir: '/opt/node/bin', env: { AIDR_PASSPHRASE_FILE: '/home/u/pass' } });
  const LEGACY_LINE = `0 9 1 * * /bin/bash ${SCRIPT}`;
  const THEIRS = [
    '# m h dom mon dow command',
    '0 3 * * * /usr/bin/backup --tag=$(date +\\%F)',
    '30 4 * * * /usr/bin/report --home=$HOME --host=`hostname`',
    '15 5 * * * /usr/bin/sync --path="/mnt/My Files" && echo done',
    'MAILTO=""',
    '0 6 * * 1 /bin/bash /home/u/aidr/run.sh --dry-run',
    '# auto-identity-remove',
    '',
  ];

  /** A fake crontab that remembers what was written to it. */
  function crontab(initial) {
    const state = { text: initial, writes: [], removed: false };
    const runner = fakeRunner({
      'crontab -l': () => (state.text === null ? fail(1, 'no crontab for u') : ok(state.text)),
      'crontab -': input => { state.writes.push(input); state.text = input; return ok(); },
      'crontab -r': () => { state.removed = true; state.text = null; return ok(); },
    });
    return { state, runner };
  }

  it('removes our marker-tagged line and returns every other line byte for byte', () => {
    const before = [...THEIRS.slice(0, 3), OUR_LINE, ...THEIRS.slice(3)].join('\n');
    const { state, runner } = crontab(before);
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(result.kinds, ['cron']);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0], THEIRS.join('\n'), 'only our line is gone; $(...), backticks, quotes, MAILTO, comments all survive');
  });

  it('removes the legacy line for this script too', () => {
    const { state, runner } = crontab([...THEIRS.slice(0, 2), LEGACY_LINE, ...THEIRS.slice(2)].join('\n'));
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.equal(state.writes[0], THEIRS.join('\n'));
  });

  it('leaves a legacy-looking line for some other run.sh alone', () => {
    const before = ['0 9 1 * * /bin/bash /home/u/other-project/run.sh', ...THEIRS].join('\n');
    const { state, runner } = crontab(before);
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, false);
    assert.equal(state.writes.length, 0, 'the crontab is not rewritten when there is nothing of ours in it');
    assert.equal(state.text, before);
  });

  it('removes every marker-tagged line when an older install left two', () => {
    const second = buildCronLine('/home/u/old-checkout/run.sh', '/home/u/old-checkout/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    const { state, runner } = crontab([OUR_LINE, ...THEIRS, second, ''].join('\n'));
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.equal(state.writes[0], [...THEIRS, ''].join('\n'));
  });

  it('ends the rewritten crontab with a newline even when the original did not (cron drops a last line without one)', () => {
    const { state, runner } = crontab([...THEIRS.slice(0, 5), OUR_LINE].join('\n'));
    uninstall({ platform: 'linux', runner });
    assert.equal(state.writes[0], THEIRS.slice(0, 5).join('\n') + '\n');
  });

  it('removes the crontab itself when our line was the only thing in it', () => {
    const { state, runner } = crontab(OUR_LINE + '\n');
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.equal(state.removed, true);
    assert.equal(state.writes.length, 0, 'no empty crontab is written');
  });

  it('is idempotent: a second run finds nothing, writes nothing', () => {
    const { state, runner } = crontab([...THEIRS, OUR_LINE, ''].join('\n'));
    assert.equal(uninstall({ platform: 'linux', runner }).removed, true);
    const writesAfterFirst = state.writes.length;
    const again = uninstall({ platform: 'linux', runner });
    assert.equal(again.removed, false);
    assert.equal(state.writes.length, writesAfterFirst);
  });

  it('does not write when it cannot read the crontab (it would replace what it could not see)', () => {
    const calls = [];
    const runner = fakeRunner({
      'crontab -l': fail(1, 'no crontab for u'),
      'crontab -': input => { calls.push(input); return ok(); },
    });
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, false);
    assert.equal(calls.length, 0);
  });

  it('reports a failed write and leaves removed false', () => {
    const runner = fakeRunner({
      'crontab -l': ok([OUR_LINE, ...THEIRS].join('\n')),
      'crontab -': fail(1, 'crontab: installing new crontab failed'),
    });
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /crontab/);
  });

  it('after it, getScheduleStatus no longer sees a job', () => {
    const { runner } = crontab([...THEIRS, OUR_LINE, ''].join('\n'));
    assert.equal(getScheduleStatus({ platform: 'linux', runner, homeDir: home, scriptPath: SCRIPT, heartbeatPath: path.join(home, 'x.json') }).installed, true);
    uninstall({ platform: 'linux', runner });
    assert.equal(getScheduleStatus({ platform: 'linux', runner, homeDir: home, scriptPath: SCRIPT, heartbeatPath: path.join(home, 'x.json') }).installed, false);
  });
});

describe('uninstallSchedule on Linux: both a systemd timer and a cron line', () => {
  it('removes both', () => {
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    const { service, timer } = buildSystemdUnits('/opt/aidr/run.sh', '/opt/aidr/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    fs.writeFileSync(path.join(unitDir, 'auto-identity-remove.service'), service);
    fs.writeFileSync(path.join(unitDir, 'auto-identity-remove.timer'), timer);
    const line = buildCronLine(SCRIPT, '/home/u/aidr/logs', { nodeBinDir: '/opt/node/bin', env: {} });
    const runner = fakeRunner({
      [`systemctl --user disable --now ${TIMER}`]: ok(),
      'systemctl --user daemon-reload': ok(),
      'crontab -l': ok(`MAILTO=""\n${line}\n`),
      'crontab -': ok(),
    });
    const result = uninstall({ platform: 'linux', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(result.kinds, ['systemd', 'cron']);
    assert.deepEqual(fs.readdirSync(unitDir), []);
  });
});

describe('uninstallSchedule on Windows (Task Scheduler)', () => {
  const QUERY = 'schtasks /Query /TN auto-identity-remove /XML';
  const DELETE = 'schtasks /Delete /TN auto-identity-remove /F';

  it('deletes our task by name', () => {
    const runner = fakeRunner({ [QUERY]: ok('<Task/>'), [DELETE]: ok('SUCCESS: The scheduled task "auto-identity-remove" was successfully deleted.') });
    const result = uninstall({ platform: 'windows', runner });
    assert.equal(result.removed, true);
    assert.deepEqual(result.kinds, ['schtasks']);
    assert.deepEqual(runner.keys(), [QUERY, DELETE]);
  });

  it('is idempotent: no task, no delete', () => {
    const runner = fakeRunner({ [QUERY]: fail(1, 'ERROR: The system cannot find the file specified.') });
    const result = uninstall({ platform: 'windows', runner });
    assert.equal(result.removed, false);
    assert.deepEqual(runner.keys(), [QUERY]);
  });

  it('reports a delete that is refused', () => {
    const runner = fakeRunner({ [QUERY]: ok('<Task/>'), [DELETE]: fail(1, 'ERROR: Access is denied.') });
    const result = uninstall({ platform: 'windows', runner });
    assert.equal(result.removed, false);
    assert.match(result.errors[0], /Access is denied/);
  });

  it('never looks at crontab or launchctl on Windows', () => {
    const runner = fakeRunner({ [QUERY]: fail(1) });
    uninstall({ platform: 'windows', runner });
    assert.deepEqual([...new Set(runner.calls.map(c => c.cmd))], ['schtasks']);
  });
});
