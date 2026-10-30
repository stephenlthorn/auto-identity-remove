/**
 * test/integration-roadmap-commands.test.js
 *
 * The commands the roadmap added, run as the real watcher.js in a sandbox (see
 * test/helpers/watcher-sandbox.js): a temp copy of the repo, a temp config and
 * state, `playwright` replaced by a fake that records what it is asked and refuses
 * to navigate, notifiers stubbed, and the OS scheduler fenced off (lib/scheduler
 * is handed a fake command runner the moment it loads, so nothing here can reach
 * the real crontab, launchctl or systemctl).
 *
 *   aidr captchas                       R1
 *   aidr schedule status|uninstall      R4
 *   aidr config check                   R5
 *   aidr purge                          R6
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const { seedArtifacts, writeLog } = require('./helpers/pii-artifacts');
const { buildPlist, buildSystemdUnits, buildCronLine } = require('../lib/scheduler');

const posix = process.platform !== 'win32';
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
const fresh = (n = 3) => ({ lastSuccess: daysAgo(n), lastAttempt: daysAgo(n) });

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

const launches = (sandbox) => sandbox.fakeEvents().filter(e => e.event === 'launch');
const schedulerCalls = (sandbox) => sandbox.fakeEvents().filter(e => e.event === 'scheduler');
const blockedCalls = (sandbox) => sandbox.fakeEvents().filter(e => e.event === 'scheduler-blocked');

// ── aidr captchas ────────────────────────────────────────────────────────────

test('captchas with no previous run says so, and opens no browser', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--captchas']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No previous run found/);
    assert.deepEqual(sandbox.fakeEvents(), [], 'not a launch, a page, a lookup or a fetch');
    assert.equal(fs.existsSync(sandbox.lock), false, 'it never took the run lock');
    assert.deepEqual(sandbox.runLogs(), []);
  });
});

test('captchas when the last run had no CAPTCHA failures says so, and opens no browser', async () => {
  await inSandbox({}, async (sandbox) => {
    writeLog(sandbox, 'run-2026-01-01T00-00-00.json', {
      succeeded: [{ broker: 'Spokeo', status: 'success' }],
      errors: [{ broker: 'WhitePages', status: 'error', detail: 'Timeout' }],
      manual: [{ broker: 'Google - Results About You', status: 'manual', detail: 'https://myactivity.google.com/results-about-you' }],
    });
    const r = await runWatcher(sandbox, ['--captchas']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No brokers ended on a CAPTCHA in the last run\./);
    assert.deepEqual(sandbox.fakeEvents(), []);
    assert.deepEqual(sandbox.runLogs(), ['run-2026-01-01T00-00-00.json'], 'no new run log: nothing ran');
  });
});

test('captchas re-runs only the CAPTCHA brokers, headed, and marks the log partial', async () => {
  const state = { optOuts: { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(3), WhitePages: fresh(3), 'WhitePages|Alan Turing': fresh(3) } };
  await inSandbox({ state }, async (sandbox) => {
    writeLog(sandbox, 'run-2026-01-01T00-00-00.json', {
      captchaFailed: [{ broker: 'Spokeo', status: 'captcha_failed', detail: 'https://www.spokeo.com/optout - CAPTCHA not solved within 3 min; retry with: aidr captchas' }],
      errors: [{ broker: 'WhitePages', status: 'error' }],
    });
    const r = await runWatcher(sandbox, ['--captchas'], { env: { DISPLAY: ':99' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--captchas: 1 broker\(s\) ended on a CAPTCHA last run/);
    assert.match(r.stdout, /Browser mode: headed/, 'HEADLESS=1 in the environment does not override a command that exists to show a window');
    assert.ok(launches(sandbox).length > 0);
    assert.ok(launches(sandbox).every(e => e.headless === false), 'every launch is headed');

    const log = JSON.parse(fs.readFileSync(path.join(sandbox.logs, sandbox.runLogs().sort().pop()), 'utf8'));
    assert.deepEqual([...new Set(log.skipped.map(e => e.broker))], ['Spokeo'], 'WhitePages errored but did not hit a CAPTCHA, so it is not re-run');
    assert.equal(log.partial, true, 'a later full run must not be diffed against this one');
    assert.equal(log.filter.captchas, true);
    assert.equal(log.genericStats.attempted, 0, 'the generic pass honours the same selection');
  });
});

test('captchas reads a crashed run\'s journal when it never wrote a summary', async () => {
  const state = { optOuts: { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(3) } };
  await inSandbox({ state }, async (sandbox) => {
    const lines = [
      { type: 'run', startedAt: '2026-01-01T00:00:00.000Z', mode: 'run', partial: false, filter: null },
      { broker: 'Spokeo', status: 'captcha_failed', detail: 'https://www.spokeo.com/optout - CAPTCHA could not be solved', time: '2026-01-01T00:00:05.000Z', person: 'Ada Lovelace' },
      { broker: 'Radaris', status: 'success', detail: 'ok', time: '2026-01-01T00:00:09.000Z', person: 'Ada Lovelace' },
    ];
    writeLog(sandbox, 'run-2026-01-01T00-00-00.jsonl', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const r = await runWatcher(sandbox, ['--captchas'], { env: { DISPLAY: ':99' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--captchas: 1 broker\(s\) ended on a CAPTCHA last run/);
  });
});

test('captchas on a machine with no display says plainly that it needs one', { skip: process.platform !== 'linux' }, async () => {
  await inSandbox({}, async (sandbox) => {
    writeLog(sandbox, 'run-2026-01-01T00-00-00.json', { captchaFailed: [{ broker: 'Spokeo', status: 'captcha_failed' }] });
    const r = await runWatcher(sandbox, ['--captchas']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /aidr captchas needs a display to show the CAPTCHAs\. Run it on a desktop machine\./);
    assert.deepEqual(launches(sandbox), [], 'no window was attempted');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('captchas refuses another broker selector with exit 2 and runs nothing', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--captchas', '--only', 'Spokeo']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--captchas cannot be combined with --only/);
    assert.deepEqual(sandbox.fakeEvents(), []);
  });
});

// ── aidr schedule status | uninstall ─────────────────────────────────────────

/**
 * A scheduled job as this platform keeps it, written into the sandbox's HOME, and
 * the answers the fake scheduler gives the commands that ask about it. macOS
 * reads a launchd plist and asks launchctl; Linux reads the systemd user units and
 * asks systemctl. Windows is not exercised by the sandbox tests at all.
 */
