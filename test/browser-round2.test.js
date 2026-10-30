/**
 * test/browser-round2.test.js
 *
 * BRK2-10   the pre-change shared profile (it holds every person's old cookies) is
 *           adopted by persons[0] only on a single-person install
 * BRK2-11   a throwaway context per confirmation click (own profile directory, init
 *           script applied, removed afterwards)
 * extras    a configured proxy also gets the WebRTC leak guard; the proxy password is
 *           scrubbed from an error's stack as well as its message
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const browser = require('../lib/browser');

const JANE = { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com', zip: '73301', phone: '5125550000' };
const JOHN = { firstName: 'John', lastName: 'Roe', email: 'john.roe@example.com', zip: '10001', phone: '2125550000' };

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-r2-browser-'));
const seedLegacyProfile = (base) => {
  fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Local State'), '{}');
};

// ── BRK2-10 ───────────────────────────────────────────────────────────────────

test('BRK2-10: on a multi-person install the old shared profile is not adopted by anyone', () => {
  const base = tmpBase();
  seedLegacyProfile(base);
  const dir = browser.profileDirFor({ baseDir: base, person: JANE, personIndex: 0, personCount: 2 });
  assert.notEqual(dir, base, 'it holds both persons\' old cookies');
  assert.match(path.basename(dir), /^person-0-/);
  assert.equal(fs.existsSync(path.join(base, '.aidr-profile-owner')), false, 'and no owner marker is stamped');
});

test('BRK2-10: a single-person install still keeps its logins', () => {
  const base = tmpBase();
  seedLegacyProfile(base);
  assert.equal(browser.profileDirFor({ baseDir: base, person: JANE, personIndex: 0, personCount: 1 }), base);
  assert.equal(browser.profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), base, 'no personCount keeps the old behaviour');
});

test('BRK2-10: createPersonContexts tells profileDirFor how many persons there are', async () => {
  const base = tmpBase();
  seedLegacyProfile(base);
  const launched = [];
  const chromium = { launchPersistentContext: async (dir) => { launched.push(dir); return { close: async () => {}, on() {} }; } };
  const contexts = browser.createPersonContexts({ chromium, baseDir: base, persons: [JANE, JOHN], launchOptions: () => ({}) });
  await contexts.forPerson(0);
  assert.notEqual(launched[0], base);
  await contexts.close();

  const soloBase = tmpBase();
  seedLegacyProfile(soloBase);
  const solo = browser.createPersonContexts({ chromium, baseDir: soloBase, persons: [JANE], launchOptions: () => ({}) });
  await solo.forPerson(0);
  assert.equal(launched[1], soloBase);
  await solo.close();
});

// ── BRK2-11 ───────────────────────────────────────────────────────────────────

test('BRK2-11: every open() is a new profile directory, prepared, and removed on close', async () => {
  const base = tmpBase();
  const launches = [];
  const prepared = [];
  const chromium = {
    launchPersistentContext: async (dir, options) => {
      launches.push({ dir, options });
      return { closed: false, close: async function close() { this.closed = true; } };
    },
  };
  const opener = browser.createThrowawayContexts({
    chromium,
    baseDir: base,
    launchOptions: () => ({ headless: true }),
    prepare: async (context) => { prepared.push(context); },
  });

  const a = await opener.open();
  const b = await opener.open();
  assert.notEqual(launches[0].dir, launches[1].dir, 'no profile is shared between two clicks');
  assert.ok(launches[0].dir.startsWith(base));
  assert.equal(fs.existsSync(launches[0].dir), true);
  assert.equal(prepared.length, 2, 'the init script is applied to each');
  if (process.platform !== 'win32') assert.equal(fs.statSync(launches[0].dir).mode & 0o777, 0o700);

  await a.close();
  assert.equal(a.context.closed, true);
  assert.equal(fs.existsSync(launches[0].dir), false, 'the profile does not outlive the click');
  assert.equal(fs.existsSync(launches[1].dir), true);
  await b.close();
  assert.equal(fs.existsSync(launches[1].dir), false);
});

test('BRK2-11: a context that cannot be launched leaves no directory behind and its proxy password out of the message', async () => {
  const base = tmpBase();
  const chromium = { launchPersistentContext: async () => { throw new Error('connect to http://user:S3cretPw@proxy.example:8080 failed'); } };
  const opener = browser.createThrowawayContexts({
    chromium, baseDir: base, launchOptions: () => ({ proxy: { server: 'http://proxy.example:8080', username: 'user', password: 'S3cretPw' } }),
  });
  await assert.rejects(opener.open(), (err) => {
    assert.ok(!err.message.includes('S3cretPw'), err.message);
    assert.ok(!String(err.stack).includes('S3cretPw'), 'stack too');
    return true;
  });
  const clicks = path.join(base, 'utility', 'clicks');
  assert.deepEqual(fs.existsSync(clicks) ? fs.readdirSync(clicks) : [], []);
});

// ── extras ────────────────────────────────────────────────────────────────────

test('WebRTC: a configured proxy comes with the flag that keeps UDP from going around it', () => {
  const withProxy = browser.buildLaunchOptions({ headless: true, platform: 'linux', env: {}, browser: { proxy: { server: 'http://proxy.example:8080' } }, userAgent: 'x' });
  assert.ok(withProxy.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'), withProxy.args.join(' '));
  const without = browser.buildLaunchOptions({ headless: true, platform: 'linux', env: {}, userAgent: 'x' });
  assert.ok(!without.args.some((a) => a.startsWith('--force-webrtc-ip-handling-policy')));
});

test('the proxy password is scrubbed from the stack of a launch error, not only its message', async () => {
  const base = tmpBase();
  const chromium = {
    launchPersistentContext: async () => {
      const err = new Error('proxy refused S3cretPw');
      err.stack = `Error: proxy refused S3cretPw\n    at launch (http://user:S3cretPw@proxy.example/x)`;
      throw err;
    },
  };
  const contexts = browser.createPersonContexts({
    chromium, baseDir: base, persons: [JANE],
    launchOptions: () => ({ proxy: { server: 'http://proxy.example:8080', username: 'user', password: 'S3cretPw' } }),
  });
  await assert.rejects(contexts.forPerson(0), (err) => {
    assert.ok(!err.message.includes('S3cretPw'));
    assert.ok(!String(err.stack).includes('S3cretPw'), err.stack);
    return true;
  });
});

test('BRK2-11: close() shuts every context still open and removes its profile, even one still being prepared', async () => {
  const base = tmpBase();
  const launches = [];
  const chromium = {
    launchPersistentContext: async (dir) => {
      const context = { dir, closed: false, close: async function close() { this.closed = true; } };
      launches.push(context);
      return context;
    },
  };
  let releasePrepare;
  const opener = browser.createThrowawayContexts({
    chromium,
    baseDir: base,
    launchOptions: () => ({}),
    prepare: () => new Promise((resolve) => { releasePrepare = resolve; }),
  });

  const opening = opener.open().catch(() => {});
  while (!releasePrepare) await new Promise((resolve) => setImmediate(resolve)); // prepare is running: launched, not yet handed out
  await opener.close();
  assert.equal(launches[0].closed, true, 'a shutdown that lands mid-prepare closes the browser');
  assert.equal(fs.existsSync(launches[0].dir), false, 'and removes its profile');
  releasePrepare();
  await opening;

  const finished = await (async () => {
    const quick = browser.createThrowawayContexts({ chromium, baseDir: base, launchOptions: () => ({}) });
    const handle = await quick.open();
    await handle.close();
    await quick.close();
    return handle.context.closed;
  })();
  assert.equal(finished, true, 'close() after an ordinary open/close is a no-op, not an error');
});
