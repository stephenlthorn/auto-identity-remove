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
  const { calls, restore } = stubExecSync();
  notify.sendText('hello', { textTo: '+15125550000' });
  restore();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('osascript'));
  assert.ok(calls[0].includes('Messages'));
});

test('sendText: escapes backslash and double-quote in message', () => {
  const { calls, restore } = stubExecSync();
  notify.sendText('say \\"hi\\"', { textTo: '+1' });
  restore();
  // Should not throw and should have called osascript
  assert.equal(calls.length, 1);
});

// ─── macNotify ───────────────────────────────────────────────────────────────

test('macNotify: calls osascript display notification', () => {
  const { calls, restore } = stubExecSync();
  notify.macNotify('Title', 'Body');
  restore();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('display notification'));
  assert.ok(calls[0].includes('Title'));
});

test('macNotify: swallows execSync errors silently', () => {
  const orig = childProcess.execSync;
  childProcess.execSync = () => { throw new Error('osascript not found'); };
  // Must not throw
  assert.doesNotThrow(() => notify.macNotify('T', 'M'));
  childProcess.execSync = orig;
});

// ─── openInBrowser ───────────────────────────────────────────────────────────

test('openInBrowser: calls open for each URL', () => {
  const { calls, restore } = stubExecSync();
  notify.openInBrowser(['https://a.com', 'https://b.com']);
  restore();
  const openCalls = calls.filter(c => c.startsWith('open '));
  assert.equal(openCalls.length, 2);
  assert.ok(openCalls[0].includes('a.com'));
  assert.ok(openCalls[1].includes('b.com'));
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
  const exec = stubExecSync();
  const fetchStub = stubFetch();

  const cfg = { notify: { textTo: '+15125550000' } };
  await notify.dispatchNotify('run done', cfg, 'darwin');

  exec.restore();
  fetchStub.restore();

  // Should have called osascript (iMessage) and osascript (display notification)
  const osCalls = exec.calls.filter(c => c.includes('osascript'));
  assert.ok(osCalls.length >= 2, 'expected at least 2 osascript calls on macos');
  // No fetch
  assert.equal(fetchStub.calls.length, 0);
});

test('dispatchNotify: on macos WITH webhook calls iMessage + macNotify AND fetch', async () => {
  const exec = stubExecSync();
  const fetchStub = stubFetch();

  const cfg = { notify: { textTo: '+1', webhook: 'https://ntfy.sh/chan' } };
  await notify.dispatchNotify('done', cfg, 'darwin');

  exec.restore();
  fetchStub.restore();

  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.text, 'done');
  const osCalls = exec.calls.filter(c => c.includes('osascript'));
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
