/**
 * test/notify.test.js
 *
 * Covers lib/notify.js cross-platform dispatcher and helpers.
 * Strategy:
 *   - monkey-patch child_process.execSync to capture calls without running them
 *   - stub global fetch to capture webhook calls without hitting the network
 *   - inject the platform string via dispatchNotify's 3rd argument
 *   - never touch real processes or network
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Capture all childProcess.execSync calls; restore on teardown.
 * notify.js calls `cp.execSync(...)` via the module reference so patching the
 * module object intercepts it correctly.
 */
function stubExecSync() {
  const calls = [];
  const orig = childProcess.execSync;
  childProcess.execSync = (...args) => { calls.push(args[0]); };
  return { calls, restore: () => { childProcess.execSync = orig; } };
}

/** Stub global fetch; returns recorded calls. */
function stubFetch() {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts?.body || '{}') });
    return { ok: true };
  };
  return { calls, restore: () => { global.fetch = origFetch; } };
}

// ── Re-require notify after stubs are in place ───────────────────────────────
// notify.js requires child_process at module level; we patch the module object.

const notify = require('../lib/notify');

// ─── sendText ────────────────────────────────────────────────────────────────

test('sendText: does nothing when notify.textTo is absent', () => {
  const { calls, restore } = stubExecSync();
  notify.sendText('hello', {});
  restore();
  assert.equal(calls.length, 0);
});

test('sendText: calls osascript when notify.textTo is set', () => {
  // sendText now uses execFileSync (not execSync) - stub both for compatibility
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };
  notify.sendText('hello', { textTo: '+15125550000' }, 'darwin');
  childProcess.execFileSync = origExecFile;
  assert.equal(execFileCalls.length, 1);
  assert.equal(execFileCalls[0].file, 'osascript');
  assert.ok(execFileCalls[0].args.some(a => a.includes('Messages')));
});

test('sendText: escapes backslash and double-quote in message', () => {
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };
  notify.sendText('say \\"hi\\"', { textTo: '+1' }, 'darwin');
  childProcess.execFileSync = origExecFile;
  // Should not throw and should have called osascript
  assert.equal(execFileCalls.length, 1);
});

// ─── macNotify ───────────────────────────────────────────────────────────────

test('macNotify: calls osascript display notification', () => {
  // macNotify now uses execFileSync (not execSync)
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };
  notify.macNotify('Title', 'Body');
  childProcess.execFileSync = origExecFile;
  assert.equal(execFileCalls.length, 1);
  assert.equal(execFileCalls[0].file, 'osascript');
  assert.ok(execFileCalls[0].args.some(a => a.includes('display notification')));
  assert.ok(execFileCalls[0].args.some(a => a.includes('Title')));
});

test('macNotify: swallows execFileSync errors silently', () => {
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw new Error('osascript not found'); };
  // Must not throw
  assert.doesNotThrow(() => notify.macNotify('T', 'M'));
  childProcess.execFileSync = origExecFile;
});

// ─── openInBrowser ───────────────────────────────────────────────────────────

test('openInBrowser: calls open for each URL on darwin', () => {
  const spawnCalls = [];
  const origSpawn = childProcess.spawn;
  childProcess.spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args });
    return { unref: () => {} };
  };
  notify.openInBrowser(['https://a.com', 'https://b.com'], 'darwin');
  childProcess.spawn = origSpawn;
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0].cmd, 'open');
  assert.ok(spawnCalls[0].args.includes('https://a.com'));
  assert.equal(spawnCalls[1].cmd, 'open');
  assert.ok(spawnCalls[1].args.includes('https://b.com'));
});

// ─── _webhookPost ─────────────────────────────────────────────────────────────

test('_webhookPost: POSTs JSON with text field to the webhook URL', async () => {
  const { calls, restore } = stubFetch();
  await notify._webhookPost('https://ntfy.sh/test', 'summary text');
  restore();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/test');
  assert.equal(calls[0].body.text, 'summary text');
});

test('_webhookPost: swallows fetch errors silently', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('network error'); };
  await assert.doesNotReject(() => notify._webhookPost('https://bad.url', 'x'));
  global.fetch = orig;
});

// ─── sendText platform guard ─────────────────────────────────────────────────

test('sendText: returns false on non-Mac without crashing', () => {
  const { calls, restore } = stubExecSync();
  const result = notify.sendText('hello', { textTo: '+1' }, 'linux');
  restore();
  assert.equal(result, false, 'should return false on linux');
  assert.equal(calls.length, 0, 'should not call osascript on linux');
});