function installJob(sandbox, { active = true, env = {}, plaintextPassphrase = false, extraAnswers = {} } = {}) {
  const scriptPath = path.join(sandbox.repo, 'run.sh');
  const logDir = path.join(sandbox.repo, 'logs');
  let answers;
  if (process.platform === 'darwin') {
    const dir = path.join(sandbox.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    let xml = buildPlist(scriptPath, logDir, { env });
    if (plaintextPassphrase) xml = xml.replace('<key>PATH</key>', '<key>AIDR_PASSPHRASE</key><string>hunter2-secret</string><key>PATH</key>');
    fs.writeFileSync(path.join(dir, 'com.auto-identity-remove.plist'), xml);
    answers = { 'launchctl list com.auto-identity-remove': { status: active ? 0 : 113, stderr: active ? '' : 'Could not find service' } };
  } else {
    const dir = path.join(sandbox.home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const units = buildSystemdUnits(scriptPath, logDir, { env });
    const service = plaintextPassphrase ? units.service.replace('[Service]\n', '[Service]\nEnvironment="AIDR_PASSPHRASE=hunter2-secret"\n') : units.service;
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.service'), service);
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.timer'), units.timer);
    answers = { 'systemctl --user is-enabled auto-identity-remove.timer': { status: active ? 0 : 1, stdout: active ? 'enabled\n' : 'disabled\n' } };
  }
  const file = path.join(sandbox.dir, 'scheduler.json');
  fs.writeFileSync(file, JSON.stringify({ ...answers, ...extraAnswers }));
  return { AIDR_FAKE_SCHEDULER: file };
}

const heartbeatFile = (sandbox) => path.join(sandbox.home, 'last-run.json');

test('schedule status --json reports an installed job, the carried paths and the last run', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox, { env: { AIDR_HOME: '/srv/aidr-home', AIDR_LOG_DIR: '/srv/aidr-logs' } });
    fs.writeFileSync(heartbeatFile(sandbox), JSON.stringify({
      startedAt: daysAgo(2), finishedAt: new Date(Date.now() - 2 * day + 600000).toISOString(), outcome: 'ok', counts: { succeeded: 7, skipped: 30 },
    }), { mode: 0o600 });

    const r = await runWatcher(sandbox, ['--schedule-status', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    const status = JSON.parse(r.stdout);
    assert.equal(status.installed, true);
    assert.ok(['launchd', 'systemd'].includes(status.kind), status.kind);
    assert.equal(status.active, true);
    assert.equal(status.env.AIDR_HOME, '/srv/aidr-home', 'the job carries AIDR_HOME, so it reads the same install');
    assert.equal(status.env.AIDR_LOG_DIR, '/srv/aidr-logs');
    assert.equal(status.lastRun.outcome, 'ok');
    assert.equal(status.lastRun.counts.succeeded, 7);
    assert.equal(status.plaintextPassphrase, false);

    assert.ok(schedulerCalls(sandbox).length > 0, 'it asked the (fake) scheduler');
    assert.deepEqual(blockedCalls(sandbox), [], 'and never reached the real one');
    assert.deepEqual(launches(sandbox), [], 'no browser for a status read');
    assert.equal(fs.existsSync(sandbox.lock), false, 'no run lock for a read-only command');
  });
});

