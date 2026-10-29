/**
 * test/notify-headless.test.js
 *
 * CORE-11: openInBrowser spawned `xdg-open` / `open` with no 'error' listener
 * and no headless check. On a Docker/NAS host (Linux, no display, usually no
 * xdg-open) the end-of-run "open the manual sites" step emitted an unhandled
 * 'error' event (ENOENT) and crashed the process with exit 1 AFTER state was
 * saved, turning a successful run into a failed one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const childProcess = require('node:child_process');
const path = require('node:path');

const notify = require('../lib/notify');

const NOTIFY_MODULE = path.resolve(__dirname, '..', 'lib', 'notify.js');

function stubSpawn(factory = () => ({ unref() {} })) {
  const calls = [];
  const original = childProcess.spawn;
  childProcess.spawn = (cmd, args, opts) => {
    calls.push({ cmd, args: args || [], opts });
    return factory(cmd, args, opts);
  };
  return { calls, restore: () => { childProcess.spawn = original; } };
}

// ─── canOpenBrowser ──────────────────────────────────────────────────────────

test('canOpenBrowser: Linux without DISPLAY or WAYLAND_DISPLAY has nowhere to open a browser', () => {
  assert.equal(notify.canOpenBrowser({}, 'linux'), false);
  assert.equal(notify.canOpenBrowser({ DISPLAY: '' }, 'linux'), false);
  assert.equal(notify.canOpenBrowser({ DISPLAY: '', WAYLAND_DISPLAY: '' }, 'linux'), false);
});

test('canOpenBrowser: Linux with DISPLAY or WAYLAND_DISPLAY can', () => {
  assert.equal(notify.canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(notify.canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
});

test('canOpenBrowser: macOS and Windows do not depend on DISPLAY', () => {
  assert.equal(notify.canOpenBrowser({}, 'darwin'), true);
  assert.equal(notify.canOpenBrowser({}, 'win32'), true);
});

test('canOpenBrowser: defaults to the real environment and platform', () => {
  assert.equal(typeof notify.canOpenBrowser(), 'boolean');
});

// ─── openInBrowser: headless gate ────────────────────────────────────────────

test('openInBrowser: headless Linux returns false and spawns nothing', () => {
  const { calls, restore } = stubSpawn();
  try {
    const result = notify.openInBrowser(['https://a.example', 'https://b.example'], 'linux', {});
    assert.equal(result, false);
    assert.equal(calls.length, 0, 'must not spawn xdg-open without a display');
  } finally { restore(); }
});

test('openInBrowser: Linux with a display spawns xdg-open per URL and returns true', () => {
  const { calls, restore } = stubSpawn();
  try {
    const result = notify.openInBrowser(['https://a.example', 'https://b.example'], 'linux', { DISPLAY: ':0' });
    assert.equal(result, true);
    assert.deepEqual(calls.map(c => c.cmd), ['xdg-open', 'xdg-open']);
  } finally { restore(); }
});

test('openInBrowser: macOS does not need a display', () => {
  const { calls, restore } = stubSpawn();
  try {
    assert.equal(notify.openInBrowser(['https://a.example'], 'darwin', {}), true);
    assert.equal(calls[0].cmd, 'open');
  } finally { restore(); }
});

test('openInBrowser: an empty URL list opens nothing and reports false', () => {
  const { calls, restore } = stubSpawn();
  try {
    assert.equal(notify.openInBrowser([], 'darwin', {}), false);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// ─── openInBrowser: spawn failure ────────────────────────────────────────────

test('openInBrowser: an async spawn error (ENOENT) is swallowed instead of becoming an unhandled event', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const { restore } = stubSpawn(() => child);
  try {
    notify.openInBrowser(['https://a.example'], 'darwin', {});
    assert.ok(child.listenerCount('error') >= 1, 'an error listener must be attached');
    assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })));
  } finally { restore(); }
});

test('openInBrowser: a spawn that throws synchronously is swallowed', () => {
  const original = childProcess.spawn;
  childProcess.spawn = () => { throw new Error('spawn failed'); };
  try {
    assert.doesNotThrow(() => notify.openInBrowser(['https://a.example'], 'darwin', {}));
  } finally { childProcess.spawn = original; }
});

test('a real process whose xdg-open is missing still exits 0', () => {
  const script = `
    const notify = require(${JSON.stringify(NOTIFY_MODULE)});
    notify.openInBrowser(['https://example.invalid/optout'], 'linux', { DISPLAY: ':0' });
    setTimeout(() => process.exit(0), 300);
  `;
  const r = childProcess.spawnSync(process.execPath, ['-e', script], {
    env: { PATH: '/nonexistent-aidr-path' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
});

test('a real headless Linux run never even tries to spawn', () => {
  const script = `
    const cp = require('child_process');
    let spawned = 0;
    const real = cp.spawn;
    cp.spawn = (...a) => { spawned++; return real(...a); };
    const notify = require(${JSON.stringify(NOTIFY_MODULE)});
    const opened = notify.openInBrowser(['https://example.invalid/optout'], 'linux', {});
    process.stdout.write(JSON.stringify({ opened, spawned }));
  `;
  const r = childProcess.spawnSync(process.execPath, ['-e', script], { env: { PATH: '/nonexistent-aidr-path' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { opened: false, spawned: 0 });
});