test('sendText: returns false on windows without crashing', () => {
  const { calls, restore } = stubExecSync();
  const result = notify.sendText('hello', { textTo: '+1' }, 'win32');
  restore();
  assert.equal(result, false, 'should return false on windows');
  assert.equal(calls.length, 0, 'should not call osascript on windows');
});

// ─── sendWebhook (public API) ─────────────────────────────────────────────────

test('sendWebhook: POSTs JSON with text field to the given URL', async () => {
  const { calls, restore } = stubFetch();
  await notify.sendWebhook('https://hooks.example.com/test', 'my message');
  restore();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.example.com/test');
  assert.equal(calls[0].body.text, 'my message');
});

test('sendWebhook: swallows errors silently and does not throw', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('network error'); };
  await assert.doesNotReject(() => notify.sendWebhook('https://bad.url', 'x'));
  global.fetch = orig;
});

test('sendWebhook: is exported as a top-level function (not just _webhookPost)', () => {
  assert.equal(typeof notify.sendWebhook, 'function');
});

// ─── dispatchNotify ───────────────────────────────────────────────────────────

test('dispatchNotify: on macos with no webhook calls iMessage + macNotify but NOT fetch', async () => {
  // macNotify and sendText now use execFileSync (not execSync)
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };
  const fetchStub = stubFetch();

  const cfg = { notify: { textTo: '+15125550000' } };
  await notify.dispatchNotify('run done', cfg, 'darwin');

  childProcess.execFileSync = origExecFile;
  fetchStub.restore();

  // Should have called osascript at least twice (iMessage + display notification)
  const osCalls = execFileCalls.filter(c => c.file === 'osascript');
  assert.ok(osCalls.length >= 2, `expected at least 2 osascript execFileSync calls on macos, got ${osCalls.length}`);
  // No fetch
  assert.equal(fetchStub.calls.length, 0);
});

test('dispatchNotify: on macos WITH webhook calls iMessage + macNotify AND fetch', async () => {
  const execFileCalls = [];
  const origExecFile = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => { execFileCalls.push({ file, args }); };
  const fetchStub = stubFetch();

  const cfg = { notify: { textTo: '+1', webhook: 'https://ntfy.sh/chan' } };
  await notify.dispatchNotify('done', cfg, 'darwin');

  childProcess.execFileSync = origExecFile;
  fetchStub.restore();

  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.text, 'done');
  const osCalls = execFileCalls.filter(c => c.file === 'osascript');
  assert.ok(osCalls.length >= 1);
});

test('dispatchNotify: on linux with notify-send available calls notify-send', async () => {
  // Make _hasBinary('notify-send') return true by making `which` succeed
  const exec = stubExecSync();
  const fetchStub = stubFetch();

  const cfg = { notify: {} };
  await notify.dispatchNotify('linux summary', cfg, 'linux');

  exec.restore();
  fetchStub.restore();

  // On linux path, we call `which notify-send` then `notify-send ...`
  // (execSync is stubbed to not throw, so _hasBinary returns true)
  const nsCalls = exec.calls.filter(c => c.startsWith('notify-send'));
  assert.equal(nsCalls.length, 1);
  assert.ok(nsCalls[0].includes('linux summary'));
  // No osascript
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
  // No fetch (no webhook)
  assert.equal(fetchStub.calls.length, 0);
});

test('dispatchNotify: on linux WITH webhook calls notify-send AND fetch', async () => {
  const exec = stubExecSync();
  const fetchStub = stubFetch();

  const cfg = { notify: { webhook: 'https://hooks.slack.com/test' } };
  await notify.dispatchNotify('msg', cfg, 'linux');

  exec.restore();
  fetchStub.restore();

  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.text, 'msg');
});

test('dispatchNotify: on windows with webhook only calls fetch, no osascript or notify-send', async () => {
  const exec = stubExecSync();
  const fetchStub = stubFetch();

  const cfg = { notify: { webhook: 'https://example.com/hook' } };
  await notify.dispatchNotify('win msg', cfg, 'win32');

  exec.restore();
  fetchStub.restore();

  assert.equal(fetchStub.calls.length, 1);
  assert.equal(exec.calls.filter(c => c.includes('osascript')).length, 0);
  assert.equal(exec.calls.filter(c => c.startsWith('notify-send')).length, 0);
});

test('dispatchNotify: no webhook and linux with no notify-send available — no crash', async () => {
  // Simulate `which` failing → _hasBinary returns false
  const orig = childProcess.execSync;
  childProcess.execSync = (cmd) => {
    if (cmd.startsWith('which')) throw new Error('not found');
  };
  const fetchStub = stubFetch();

  const cfg = { notify: {} };
  await assert.doesNotReject(() => notify.dispatchNotify('test', cfg, 'linux'));
  childProcess.execSync = orig;
  fetchStub.restore();
});

