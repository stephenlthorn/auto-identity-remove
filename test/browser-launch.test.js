/**
 * test/browser-launch.test.js
 *
 * watcher.js launches Chromium from four separate places (main run, complaint
 * PDF rendering, --confirm-emails, report rendering). Three of them passed no
 * args at all, so container-hardening and anti-automation flags applied only to
 * the main run. lib/browser.js centralises the options so every launch site
 * gets the same treatment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildLaunchArgs, buildLaunchOptions, resolveHeadless } = require('../lib/browser');

test('buildLaunchArgs always includes the anti-automation flags', () => {
  const args = buildLaunchArgs({ platform: 'darwin' });
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
});

test('buildLaunchArgs adds container-safe flags on linux', () => {
  const args = buildLaunchArgs({ platform: 'linux' });
  // /dev/shm defaults to 64MB inside Docker; Chromium renderers die once they
  // fill it. --disable-dev-shm-usage moves shared memory to /tmp.
  assert.ok(args.includes('--disable-dev-shm-usage'), 'linux launches must not depend on a large /dev/shm');
});

test('buildLaunchArgs omits the linux-only flag on macOS', () => {
  // macOS has no /dev/shm limit to work around, and the flag costs performance.
  assert.ok(!buildLaunchArgs({ platform: 'darwin' }).includes('--disable-dev-shm-usage'));
});

test('buildLaunchArgs adds a low-memory profile when asked', () => {
  const lean = buildLaunchArgs({ platform: 'linux', lowMemory: true });
  assert.ok(lean.includes('--disable-dev-shm-usage'));
  assert.ok(lean.includes('--single-process') === false, '--single-process breaks Playwright; must not be used');
  for (const flag of ['--disable-gpu', '--disable-extensions', '--no-zygote']) {
    assert.ok(lean.includes(flag), `low-memory profile should include ${flag}`);
  }
});

test('buildLaunchArgs returns a fresh array each call', () => {
  const a = buildLaunchArgs({ platform: 'linux' });
  a.push('--mutated');
  assert.ok(!buildLaunchArgs({ platform: 'linux' }).includes('--mutated'));
});

test('buildLaunchOptions carries viewport, args and ignoreDefaultArgs', () => {
  const opts = buildLaunchOptions({ platform: 'linux', headless: true });
  assert.equal(opts.headless, true);
  assert.deepEqual(opts.viewport, { width: 1280, height: 900 });
  assert.ok(opts.args.includes('--disable-dev-shm-usage'));
  assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation']);
});

test('resolveHeadless honours an explicit HEADLESS env value', () => {
  for (const v of ['1', 'true', 'TRUE']) {
    assert.equal(resolveHeadless({ HEADLESS: v }, 'darwin'), true, `HEADLESS=${v} should force headless`);
  }
  for (const v of ['0', 'false', 'FALSE']) {
    assert.equal(resolveHeadless({ HEADLESS: v }, 'linux'), false, `HEADLESS=${v} should force headed`);
  }
});

test('resolveHeadless auto-detects headless for a linux box with no DISPLAY', () => {
  assert.equal(resolveHeadless({}, 'linux'), true);
  assert.equal(resolveHeadless({ DISPLAY: ':0' }, 'linux'), false);
  assert.equal(resolveHeadless({}, 'darwin'), false);
});

test('every chromium launch site in watcher.js goes through lib/browser', () => {
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');

  // R7: the main run no longer launches a context itself. createPersonContexts hands
  // out one context per person, each on its own profile directory, and builds the
  // launch options per launch. What is left in watcher.js are the three one-shot
  // modes (complaint PDFs, --confirm-emails, report rendering), which launch on the
  // utility profile, a directory that belongs to no person.
  const launches = watcher.match(/launchPersistentContext\(/g) || [];
  assert.equal(launches.length, 3, `expected 3 direct launch sites, found ${launches.length}`);
  assert.equal((watcher.match(/createPersonContexts\(/g) || []).length, 1, 'the main run goes through createPersonContexts');

  const optionCalls = watcher.match(/buildLaunchOptions\(/g) || [];
  assert.equal(
    optionCalls.length,
    launches.length + 1,
    `every direct launch, and the per-person launchOptions, must build their options via buildLaunchOptions(); `
    + `found ${optionCalls.length}. A launch site with hand-rolled options silently loses the container flags.`,
  );

  const utility = watcher.match(/launchPersistentContext\(utilityProfileDir\(/g) || [];
  assert.equal(utility.length, launches.length, 'a one-shot launch must use the utility profile, never a person\'s directory');
});