test('schedule status prints a readable summary without --json', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox);
    const r = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Schedule: installed \((launchd|systemd)\)/);
    assert.match(r.stdout, /Active:\s+yes/);
    assert.match(r.stdout, /Last run: no run recorded yet/);
  });
});

test('schedule status with nothing installed exits 1 and says how to install', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const text = await runWatcher(sandbox, ['--schedule-status']);
    assert.equal(text.code, 1);
    assert.match(text.stdout, /Schedule: not installed/);
    assert.match(text.stdout, /aidr schedule install/);

    const json = await runWatcher(sandbox, ['--schedule-status', '--json']);
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stdout).installed, false);
    assert.deepEqual(blockedCalls(sandbox), []);
  });
});

test('schedule status exits 2 for a job that exists but will not fire', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox, { active: false });
    const r = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Active:\s+NO/);
  });
});

test('schedule status warns about a plaintext passphrase in the job without printing it', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox, { plaintextPassphrase: true });
    const json = await runWatcher(sandbox, ['--schedule-status', '--json'], { env });
    assert.equal(JSON.parse(json.stdout).plaintextPassphrase, true);
    const text = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.match(text.stdout, /WARNING:\s+AIDR_PASSPHRASE is written into the job definition/);
    assert.ok(!(json.stdout + json.stderr + text.stdout + text.stderr).includes('hunter2-secret'), 'the value never leaves the job file');
  });
});

test('schedule status shows a crashed last run, read from a heartbeat with no end', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox);
    fs.writeFileSync(heartbeatFile(sandbox), JSON.stringify({ startedAt: daysAgo(3), finishedAt: null, outcome: null, counts: {} }), { mode: 0o600 });
    const r = await runWatcher(sandbox, ['--schedule-status', '--json'], { env });
    assert.equal(JSON.parse(r.stdout).lastRun.outcome, 'crashed');
    const text = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.match(text.stdout, /never finished \(crashed\)/);
  });
});

test('schedule uninstall removes the job and nothing else', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    // Once the job is removed the scheduler no longer knows it: launchctl list fails,
    // and the bootout / disable commands succeed.
    const env = installJob(sandbox, {
      active: false,
      extraAnswers: {
        [`launchctl bootout gui/${process.getuid()}/com.auto-identity-remove`]: { status: 0 },
        'systemctl --user disable --now auto-identity-remove.timer': { status: 0 },
      },
    });
    const unrelated = path.join(sandbox.home, 'keep-me.txt');
    fs.writeFileSync(unrelated, 'mine');
    const r = await runWatcher(sandbox, ['--uninstall-scheduler'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /launchd job com\.auto-identity-remove removed|systemd timer auto-identity-remove\.timer disabled/);
    const plist = path.join(sandbox.home, 'Library', 'LaunchAgents', 'com.auto-identity-remove.plist');
    const units = path.join(sandbox.home, '.config', 'systemd', 'user');
    assert.equal(fs.existsSync(plist), false);
    assert.equal(fs.existsSync(path.join(units, 'auto-identity-remove.timer')), false);
    assert.equal(fs.existsSync(path.join(units, 'auto-identity-remove.service')), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'mine');
    assert.deepEqual(blockedCalls(sandbox), []);
  });
});

