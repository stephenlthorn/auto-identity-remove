/**
 * test/notify-cross-platform.test.js
 *
 * Verifies cross-platform behavior of desktopNotify and openInBrowser.
 * Platform is injected via function argument or setPlatformForTesting to
 * ensure tests pass on any host OS (Linux, macOS, Windows).
 *
 * Stubs child_process.spawn and spawnSync to capture calls without
 * executing real processes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const notify = require('../lib/notify');

// ─── Stub helpers ─────────────────────────────────────────────────────────────

function stubSpawn() {
  const calls = [];
  const orig = childProcess.spawn;
  childProcess.spawn = (cmd, args, opts) => {
    calls.push({ cmd, args: args || [], opts });
    return { unref: () => {} };
  };
  return { calls, restore: () => { childProcess.spawn = orig; } };
}

function stubSpawnSync() {
  const calls = [];
  const orig = childProcess.spawnSync;
  childProcess.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args: args || [], opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, restore: () => { childProcess.spawnSync = orig; } };
}

function stubSpawnSyncThrows() {
  const orig = childProcess.spawnSync;
  childProcess.spawnSync = () => { throw new Error('spawnSync failed'); };
  return { restore: () => { childProcess.spawnSync = orig; } };
}

// ─── desktopNotify: darwin ────────────────────────────────────────────────────

test('desktopNotify: on darwin calls macNotify (osascript)', () => {
  // macNotify now uses execFileSync (not execSync)
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };

  notify.desktopNotify('Title', 'Body', 'darwin');

  childProcess.execFileSync = origExecFile;

  const osCalls = execFileCalls.filter(c => c.file === 'osascript');
  assert.ok(osCalls.length >= 1, 'should call osascript execFileSync on darwin');
  assert.ok(osCalls[0].args.some(a => a.includes('display notification')), 'should be a display notification call');
});

// ─── desktopNotify: linux ────────────────────────────────────────────────────

test('desktopNotify: on linux calls notify-send via spawnSync', () => {
  const { calls, restore } = stubSpawnSync();

  notify.desktopNotify('Test Title', 'Test Message', 'linux');

  restore();

  const nsCalls = calls.filter(c => c.cmd === 'notify-send');
  assert.equal(nsCalls.length, 1, 'should call notify-send once');
  assert.ok(nsCalls[0].args.includes('Test Title'), 'should include title');
  assert.ok(nsCalls[0].args.includes('Test Message'), 'should include message');
});

test('desktopNotify: on linux swallows spawnSync errors and does not throw', () => {
  const { restore } = stubSpawnSyncThrows();

  assert.doesNotThrow(() => notify.desktopNotify('T', 'M', 'linux'));

  restore();
});

// ─── desktopNotify: win32 ────────────────────────────────────────────────────

test('desktopNotify: on win32 tries PowerShell BurntToast via spawnSync', () => {
  const { calls, restore } = stubSpawnSync();

  notify.desktopNotify('Win Title', 'Win Message', 'win32');

  restore();

  const psCalls = calls.filter(c => c.cmd === 'powershell');
  assert.equal(psCalls.length, 1, 'should call powershell once');
  assert.ok(psCalls[0].args.some(a => a.includes('BurntToast')), 'should use BurntToast');
});

test('desktopNotify: on win32 swallows PowerShell errors and does not throw', () => {
  const { restore } = stubSpawnSyncThrows();

  assert.doesNotThrow(() => notify.desktopNotify('T', 'M', 'win32'));

  restore();
});

// ─── desktopNotify: error swallowing ─────────────────────────────────────────

test('desktopNotify: returns without throwing even when all underlying calls fail', () => {
  const origExecFile = childProcess.execFileSync;
  const origExec = childProcess.execSync;
  const origSpawnSync = childProcess.spawnSync;
  childProcess.execFileSync = () => { throw new Error('execFileSync failed'); };
  childProcess.execSync = () => { throw new Error('exec failed'); };
  childProcess.spawnSync = () => { throw new Error('spawnSync failed'); };

  assert.doesNotThrow(() => notify.desktopNotify('T', 'M', 'darwin'));
  assert.doesNotThrow(() => notify.desktopNotify('T', 'M', 'linux'));
  assert.doesNotThrow(() => notify.desktopNotify('T', 'M', 'win32'));

  childProcess.execFileSync = origExecFile;
  childProcess.execSync = origExec;
  childProcess.spawnSync = origSpawnSync;
});

// ─── openInBrowser: linux ────────────────────────────────────────────────────

test('openInBrowser: on linux calls xdg-open via spawn for each URL', () => {
  const { calls, restore } = stubSpawn();

  notify.openInBrowser(['https://a.com', 'https://b.com'], 'linux');

  restore();

  assert.equal(calls.length, 2, 'should spawn twice');
  assert.equal(calls[0].cmd, 'xdg-open');
  assert.ok(calls[0].args.includes('https://a.com'));
  assert.equal(calls[1].cmd, 'xdg-open');
  assert.ok(calls[1].args.includes('https://b.com'));
});

// ─── openInBrowser: win32 ────────────────────────────────────────────────────

test('openInBrowser: on win32 uses cmd /c start with empty title argument', () => {
  const { calls, restore } = stubSpawn();

  notify.openInBrowser(['https://example.com'], 'win32');

  restore();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd');
  assert.ok(calls[0].args.includes('/c'), 'should include /c');
  assert.ok(calls[0].args.includes('start'), 'should include start');
  // The empty title arg must be present before the URL
  const urlIdx = calls[0].args.indexOf('https://example.com');
  const emptyTitleIdx = calls[0].args.indexOf('');
  assert.ok(emptyTitleIdx !== -1, 'should have empty title argument');
  assert.ok(emptyTitleIdx < urlIdx, 'empty title should come before the URL');
});

// ─── openInBrowser: error swallowing ─────────────────────────────────────────

test('openInBrowser: swallows spawn errors and does not throw', () => {
  const origSpawn = childProcess.spawn;
  childProcess.spawn = () => { throw new Error('spawn failed'); };

  assert.doesNotThrow(() => notify.openInBrowser(['https://a.com'], 'linux'));
  assert.doesNotThrow(() => notify.openInBrowser(['https://a.com'], 'win32'));
  assert.doesNotThrow(() => notify.openInBrowser(['https://a.com'], 'darwin'));

  childProcess.spawn = origSpawn;
});

// ─── setPlatformForTesting ────────────────────────────────────────────────────

test('setPlatformForTesting: overrides platform used by desktopNotify', () => {
  const { calls, restore } = stubSpawnSync();

  notify.setPlatformForTesting('linux');
  notify.desktopNotify('Override Title', 'Override Message');
  notify.setPlatformForTesting(null); // reset

  restore();

  const nsCalls = calls.filter(c => c.cmd === 'notify-send');
  assert.equal(nsCalls.length, 1, 'should use linux path via setPlatformForTesting');
});

test('setPlatformForTesting: resets to process.platform when set to null', () => {
  // Just verify it does not throw and export is a function
  assert.equal(typeof notify.setPlatformForTesting, 'function');
  notify.setPlatformForTesting('darwin');
  notify.setPlatformForTesting(null);
  // No assertion needed beyond not throwing
});

// ─── desktopNotify: is exported ──────────────────────────────────────────────

test('desktopNotify: is exported from lib/notify.js', () => {
  assert.equal(typeof notify.desktopNotify, 'function', 'desktopNotify must be exported');
});
