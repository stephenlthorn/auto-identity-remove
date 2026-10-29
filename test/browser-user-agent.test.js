/**
 * test/browser-user-agent.test.js
 *
 * R7: headless Chromium announces itself as "HeadlessChrome/<ver>" in its user
 * agent, which is an easy bot-block. When we launch headless and the user has
 * not configured a user agent of their own, lib/browser.js sends the regular
 * Chrome string for the same major version and platform instead.
 *
 * Headed launches are left alone: a headed Chrome already says "Chrome".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildLaunchOptions,
  normalizeUserAgent,
  isHeadlessUserAgent,
  resolveBrowserVersion,
} = require('../lib/browser');

const VERSION = '148.0.7778.96';

describe('normalizeUserAgent', () => {
  test('macOS: the frozen Intel token Chrome itself reports, with a reduced version', () => {
    assert.equal(
      normalizeUserAgent(VERSION, { platform: 'darwin' }),
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    );
  });

  test('Windows and Linux use their own platform tokens', () => {
    assert.equal(
      normalizeUserAgent(VERSION, { platform: 'win32' }),
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    );
    assert.equal(
      normalizeUserAgent(VERSION, { platform: 'linux', arch: 'x64' }),
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    );
  });

  test('Linux on ARM (a Raspberry Pi, an ARM NAS) says aarch64, as Chrome does there', () => {
    assert.match(normalizeUserAgent(VERSION, { platform: 'linux', arch: 'arm64' }), /\(X11; Linux aarch64\)/);
  });

  test('keeps the major version of the browser, whatever form the version arrives in', () => {
    for (const v of ['148.0.7778.96', '148', 148, 'HeadlessChrome/148.0.7778.96', 'Google Chrome 148.0.7778.96']) {
      assert.match(normalizeUserAgent(v, { platform: 'linux', arch: 'x64' }), /Chrome\/148\.0\.0\.0 Safari/, String(v));
    }
    assert.match(normalizeUserAgent('99.1.2.3', { platform: 'linux', arch: 'x64' }), /Chrome\/99\.0\.0\.0/);
  });

  test('never contains "Headless", and returns null when there is no usable version', () => {
    assert.ok(!/headless/i.test(normalizeUserAgent('HeadlessChrome/148.0.7778.96', { platform: 'darwin' })));
    for (const v of [undefined, null, '', 'no digits here', {}]) {
      assert.equal(normalizeUserAgent(v, { platform: 'darwin' }), null, String(v));
    }
  });

  test('an unknown platform falls back to the Linux string rather than a made-up one', () => {
    assert.match(normalizeUserAgent(VERSION, { platform: 'freebsd', arch: 'x64' }), /\(X11; Linux x86_64\)/);
  });
});

describe('isHeadlessUserAgent', () => {
  test('spots the headless token and nothing else', () => {
    assert.equal(isHeadlessUserAgent('Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36'), true);
    assert.equal(isHeadlessUserAgent(normalizeUserAgent(VERSION, { platform: 'darwin' })), false);
    assert.equal(isHeadlessUserAgent(undefined), false);
  });
});

describe('buildLaunchOptions: user agent', () => {
  test('headless without a configured user agent gets the regular Chrome one for the same major', () => {
    const opts = buildLaunchOptions({ headless: true, platform: 'darwin', browserVersion: VERSION });
    assert.equal(opts.userAgent, normalizeUserAgent(VERSION, { platform: 'darwin' }));
    assert.ok(!isHeadlessUserAgent(opts.userAgent));
  });

  test('the platform in the string follows the launch platform and arch', () => {
    const opts = buildLaunchOptions({ headless: true, platform: 'linux', arch: 'arm64', browserVersion: VERSION });
    assert.match(opts.userAgent, /Linux aarch64/);
  });

  test('headless picked up from HEADLESS=1 counts the same as headless: true', () => {
    const opts = buildLaunchOptions({ env: { HEADLESS: '1' }, platform: 'darwin', browserVersion: VERSION });
    assert.equal(opts.headless, true);
    assert.ok(opts.userAgent);
  });

  test('headed launches are untouched: no user agent key at all', () => {
    const opts = buildLaunchOptions({ headless: false, platform: 'darwin', browserVersion: VERSION });
    assert.equal(opts.headless, false);
    assert.ok(!('userAgent' in opts));
  });

  test('a user agent the user configured is used as given, headless or not', () => {
    const custom = 'Mozilla/5.0 (custom) Chrome/1.0.0.0';
    assert.equal(buildLaunchOptions({ headless: true, browserVersion: VERSION, browser: { userAgent: custom } }).userAgent, custom);
    assert.equal(buildLaunchOptions({ headless: false, browser: { userAgent: custom } }).userAgent, custom);
  });

  test('an explicit userAgent option beats browser.userAgent from the config', () => {
    const opts = buildLaunchOptions({ headless: true, userAgent: 'explicit', browser: { userAgent: 'from-config' } });
    assert.equal(opts.userAgent, 'explicit');
  });

  test('a blank configured user agent is the same as none', () => {
    const opts = buildLaunchOptions({ headless: true, platform: 'darwin', browserVersion: VERSION, browser: { userAgent: '  ' } });
    assert.equal(opts.userAgent, normalizeUserAgent(VERSION, { platform: 'darwin' }));
  });

  test('when the browser version cannot be determined nothing is sent: a wrong major is worse than HeadlessChrome', () => {
    const opts = buildLaunchOptions({ headless: true, platform: 'linux', executablePath: path.join(os.tmpdir(), 'aidr-no-such-chrome') });
    assert.ok(!('userAgent' in opts));
  });

  test('every other option is unchanged by the user agent work', () => {
    const opts = buildLaunchOptions({ headless: true, platform: 'linux', browserVersion: VERSION });
    assert.deepEqual(opts.viewport, { width: 1280, height: 900 });
    assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation']);
    assert.ok(opts.args.includes('--disable-dev-shm-usage'));
  });
});

describe('resolveBrowserVersion', () => {
  const fakeChrome = (stdout) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-fake-chrome-'));
    const exe = path.join(dir, 'chrome');
    fs.writeFileSync(exe, `#!/bin/sh\necho "${stdout}"\n`, { mode: 0o755 });
    return exe;
  };

  test('an explicit version wins over everything', () => {
    assert.equal(resolveBrowserVersion({ browserVersion: '150.0.1.2', executablePath: '/nope' }), '150.0.1.2');
  });

  test('an explicit executable is asked for its version, not assumed to be the bundled one', { skip: process.platform === 'win32' }, () => {
    assert.equal(resolveBrowserVersion({ executablePath: fakeChrome('Google Chrome 156.0.8078.48') }), '156.0.8078.48');
    assert.equal(resolveBrowserVersion({ executablePath: fakeChrome('HeadlessChrome 120.0.6099.109') }), '120.0.6099.109');
  });

  test('an executable that will not say (or does not exist) yields null, never the bundled version', () => {
    assert.equal(resolveBrowserVersion({ executablePath: fakeChrome('no version here') }), null);
    assert.equal(resolveBrowserVersion({ executablePath: path.join(os.tmpdir(), 'aidr-no-such-chrome') }), null);
  });

  test('without an executable it is the version of the Chromium this Playwright launches', () => {
    assert.match(resolveBrowserVersion({}), /^\d+\.\d+\.\d+\.\d+$/);
  });

  test('a bundled version that cannot be read yields null', () => {
    assert.equal(resolveBrowserVersion({ bundled: () => { throw new Error('browsers.json missing'); } }), null);
  });
});