// cron is the Linux fallback; macOS keeps its job in launchd and never reads a crontab.
test('schedule uninstall removes only our cron line and leaves every other line alone', { skip: process.platform !== 'linux' }, async () => {
  await inSandbox({}, async (sandbox) => {
    const scriptPath = path.join(sandbox.repo, 'run.sh');
    const ours = buildCronLine(scriptPath, path.join(sandbox.repo, 'logs'), { env: {} });
    const crontab = `# my own jobs\n0 5 * * * /usr/bin/backup --now\n${ours}\n30 6 * * 1 /usr/bin/other\n`;
    const file = path.join(sandbox.dir, 'scheduler.json');
    fs.writeFileSync(file, JSON.stringify({ 'crontab -l': { status: 0, stdout: crontab }, 'crontab -': { status: 0 } }));
    const r = await runWatcher(sandbox, ['--uninstall-scheduler'], { env: { AIDR_FAKE_SCHEDULER: file } });
    assert.equal(r.code, 0, r.stderr);
    const writes = schedulerCalls(sandbox).filter(e => e.cmd === 'crontab' && e.args.join(' ') === '-');
    assert.equal(writes.length, 1, 'the remaining crontab was written once, through the (fake) runner');
    assert.equal(writes[0].stdin, true);
    assert.match(r.stdout, /removed 1 cron line/);
    assert.deepEqual(blockedCalls(sandbox), []);
  });
});

test('schedule uninstall with nothing installed is a calm no-op', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--uninstall-scheduler']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No schedule installed - nothing to remove\./);
    assert.deepEqual(blockedCalls(sandbox), []);
    assert.deepEqual(schedulerCalls(sandbox).filter(e => e.stdin), [], 'nothing was written to any scheduler');
  });
});

// ── aidr config check ────────────────────────────────────────────────────────

test('config check on a runnable config exits 0, reports where things live, and never prints the person', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /aidr config check/);
    assert.match(r.stdout, /Result: OK/);
    assert.ok(r.stdout.includes(sandbox.config), 'which config file is in use');
    assert.ok(r.stdout.includes(sandbox.state), 'where state lives');
    for (const secret of ['Ada', 'Lovelace', 'ada@lovelace-test.example', '5125550101']) {
      assert.ok(!r.stdout.includes(secret), `the report must not contain ${secret}`);
    }
    assert.deepEqual(sandbox.fakeEvents(), [], 'a check opens no browser');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('config check exits 1 and lists every problem for an unedited example config', async () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  await inSandbox({ config: example }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /problem: .*placeholder/);
    assert.match(r.stdout, /Result: \d+ problems?/);
    assert.deepEqual(sandbox.fakeEvents(), []);
  });
});

test('config check exits 1, without crashing, when there is no config at all', async () => {
  await inSandbox({ config: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /problem: config not found/);
    assert.match(r.stdout, /setup/);
  });
});

test('config check fails on a bad browser section and never prints the proxy password', async () => {
  const config = runnableConfig({ browser: { proxy: { server: 'ftp://proxy.example.test:21', username: 'proxy-user-5521', password: 'proxy-pass-7731' } } });
  await inSandbox({ config }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /problem: .*proxy/i);
    assert.ok(!(r.stdout + r.stderr).includes('proxy-pass-7731'));
    assert.ok(!(r.stdout + r.stderr).includes('proxy-user-5521'));
  });
});

test('config check warns about a mistyped captcha setting but still exits 0', async () => {
  const config = runnableConfig({ captcha: { manual: 'maybe', manualTimeoutSec: -3 } });
  await inSandbox({ config }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /warning: captcha\.manual must be "auto", true or false/);
    assert.match(r.stdout, /warning: captcha\.manualTimeoutSec must be a number of seconds above 0/);
    assert.match(r.stdout, /Result: OK, 2 warnings/);
  });
});