// ─── sendWebhook rich payload (WP-S10) ───────────────────────────────────────

test('sendWebhook with string: POSTs {text: message} (legacy string compat)', async () => {
  const { calls, restore } = stubFetch();
  await notify.sendWebhook('https://hooks.example.com/test', 'summary text');
  restore();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { text: 'summary text' });
});

test('sendWebhook with object: POSTs payload with text + results passed through', async () => {
  const { calls, restore } = stubFetch();
  const payload = {
    text: 'Run complete: 5 succeeded, 1 failed',
    results: { succeeded: ['Spokeo', 'Intelius'], errors: ['Radaris'] },
  };
  await notify.sendWebhook('https://hooks.example.com/test', payload);
  restore();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, payload.text);
  assert.deepEqual(calls[0].body.results, payload.results);
});

test('sendWebhook with object: adds timestamp if missing', async () => {
  const { calls, restore } = stubFetch();
  const payload = { text: 'done', results: {} };
  await notify.sendWebhook('https://hooks.example.com/test', payload);
  restore();
  assert.ok(calls[0].body.timestamp, 'timestamp should be added');
  assert.ok(new Date(calls[0].body.timestamp).getTime() > 0, 'timestamp should be a valid ISO date string');
});

test('sendWebhook with object: preserves caller-supplied timestamp', async () => {
  const { calls, restore } = stubFetch();
  const ts = '2026-05-19T00:00:00.000Z';
  const payload = { text: 'done', results: {}, timestamp: ts };
  await notify.sendWebhook('https://hooks.example.com/test', payload);
  restore();
  assert.equal(calls[0].body.timestamp, ts, 'caller timestamp should not be overwritten');
});

// ── M6: execFileSync instead of execSync for macNotify and sendText ───────────

function stubExecFileSync() {
  const calls = [];
  const orig = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, opts) => {
    calls.push({ file, args, opts });
  };
  return { calls, restore: () => { childProcess.execFileSync = orig; } };
}

test('M6: macNotify calls execFileSync with osascript (not a shell string)', () => {
  const exec = stubExecFileSync();
  notify.macNotify('Title', 'Body');
  exec.restore();
  assert.equal(exec.calls.length, 1, 'should call execFileSync once');
  assert.equal(exec.calls[0].file, 'osascript', 'first arg should be osascript binary');
  assert.ok(Array.isArray(exec.calls[0].args), 'second arg should be an array (not a shell string)');
});

test('M6: macNotify passes script via args array, not shell string', () => {
  const exec = stubExecFileSync();
  notify.macNotify('Title', 'Body');
  exec.restore();
  // args should be ['-e', '<script>'] - no shell interpolation
  assert.ok(
    exec.calls[0].args.includes('-e'),
    'args should include -e flag'
  );
});

test("M6: macNotify handles message containing single quote without breaking", () => {
  const exec = stubExecFileSync();
  assert.doesNotThrow(() => notify.macNotify("Title", "it's broken"));
  exec.restore();
  assert.equal(exec.calls.length, 1, 'should still call execFileSync');
});

test('M6: macNotify handles message containing both single and double quotes', () => {
  const exec = stubExecFileSync();
  assert.doesNotThrow(() => notify.macNotify('A title', `she said "it's fine"`));
  exec.restore();
  assert.equal(exec.calls.length, 1, 'should still call execFileSync once');
});

test('M6: sendText calls execFileSync with osascript on darwin', () => {
  const exec = stubExecFileSync();
  notify.sendText('hello', { textTo: '+15125550000' }, 'darwin');
  exec.restore();
  assert.equal(exec.calls.length, 1, 'should call execFileSync once');
  assert.equal(exec.calls[0].file, 'osascript', 'first arg should be osascript binary');
  assert.ok(Array.isArray(exec.calls[0].args), 'args must be an array');
});

test("M6: sendText handles message with single quote via execFileSync (no shell injection)", () => {
  const exec = stubExecFileSync();
  assert.doesNotThrow(() => notify.sendText("it's a test", { textTo: '+1' }, 'darwin'));
  exec.restore();
  assert.equal(exec.calls.length, 1, 'should still call execFileSync');
});

test('M6: sendText handles message with double quote via execFileSync', () => {
  const exec = stubExecFileSync();
  assert.doesNotThrow(() => notify.sendText('say "hello"', { textTo: '+1' }, 'darwin'));
  exec.restore();
  assert.equal(exec.calls.length, 1);
});

// ── end M6 ────────────────────────────────────────────────────────────────────
