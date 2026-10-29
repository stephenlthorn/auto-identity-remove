/**
 * test/browser-headless-ua.test.js
 *
 * Real-browser checks for R7: launch headless Chromium the way watcher.js will
 * (lib/browser.js options, lib/stealth.js init script, a per-person profile) and look at
 * what a page and a server actually see. Every page is a local fixture: setContent, or a
 * server on 127.0.0.1. The proxy check points the browser at a fake proxy on 127.0.0.1 and
 * asks for a made-up .test host, so nothing leaves this machine.
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 is set, like the other *.browser.test.js files:
 *
 *   AIDR_BROWSER_TESTS=1 AIDR_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     node --test test/browser-headless-ua.test.js
 *
 * Without AIDR_CHROME_PATH it uses the Chromium Playwright downloaded.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);
const EXECUTABLE = process.env.AIDR_CHROME_PATH || undefined;

describe('headless launch through lib/browser.js, in a real browser', { skip: !ENABLED }, () => {
  let chromium;
  let lib;
  let stealth;
  let server;
  let base;
  let seenRequests;
  const dirs = [];

  const JANE = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', zip: '73301', phone: '5125550000' };
  const JOHN = { firstName: 'John', lastName: 'Roe', email: 'john@example.com', zip: '10001', phone: '2125550000' };

  before(async () => {
    ({ chromium } = require('playwright'));
    lib = require('../lib/browser');
    stealth = require('../lib/stealth');
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-r7-'));
    dirs.push(base);
    seenRequests = [];
    server = http.createServer((req, res) => {
      seenRequests.push({ url: req.url, headers: req.headers });
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/set-cookie') res.setHeader('Set-Cookie', 'aidr_probe=person-a; Max-Age=3600; Path=/');
      res.end('<!doctype html><html><body>ok</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const origin = () => `http://127.0.0.1:${server.address().port}`;

  async function withContext(profileDir, launchOptions, fn) {
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    try {
      await context.addInitScript(stealth.buildStealthScript());
      return await fn(context);
    } finally {
      await context.close();
    }
  }

  const headlessOptions = (extra = {}) => lib.buildLaunchOptions({ headless: true, executablePath: EXECUTABLE, ...extra });
  const freshDir = () => { const d = fs.mkdtempSync(path.join(base, 'p-')); return d; };

  test('navigator.userAgent has no "Headless" on a setContent page', async () => {
    await withContext(freshDir(), headlessOptions(), async (context) => {
      const page = await context.newPage();
      await page.setContent('<!doctype html><html><body>fixture</body></html>');
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.ok(!/headless/i.test(ua), ua);
      assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    });
  });

  test('the user agent equals what this same browser reports headless, minus the word Headless', async () => {
    const plain = await chromium.launchPersistentContext(freshDir(), {
      headless: true, executablePath: EXECUTABLE, args: ['--no-first-run'], ignoreDefaultArgs: ['--enable-automation'],
    });
    let nativeUa;
    try {
      const page = await plain.newPage();
      nativeUa = await page.evaluate(() => navigator.userAgent);
    } finally {
      await plain.close();
    }
    assert.match(nativeUa, /HeadlessChrome/, 'sanity: an unconfigured headless launch does announce itself');

    await withContext(freshDir(), headlessOptions(), async (context) => {
      const page = await context.newPage();
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.equal(ua, nativeUa.replace('HeadlessChrome', 'Chrome'), 'same major, same platform token as the real browser');
    });
  });

  test('script, request header and client hints all agree and none says Headless', async () => {
    seenRequests.length = 0;
    await withContext(freshDir(), headlessOptions(), async (context) => {
      const page = await context.newPage();
      await page.goto(`${origin()}/agree`);
      const seen = await page.evaluate(async () => ({
        ua: navigator.userAgent,
        appVersion: navigator.appVersion,
        brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
        high: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList']) : null,
      }));
      const request = seenRequests.find((r) => r.url === '/agree');
      assert.equal(request.headers['user-agent'], seen.ua, 'the header and navigator.userAgent are the same string');
      assert.ok(!/headless/i.test(seen.appVersion));
      assert.ok(!/headless/i.test(JSON.stringify(seen.brands)));
      assert.ok(!/headless/i.test(JSON.stringify(seen.high)));
      if (request.headers['sec-ch-ua']) assert.ok(!/headless/i.test(request.headers['sec-ch-ua']), request.headers['sec-ch-ua']);
      const major = /Chrome\/(\d+)\./.exec(seen.ua)[1];
      assert.ok(seen.brands.some((b) => b.version === major), 'a brand carries the same major version as the user agent');
    });
  });

  test('a configured user agent is used as given', async () => {
    const custom = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.0.0 Safari/537.36';
    await withContext(freshDir(), headlessOptions({ browser: { userAgent: custom } }), async (context) => {
      const page = await context.newPage();
      await page.goto(`${origin()}/custom`);
      assert.equal(await page.evaluate(() => navigator.userAgent), custom);
    });
  });

  test('stealth still scrubs the page-visible user agent when a launch could not (forced HeadlessChrome string)', async () => {
    const forced = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36';
    await withContext(freshDir(), headlessOptions({ userAgent: forced }), async (context) => {
      const page = await context.newPage();
      await page.goto(`${origin()}/forced`);
      const seen = await page.evaluate(() => ({ ua: navigator.userAgent, appVersion: navigator.appVersion }));
      assert.ok(!/headless/i.test(seen.ua), seen.ua);
      assert.ok(!/headless/i.test(seen.appVersion), seen.appVersion);
    });
  });

  test('two people never share cookies; the same person keeps theirs between launches', async () => {
    const provider = lib.createPersonContexts({
      chromium,
      baseDir: base,
      persons: [JANE, JOHN],
      launchOptions: () => headlessOptions(),
      prepare: (context) => context.addInitScript(stealth.buildStealthScript()),
    });
    try {
      const a = await provider.forPerson(0);
      const pageA = await a.newPage();
      await pageA.goto(`${origin()}/set-cookie`);
      assert.match(await pageA.evaluate(() => document.cookie), /aidr_probe=person-a/);

      const b = await provider.forPerson(1);
      assert.notEqual(a, b);
      const pageB = await b.newPage();
      await pageB.goto(`${origin()}/read`);
      assert.equal(await pageB.evaluate(() => document.cookie), '', 'person B must not see the cookie a broker set for person A');

      const aAgain = await provider.forPerson(0);
      const pageA2 = await aAgain.newPage();
      await pageA2.goto(`${origin()}/read`);
      assert.match(await pageA2.evaluate(() => document.cookie), /aidr_probe=person-a/, 'person A is still logged in on the next run');
    } finally {
      await provider.close();
    }
  });

  test('browser.proxy reaches the browser: traffic goes through the proxy and its credentials are accepted', async () => {
    const proxyHits = [];
    const proxy = http.createServer((req, res) => {
      if (!req.headers['proxy-authorization']) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="aidr-test"', 'Content-Length': '0' });
        res.end();
        return;
      }
      proxyHits.push({ url: req.url, auth: req.headers['proxy-authorization'] });
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body>via-proxy</body></html>');
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const browser = { proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'alice', password: 's3cret-pass' } };
      await withContext(freshDir(), headlessOptions({ browser }), async (context) => {
        const page = await context.newPage();
        await page.goto('http://aidr-proxy-check.test/page');
        assert.equal(await page.textContent('body'), 'via-proxy');
      });
      assert.equal(proxyHits.length > 0, true, 'the request reached the proxy');
      assert.equal(proxyHits[0].url, 'http://aidr-proxy-check.test/page');
      assert.equal(proxyHits[0].auth, `Basic ${Buffer.from('alice:s3cret-pass').toString('base64')}`);
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
