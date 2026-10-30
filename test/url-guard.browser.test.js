/**
 * test/url-guard.browser.test.js
 *
 * BRK2-12 / codex #3 in a real Chromium: the name Node resolved as public is
 * resolved again, differently, by the browser (DNS rebinding).
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 (like the other *.browser tests). Set
 * AIDR_CHROME_PATH to use an installed Chrome. A 127.0.0.1 server stands in for
 * "the internal service"; a --host-resolver-rules flag makes the browser resolve a
 * made-up name to it while the injected Node lookup says that name is public.
 * Nothing touches a real website.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

const PAGE = `<!doctype html><html lang="en"><head><title>Opt out</title></head><body>
<h1>Opt out of the sale of your information</h1>
<form id="optout" action="/submit" method="post"><input type="email" name="email"><button type="submit">Submit request</button></form>
</body></html>`;

describe('url-guard in a real browser', { skip: !ENABLED }, () => {
  let browser;
  let server;
  let port;
  const hits = [];
  let gr;

  const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'real@home.example', state: 'CA', zip: '90001' };

  before(async () => {
    const { chromium } = require('playwright');
    gr = require('../generic-runner');
    gr._setConfig({ person: PERSON });
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.AIDR_CHROME_PATH || undefined,
      args: ['--host-resolver-rules=MAP *.broker.example.net 127.0.0.1'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    gr._setConfig(null);
  });

  const run = async (page, url, lookup) => gr.processGenericUrl(page, { name: 'Rebind Broker', url, source: 'ca' }, { optOuts: {} }, false, new Set(), { person: PERSON, dnsLookup: lookup });

  test('Chrome connects to 127.0.0.1 although Node saw a public address: blocked before anything is typed', async () => {
    hits.length = 0;
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const result = await run(page, `http://rebind.broker.example.net:${port}/opt-out`, lookup);
    await page.close();
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.match(result.detail, /blocked/i);
    assert.match(result.detail, /127\.0\.0\.1/);
    assert.ok(!hits.some((h) => h.startsWith('POST')), `nothing was posted: ${hits.join(', ')}`);
  });

  test('a navigation whose name now resolves privately is aborted by the route, and never reaches the server', async () => {
    hits.length = 0;
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    // pre-navigation check sees a public address; the route's own check (a moment later) sees a private one
    const answers = [['93.184.216.34'], ['10.9.8.7']];
    let calls = 0;
    const lookup = async () => answers[Math.min(calls++, 1)].map((address) => ({ address, family: 4 }));
    const result = await run(page, `http://flip.broker.example.net:${port}/opt-out`, lookup);
    await page.close();
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.match(result.detail, /blocked/i);
    assert.match(result.detail, /10\.9\.8\.7/);
    assert.deepEqual(hits, [], 'the request was never sent');
  });
});
