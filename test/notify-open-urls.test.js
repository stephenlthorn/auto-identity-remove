/**
 * test/notify-open-urls.test.js
 *
 * CLI2-6: the Windows opener ran `cmd /c start "" <url>`. cmd.exe reads `&` in that
 * URL as a command separator, and the URLs it is handed are not all ours: the
 * generic brokers' opt-out URLs come from registry CSVs (lib/feeds.js passes them
 * on verbatim), so a row whose URL contains `&calc` ran calc. The opener is now
 * `rundll32 url.dll,FileProtocolHandler <url>` as spawn arguments (no shell, so
 * nothing is a separator), and only http(s) URLs are opened on any platform.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const notify = require('../lib/notify');

function stubSpawn() {
  const calls = [];
  const original = childProcess.spawn;
  childProcess.spawn = (cmd, args, options) => {
    calls.push({ cmd, args: args || [], options });
    return { unref() {}, on() {} };
  };
  return { calls, restore: () => { childProcess.spawn = original; } };
}

const HOSTILE = 'https://a.example/?x=1&calc';

test('win32: the opener is rundll32 url.dll,FileProtocolHandler, never cmd', () => {
  const { calls, restore } = stubSpawn();
  try {
    assert.equal(notify.openInBrowser([HOSTILE], 'win32'), true);
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'rundll32');
  assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', HOSTILE], 'the URL is one argument, untouched');
  assert.equal(calls.some(c => /cmd/i.test(c.cmd)), false, 'no cmd.exe anywhere');
});

test('win32: no spawn goes through a shell', () => {
  const { calls, restore } = stubSpawn();
  try {
    notify.openInBrowser([HOSTILE, 'https://b.example/a&b|c^d%PATH%'], 'win32');
  } finally {
    restore();
  }
  for (const call of calls) {
    assert.ok(!(call.options && call.options.shell), `${call.cmd} must not run with shell: true`);
    assert.ok(!call.args.includes('/c'), 'no cmd /c');
  }
});

test('only http(s) URLs are opened, on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { calls, restore } = stubSpawn();
    let opened;
    try {
      opened = notify.openInBrowser(
        ['file:///etc/passwd', 'javascript:alert(1)', 'calc.exe', 'ftp://x.example/', 'data:text/html,<b>x</b>', 'https://ok.example/path'],
        platform,
        { DISPLAY: ':0' },
      );
    } finally {
      restore();
    }
    assert.equal(opened, true, platform);
    assert.equal(calls.length, 1, `${platform}: only the https URL was opened`);
    assert.ok(calls[0].args.includes('https://ok.example/path'), platform);
  }
});

test('a list with nothing openable opens nothing and says so', () => {
  const { calls, restore } = stubSpawn();
  let opened;
  try {
    opened = notify.openInBrowser(['file:///x', 'not a url', '', null, undefined], 'win32');
  } finally {
    restore();
  }
  assert.equal(opened, false);
  assert.deepEqual(calls, []);
});

test('a URL with whitespace or a quote in it is not handed to the opener', () => {
  const { calls, restore } = stubSpawn();
  try {
    notify.openInBrowser(['https://a.example/ x', 'https://a.example/"y', 'https://a.example/\nz'], 'win32');
  } finally {
    restore();
  }
  assert.deepEqual(calls, []);
});

test('darwin and linux still get the URL as the single argument to open / xdg-open', () => {
  for (const [platform, cmd] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
    const { calls, restore } = stubSpawn();
    try {
      notify.openInBrowser([HOSTILE], platform, { DISPLAY: ':0' });
    } finally {
      restore();
    }
    assert.equal(calls[0].cmd, cmd);
    assert.deepEqual(calls[0].args, [HOSTILE]);
  }
});
