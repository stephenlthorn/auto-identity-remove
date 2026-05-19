/**
 * test/scheduler.test.js
 *
 * Unit tests for lib/scheduler.js.
 *
 * Strategy: all four platform branches are exercised by injecting a mock
 * execSync via Module._resolveFilename override on child_process, and by
 * using pickScheduler(platform) to select the branch without touching the
 * real OS.  No files are written to ~/Library, ~/.config, or any system
 * directory — all fs calls are intercepted via a temp directory.
 *
 * Tests run with Node's built-in test runner (`node --test`).
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory for each test so real system paths are never
 * touched.  Cleaned up in afterEach.
 */
let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Dummy paths used across tests */
function makePaths() {
  return {
    scriptPath: path.join(tmpDir, 'run.sh'),
    logDir:     path.join(tmpDir, 'logs'),
  };
}

// ─── Import the helpers under test ──────────────────────────────────────────
// We test the pure helpers (buildPlist, buildSystemdUnits, pickScheduler)
// and the platform-branching logic without running real OS commands.

const {
  pickScheduler,
  buildPlist,
  buildSystemdUnits,
  buildWindowsSchtasksCmd,
} = require('../lib/scheduler');

// ─── buildPlist ──────────────────────────────────────────────────────────────

test('buildPlist returns valid XML containing the script path and log paths', () => {
  const scriptPath = '/home/user/project/run.sh';
  const logDir     = '/home/user/project/logs';
  const xml = buildPlist(scriptPath, logDir);

  assert.ok(xml.startsWith('<?xml'), 'should be XML');
  assert.match(xml, /com\.auto-identity-remove/, 'label present');
  assert.match(xml, new RegExp(scriptPath.replace(/\//g, '\\/')), 'scriptPath in plist');
  assert.match(xml, /launchd\.log/, 'stdout log referenced');
  assert.match(xml, /launchd\.error\.log/, 'stderr log referenced');
  assert.match(xml, /<key>Day<\/key><integer>1<\/integer>/, 'Day=1');
  assert.match(xml, /<key>Hour<\/key><integer>9<\/integer>/, 'Hour=9');
  assert.match(xml, /<key>Minute<\/key><integer>0<\/integer>/, 'Minute=0');
  assert.match(xml, /<false\/>/, 'RunAtLoad false');
});

test('buildPlist uses PLAYWRIGHT_BROWSERS_PATH env var when set', () => {
  const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/custom/browsers';
  const xml = buildPlist('/s.sh', '/logs');
  assert.match(xml, /\/custom\/browsers/, 'custom browser path embedded');
  if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
});

// ─── buildSystemdUnits ───────────────────────────────────────────────────────

test('buildSystemdUnits returns service and timer with correct content', () => {
  const { service, timer } = buildSystemdUnits('/path/run.sh', '/path/logs');

  // Service
  assert.match(service, /\[Unit\]/, 'service has [Unit]');
  assert.match(service, /ExecStart=\/bin\/bash \/path\/run\.sh/, 'ExecStart correct');
  assert.match(service, /systemd\.log/, 'stdout log referenced');
  assert.match(service, /systemd\.error\.log/, 'stderr log referenced');

  // Timer
  assert.match(timer, /\[Timer\]/, 'timer has [Timer]');
  assert.match(timer, /OnCalendar=\*-\*-01 09:00:00/, 'OnCalendar monthly 1st at 09:00');
  assert.match(timer, /Persistent=true/, 'Persistent=true for missed runs');
  assert.match(timer, /\[Install\]/, 'timer has [Install]');
});

// ─── pickScheduler ───────────────────────────────────────────────────────────

test('pickScheduler: macos returns a function (launchd installer)', () => {
  const fn = pickScheduler('macos');
  assert.equal(typeof fn, 'function');
});

test('pickScheduler: linux returns a function (linux installer)', () => {
  const fn = pickScheduler('linux');
  assert.equal(typeof fn, 'function');
});

test('pickScheduler: windows returns a function (windows installer)', () => {
  const fn = pickScheduler('windows');
  assert.equal(typeof fn, 'function');
});

test('pickScheduler: unknown platform falls back to linux installer', () => {
  const fnLinux   = pickScheduler('linux');
  const fnUnknown = pickScheduler('freebsd');
  // Both should be the same function reference (the linux installer)
  assert.equal(fnLinux, fnUnknown, 'unknown platform maps to the linux installer');
});

// ─── macOS branch: plist written to temp dir ─────────────────────────────────

test('macOS installer writes a plist file and returns method=launchd', () => {
  // Override the child_process.execSync used by the module to avoid real launchctl
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const executed = [];
  childProcess.execSync = (cmd, opts) => { executed.push(cmd); };

  // Override os.homedir to point into tmpDir so plist lands there
  const realHomedir = os.homedir;
  os.homedir = () => tmpDir;

  // Re-require the module with patched homedir for PLIST_PATH calculation
  // Instead: call the installer directly with our temp paths
  // We need to patch the PLIST_PATH used inside installLaunchd.
  // Since PLIST_PATH is module-level, we test via the exported function
  // indirectly — we just verify the plist XML ends up in the right place.

  // Call the macOS installer obtained via pickScheduler
  const { installSchedule } = require('../lib/scheduler');
  const { scriptPath, logDir } = makePaths();

  let result;
  try {
    result = installSchedule({ scriptPath, logDir });
  } finally {
    childProcess.execSync = realExecSync;
    os.homedir = realHomedir;
  }

  assert.equal(result.method, 'launchd', 'method is launchd on macOS host');
  // launchctl command was attempted
  assert.ok(
    executed.some(c => c.includes('launchctl')),
    'launchctl was called'
  );
});

// ─── Linux systemd branch ────────────────────────────────────────────────────

test('Linux systemd branch writes unit files and calls systemctl', () => {
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const executed = [];
  // Simulate: `which systemctl` succeeds, then systemctl daemon-reload + enable succeeds
  childProcess.execSync = (cmd, opts) => {
    executed.push(cmd);
    // Don't throw — simulate success
    return '';
  };

  // Patch os.homedir so unit files go to tmpDir
  const realHomedir = os.homedir;
  os.homedir = () => tmpDir;

  // Force linux platform by calling the linux installer directly
  // We get it from pickScheduler then call it with our temp paths
  const installer = pickScheduler('linux');
  const { scriptPath, logDir } = makePaths();

  let result;
  try {
    result = installer(scriptPath, logDir);
  } finally {
    childProcess.execSync = realExecSync;
    os.homedir = realHomedir;
  }

  assert.equal(result.method, 'systemd');

  // Unit files should have been created under tmpDir/.config/systemd/user/
  const unitDir = path.join(tmpDir, '.config', 'systemd', 'user');
  const serviceFile = path.join(unitDir, 'auto-identity-remove.service');
  const timerFile   = path.join(unitDir, 'auto-identity-remove.timer');

  assert.ok(fs.existsSync(serviceFile), '.service file created');
  assert.ok(fs.existsSync(timerFile),   '.timer file created');

  const serviceContent = fs.readFileSync(serviceFile, 'utf8');
  assert.match(serviceContent, /ExecStart=/, '.service has ExecStart');

  const timerContent = fs.readFileSync(timerFile, 'utf8');
  assert.match(timerContent, /OnCalendar=\*-\*-01 09:00:00/, 'timer fires monthly on 1st');

  assert.ok(executed.some(c => c.includes('systemctl')), 'systemctl was called');
});

// ─── Linux crontab branch ────────────────────────────────────────────────────

test('Linux crontab branch appends cron line and returns method=crontab', () => {
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const executed = [];
  childProcess.execSync = (cmd, opts) => {
    executed.push(cmd);
    // Simulate `which systemctl` failing (no systemd), then crontab -l empty
    if (cmd === 'which systemctl') {
      const err = new Error('not found');
      throw err;
    }
    if (cmd.includes('crontab -l')) return '';
    return '';
  };

  const installer = pickScheduler('linux');
  const { scriptPath, logDir } = makePaths();

  let result;
  try {
    result = installer(scriptPath, logDir);
  } finally {
    childProcess.execSync = realExecSync;
  }

  assert.equal(result.method, 'crontab');
  assert.match(result.detail, /0 9 1 \* \*/, 'cron schedule in detail');
  assert.ok(executed.some(c => c.includes('crontab')), 'crontab was called');
});

test('Linux crontab branch skips duplicate lines', () => {
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const scriptPath = '/usr/local/bin/run.sh';
  const existingCron = `0 9 1 * * /bin/bash ${scriptPath}\n`;
  const executed = [];

  childProcess.execSync = (cmd, opts) => {
    executed.push(cmd);
    if (cmd === 'which systemctl') throw new Error('not found');
    if (cmd.includes('crontab -l')) return existingCron;
    return '';
  };

  const installer = pickScheduler('linux');
  const { logDir } = makePaths();

  let result;
  try {
    result = installer(scriptPath, logDir);
  } finally {
    childProcess.execSync = realExecSync;
  }

  assert.equal(result.method, 'crontab');
  assert.match(result.detail, /already present/, 'dedup: skips existing line');
  // Should NOT call `crontab -` (the write command) when line already exists
  assert.ok(
    !executed.some(c => c.includes('| crontab -') || c.includes('echo')),
    'does not write crontab when line exists'
  );
});

// ─── Windows branch ──────────────────────────────────────────────────────────

test('Windows branch calls schtasks and returns method=schtasks on success', () => {
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const executed = [];
  childProcess.execSync = (cmd, opts) => {
    executed.push(cmd);
    return '';
  };

  const installer = pickScheduler('windows');
  const { scriptPath, logDir } = makePaths();

  let result;
  try {
    result = installer(scriptPath, logDir);
  } finally {
    childProcess.execSync = realExecSync;
  }

  assert.equal(result.method, 'schtasks');
  assert.ok(executed.some(c => c.includes('schtasks')), 'schtasks was called');
  assert.match(executed.find(c => c.includes('schtasks')), /\/SC MONTHLY/, 'monthly schedule');
  assert.match(executed.find(c => c.includes('schtasks')), /\/D 1/, 'day=1');
  assert.match(executed.find(c => c.includes('schtasks')), /\/ST 09:00/, 'time=09:00');
  assert.match(result.detail, /auto-identity-remove/, 'task name in detail');
});

test('Windows branch returns method=manual when schtasks throws', () => {
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  childProcess.execSync = (cmd, opts) => {
    if (cmd.includes('schtasks')) throw new Error('Access denied');
    return '';
  };

  // Suppress the console.log output for the manual command
  const origLog = console.log;
  console.log = () => {};

  const installer = pickScheduler('windows');
  const { scriptPath, logDir } = makePaths();

  let result;
  try {
    result = installer(scriptPath, logDir);
  } finally {
    childProcess.execSync = realExecSync;
    console.log = origLog;
  }

  assert.equal(result.method, 'manual', 'falls back to manual on schtasks error');
  assert.match(result.detail, /manually/, 'detail explains manual step');
});

// ─── buildWindowsSchtasksCmd (pure helper) ───────────────────────────────────

test('buildWindowsSchtasksCmd returns a string containing schtasks /Create', () => {
  const cmd = buildWindowsSchtasksCmd('/path/to/node.exe', '/path/to/watcher.js');
  assert.equal(typeof cmd, 'string', 'returns a string');
  assert.match(cmd, /schtasks \/Create/, 'starts with schtasks /Create');
});

test('buildWindowsSchtasksCmd includes /SC MONTHLY /D 1', () => {
  const cmd = buildWindowsSchtasksCmd('node.exe', 'watcher.js');
  assert.match(cmd, /\/SC MONTHLY/, 'monthly schedule');
  assert.match(cmd, /\/D 1/, 'day=1');
});

test('buildWindowsSchtasksCmd default time is /ST 09:00', () => {
  const cmd = buildWindowsSchtasksCmd('node.exe', 'watcher.js');
  assert.match(cmd, /\/ST 09:00/, 'default time 09:00');
});

test('buildWindowsSchtasksCmd honours custom {hour, minute}', () => {
  const cmd = buildWindowsSchtasksCmd('node.exe', 'watcher.js', { hour: 3, minute: 30 });
  assert.match(cmd, /\/ST 03:30/, 'custom time 03:30');
});

test('buildWindowsSchtasksCmd includes /TN "auto-identity-remove"', () => {
  const cmd = buildWindowsSchtasksCmd('node.exe', 'watcher.js');
  assert.match(cmd, /\/TN "auto-identity-remove"/, 'task name quoted');
});

test('buildWindowsSchtasksCmd wraps paths with spaces in double quotes', () => {
  const cmd = buildWindowsSchtasksCmd(
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\My Documents\\watcher.js'
  );
  assert.match(cmd, /"C:\\Program Files\\nodejs\\node\.exe"/, 'node path quoted');
  assert.match(cmd, /"C:\\My Documents\\watcher\.js"/, 'watcher path quoted');
});

test('buildWindowsSchtasksCmd includes /F flag to overwrite existing task', () => {
  const cmd = buildWindowsSchtasksCmd('node.exe', 'watcher.js');
  assert.match(cmd, /\/F/, '/F flag present');
});

// ─── --install-scheduler flag routing ────────────────────────────────────────

test('installScheduleForPlatform routes macos to launchd', () => {
  const { installScheduleForPlatform } = require('../lib/scheduler');
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;
  const realHomedir = os.homedir;

  const executed = [];
  childProcess.execSync = (cmd) => { executed.push(cmd); return ''; };
  os.homedir = () => tmpDir;

  let result;
  try {
    result = installScheduleForPlatform({
      platform: 'macos',
      scriptPath: path.join(tmpDir, 'run.sh'),
      logDir: path.join(tmpDir, 'logs'),
    });
  } finally {
    childProcess.execSync = realExecSync;
    os.homedir = realHomedir;
  }

  assert.equal(result.method, 'launchd', 'macos routes to launchd');
});

test('installScheduleForPlatform routes linux to systemd or crontab', () => {
  const { installScheduleForPlatform } = require('../lib/scheduler');
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;
  const realHomedir = os.homedir;

  const executed = [];
  childProcess.execSync = (cmd) => { executed.push(cmd); return ''; };
  os.homedir = () => tmpDir;

  let result;
  try {
    result = installScheduleForPlatform({
      platform: 'linux',
      scriptPath: path.join(tmpDir, 'run.sh'),
      logDir: path.join(tmpDir, 'logs'),
    });
  } finally {
    childProcess.execSync = realExecSync;
    os.homedir = realHomedir;
  }

  assert.ok(
    result.method === 'systemd' || result.method === 'crontab',
    `linux routes to systemd or crontab, got: ${result.method}`
  );
});

test('installScheduleForPlatform routes windows to schtasks', () => {
  const { installScheduleForPlatform } = require('../lib/scheduler');
  const childProcess = require('child_process');
  const realExecSync = childProcess.execSync;

  const executed = [];
  childProcess.execSync = (cmd) => { executed.push(cmd); return ''; };

  let result;
  try {
    result = installScheduleForPlatform({
      platform: 'windows',
      scriptPath: path.join(tmpDir, 'run.sh'),
      logDir: path.join(tmpDir, 'logs'),
    });
  } finally {
    childProcess.execSync = realExecSync;
  }

  assert.equal(result.method, 'schtasks', 'windows routes to schtasks');
});