test('config check reports an encrypted config with no passphrase as a problem', async () => {
  const secrets = require('../lib/secrets');
  await inSandbox({ config: null }, async (sandbox) => {
    fs.writeFileSync(sandbox.configEnc, JSON.stringify(secrets.encryptConfig(runnableConfig(), 'a-passphrase-for-the-test')), { mode: 0o600 });
    const r = await runWatcher(sandbox, ['--config-check']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /encrypted .* but no passphrase is set/);
    assert.match(r.stdout, /AIDR_PASSPHRASE_FILE/);
  });
});

// ── aidr purge ───────────────────────────────────────────────────────────────

test('purge --dry-run lists what would go and deletes nothing', async () => {
  await inSandbox({}, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--purge', '--dry-run', '--older-than', '30d']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Would delete \d+ files?/);
    assert.match(r.stdout, /Dry run: nothing was deleted\./);
    assert.match(r.stdout, new RegExp(path.basename(files.oldRun).replace(/\./g, '\\.')));
    assert.ok(!r.stdout.includes(sandbox.dir), 'file names only: a directory path would carry a home directory into the output');
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file), `${path.basename(file)} must still exist`);
  });
});

test('purge without --yes and without a terminal deletes nothing and exits 2', async () => {
  await inSandbox({}, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--purge', '--older-than', '30d']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not deleting: there is no terminal to confirm on\. Re-run with --yes/);
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file));
  });
});

test('purge --yes deletes the old PII files and never the latest run, complaints, state or config', async () => {
  await inSandbox({}, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--purge', '--older-than', '30d', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Deleted \d+ files?/);

    for (const name of ['oldRun', 'oldJournal', 'oldAudit', 'oldSnapshot', 'oldReport', 'middleRun']) {
      assert.equal(fs.existsSync(files[name]), false, `${name} should have been purged`);
    }
    for (const name of ['newestRun', 'newestJournal', 'newestAudit', 'complaint']) {
      assert.equal(fs.existsSync(files[name]), true, `${name} must be kept`);
    }
    assert.ok(fs.existsSync(sandbox.state));
    assert.ok(fs.existsSync(sandbox.config));
    assert.deepEqual(sandbox.fakeEvents(), [], 'purge opens no browser');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('purge with nothing old enough says so and exits 0', async () => {
  await inSandbox({}, async (sandbox) => {
    seedArtifacts(sandbox, { ageDays: 2 });
    const r = await runWatcher(sandbox, ['--purge', '--older-than', '30d', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nothing to purge/);
  });
});

test('purge refuses an age under 7 days unless --force, exit 2, and deletes nothing', async () => {
  await inSandbox({}, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const refused = await runWatcher(sandbox, ['--purge', '--older-than', '3d', '--yes']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /refusing to purge files younger than 7 days/);
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file));

    const forced = await runWatcher(sandbox, ['--purge', '--older-than', '3d', '--force', '--dry-run']);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /Would delete/);
  });
});

test('purge rejects an age it cannot read, exit 2', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--purge', '--older-than', 'soon', '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot read age "soon"/);
  });
});

test('purge uses retention.days from the config when --older-than is not given', async () => {
  await inSandbox({ config: runnableConfig({ retention: { days: 60 } }) }, async (sandbox) => {
    const files = seedArtifacts(sandbox, { ageDays: 90 });
    const r = await runWatcher(sandbox, ['--purge', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(files.oldRun), false, '90 days old is past the configured 60');
    assert.doesNotMatch(r.stdout, /Note:/);
  });
});

test('purge falls back to 180 days, and says so, when the config cannot say', async () => {
  await inSandbox({ config: null }, async (sandbox) => {
    const files = seedArtifacts(sandbox, { ageDays: 90 });
    const r = await runWatcher(sandbox, ['--purge', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Note: config not read \(ENOCONFIG\)/);
    assert.match(r.stdout, /using the default of 180 days/);
    assert.equal(fs.existsSync(files.oldRun), true, '90 days is inside 180');
  });
});

test('a purge modifier outside --purge is refused with exit 2', async () => {
  await inSandbox({}, async (sandbox) => {
    for (const args of [['--yes'], ['--older-than', '30d'], ['--force']]) {
      const r = await runWatcher(sandbox, args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /only applies together with --purge/);
    }
    assert.deepEqual(sandbox.fakeEvents(), [], 'and no run was started');
  });
});
