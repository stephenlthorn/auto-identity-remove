/**
 * test/scheduler-install-result.test.js
 *
 * CLI2-4: every installer returned { method, detail } with no verdict. A crontab
 * write that exited 1, a launchctl load that failed, a schtasks that was refused
 * (and Docker without cron at all) all came back as a result the caller printed
 * as "Scheduler installed via X" and then exited 0. The user believed the
 * monthly job existed; nothing would ever run it.
 *
 * The installers now return `ok`, and --install-scheduler / setup say "NOT
 * installed" and exit 1 when it is false.
 *
 * Nothing here reaches the real crontab, launchctl, systemctl or schtasks: the
 * stdin runner is stubbed, the synchronous child_process calls the installers make
 * are replaced for the length of one call, and unit files land in a temp HOME.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const scheduler = require('../lib/scheduler');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

// The installers call these two; the tests replace them, never call them.
const SHELL_CALL = 'exec' + 'Sync';
const FILE_CALL = 'exec' + 'FileSync';

let tmpDir;
let realHomedir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-install-result-'));
  realHomedir = os.homedir;
  os.homedir = () => tmpDir;
});
afterEach(() => {
  os.homedir = realHomedir;
  scheduler._setStdinRunner(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const paths = () => ({ scriptPath: path.join(tmpDir, 'run.sh'), logDir: path.join(tmpDir, 'logs') });

// Replace one child_process function for the length of `fn`.
function withStub(name, stub, fn) {
  const original = childProcess[name];
  childProcess[name] = stub;
  try {
    return fn();
  } finally {
    childProcess[name] = original;
  }
}

function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

// ── crontab ──────────────────────────────────────────────────────────────────

// `which systemctl` misses (no systemd) and `crontab -l` is empty: the cron branch.
const noSystemdEmptyCrontab = (cmd) => {
  if (/which systemctl/.test(cmd)) throw new Error('not found');
  return '';
};

test('a crontab write that exits non-zero is not ok', () => {
  scheduler._setStdinRunner(() => ({ status: 1, stderr: 'crontab: permission denied' }));
  const result = withStub(SHELL_CALL, noSystemdEmptyCrontab, () =>
    scheduler.installScheduleForPlatform({ platform: 'linux', ...paths() }));
  assert.equal(result.method, 'crontab');
  assert.equal(result.ok, false);
  assert.match(result.detail, /permission denied/);
});

test('a crontab that is not installed at all (Docker) is not ok', () => {
  scheduler._setStdinRunner(() => { throw Object.assign(new Error('spawnSync crontab ENOENT'), { code: 'ENOENT' }); });
  const result = withStub(SHELL_CALL, noSystemdEmptyCrontab, () =>
    scheduler.installScheduleForPlatform({ platform: 'linux', ...paths() }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /ENOENT/);
});

test('a crontab line that was written is ok', () => {
  scheduler._setStdinRunner(() => ({ status: 0, stderr: '' }));
  const result = withStub(SHELL_CALL, noSystemdEmptyCrontab, () =>
    scheduler.installScheduleForPlatform({ platform: 'linux', ...paths() }));
  assert.equal(result.ok, true);
});

test('a crontab line that is already there is ok and writes nothing', () => {
  let writes = 0;
  scheduler._setStdinRunner(() => { writes++; return { status: 0, stderr: '' }; });
  const { scriptPath, logDir } = paths();
  const existing = `${scheduler.buildCronLine(scriptPath, logDir)}\n`;
  const result = withStub(SHELL_CALL, (cmd) => {
    if (/which systemctl/.test(cmd)) throw new Error('not found');
    return existing;
  }, () => scheduler.installScheduleForPlatform({ platform: 'linux', scriptPath, logDir }));
  assert.equal(result.ok, true);
  assert.equal(writes, 0);
});

test('a path the cron line cannot hold is not ok', () => {
  const result = withStub(SHELL_CALL, noSystemdEmptyCrontab, () =>
    scheduler.installScheduleForPlatform({ platform: 'linux', scriptPath: path.join(tmpDir, 'run\n.sh'), logDir: tmpDir }));
  assert.equal(result.ok, false);
});

// ── launchd ──────────────────────────────────────────────────────────────────

test('a launchctl load that fails is not ok', () => {
  const result = withStub(SHELL_CALL, (cmd) => {
    if (/launchctl load/.test(cmd)) throw new Error('Load failed: 5: Input/output error');
    return '';
  }, () => scheduler.installScheduleForPlatform({ platform: 'macos', ...paths() }));
  assert.equal(result.method, 'launchd');
  assert.equal(result.ok, false);
  assert.match(result.detail, /Load failed/);
  assert.match(result.detail, /Manually load/);
});

test('a launchctl load that "succeeds" but leaves no loaded job is not ok', () => {
  // launchctl load has exited 0 on a failed load on some macOS versions: the job
  // must be seen in `launchctl list` before it is called installed.
  const result = withStub(SHELL_CALL, (cmd) => {
    if (/launchctl list/.test(cmd)) throw new Error('Could not find service "com.auto-identity-remove"');
    return '';
  }, () => scheduler.installScheduleForPlatform({ platform: 'macos', ...paths() }));
  assert.equal(result.ok, false);
});

test('a launchd job that loaded is ok', () => {
  const result = withStub(SHELL_CALL, () => '', () =>
    scheduler.installScheduleForPlatform({ platform: 'macos', ...paths() }));
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(tmpDir, 'Library', 'LaunchAgents', 'com.auto-identity-remove.plist')));
});

// ── systemd ──────────────────────────────────────────────────────────────────

test('a systemctl enable that fails (no user bus, a container) is not ok', () => {
  const result = withStub(SHELL_CALL, (cmd) => {
    if (/enable --now/.test(cmd)) throw new Error('Failed to connect to bus: No medium found');
    return '';
  }, () => scheduler.installScheduleForPlatform({ platform: 'linux', ...paths() }));
  assert.equal(result.method, 'systemd');
  assert.equal(result.ok, false);
  assert.match(result.detail, /Failed to connect to bus/);
});

test('a systemd timer that was enabled is ok', () => {
  const result = withStub(SHELL_CALL, () => '', () =>
    scheduler.installScheduleForPlatform({ platform: 'linux', ...paths() }));
  assert.equal(result.method, 'systemd');
  assert.equal(result.ok, true);
});

// ── Task Scheduler ───────────────────────────────────────────────────────────

test('a schtasks that is refused is not ok, and the manual command is in the detail', () => {
  const result = quietly(() => withStub(FILE_CALL, () => { throw new Error('Access denied'); }, () =>
    scheduler.installScheduleForPlatform({ platform: 'windows', scriptPath: 'C:\\aidr\\run.sh', logDir: 'C:\\aidr\\logs' })));
  assert.equal(result.method, 'manual');
  assert.equal(result.ok, false);
  assert.match(result.detail, /schtasks \/Create/);
});

test('a schtasks that created the task is ok', () => {
  const result = withStub(FILE_CALL, () => Buffer.from(''), () =>
    scheduler.installScheduleForPlatform({ platform: 'windows', scriptPath: 'C:\\aidr\\run.sh', logDir: 'C:\\aidr\\logs' }));
  assert.equal(result.method, 'schtasks');
  assert.equal(result.ok, true);
});

// ── --install-scheduler, end to end ──────────────────────────────────────────

test('--install-scheduler says NOT installed and exits 1 when the OS scheduler refuses', async () => {
  // The sandbox fences every scheduler command: this host's launchctl, systemctl
  // and crontab all refuse, which is the failure CLI2-4 described.
  const sandbox = createSandbox();
  try {
    const r = await runWatcher(sandbox, ['--install-scheduler']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = r.stdout + r.stderr;
    assert.match(text, /NOT installed/);
    assert.doesNotMatch(text, /Scheduler installed via/);
    assert.doesNotMatch(text, /Check it any time with/, 'no hint to check a job that does not exist');
  } finally {
    sandbox.cleanup();
  }
});
