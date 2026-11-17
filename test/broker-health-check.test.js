'use strict';
/**
 * test/broker-health-check.test.js
 *
 * checkBroker against REAL pages: a local http server on 127.0.0.1 serves fixture
 * opt-out pages and a headless Chromium loads them. No real site is touched.
 *
 * Skipped only when this machine has no Chromium at all (CI installs one).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFixtureServer, findChromium } = require('./helpers/health-fixture-server');
const { checkBroker, checkAllBrokers } = require('../lib/broker-health');

const executablePath = findChromium();

describe('checkBroker against fixture pages', { skip: executablePath ? false : 'no Chromium on this machine' }, () => {
  let server;
  let browser;
  let context;

  before(async () => {
    const { chromium } = require('playwright');
    server = await startFixtureServer();
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
  });

  const broker = (route, over = {}) => ({
    name: `Fixture ${route}`,
    method: 'direct-form',
    optOutUrl: `${server.origin}${route}`,
    formFields: { 'input[name="email"]': 'jane.sample@example.com' },
    submitSelector: 'button[type="submit"]',
    searchUrl: `${server.origin}/search/Jane-Sample`,
    ...over,
  });
  const check = async (b, opts = { settleMs: 0 }) => {
    const page = await context.newPage();
    try { return await checkBroker(page, b, opts); } finally { await page.close(); }
  };

  test('a complete page is ok', async () => {
    const r = await check(broker('/ok'));
    assert.equal(r.status, 'ok', r.detail);
  });

  test('a page whose selector was removed is drifted, and the detail names it', async () => {
    const r = await check(broker('/drifted'));
    assert.equal(r.status, 'drifted');
    assert.deepEqual(r.missing, ['input[name="email"]']);
    assert.match(r.detail, /input\[name="email"\]/);
  });

  test('a challenge page is blocked, not drifted', async () => {
    const r = await check(broker('/wall'));
    assert.equal(r.status, 'blocked', r.detail);
    assert.equal(r.missing, undefined);
  });

  test('a 403 page is blocked', async () => {
    assert.equal((await check(broker('/wall-403'))).status, 'blocked');
  });

  test('a 404 is dead', async () => {
    assert.equal((await check(broker('/gone'))).status, 'dead');
  });

  test('a host that does not resolve is dead', async () => {
    const r = await check(broker('/ok', { optOutUrl: 'http://health-check-fixture.invalid/optout' }));
    assert.equal(r.status, 'dead', r.detail);
  });

  test('a refused connection is dead', async () => {
    const dead = await startFixtureServer();
    const origin = dead.origin;
    await dead.close();
    const r = await check(broker('/ok', { optOutUrl: `${origin}/optout` }));
    assert.equal(r.status, 'dead', r.detail);
  });

  test('a 500 is an error, not dead', async () => {
    assert.equal((await check(broker('/broken'))).status, 'error');
  });

  test('a page that never answers times out as an error, not dead', async () => {
    const r = await check(broker('/hang'), { timeoutMs: 600, settleMs: 0 });
    assert.equal(r.status, 'error', r.detail);
  });

  test('a complete form with a CAPTCHA widget on it is still ok', async () => {
    const r = await check(broker('/captcha-form', { captchaLikely: true }));
    assert.equal(r.status, 'ok', r.detail);
  });

  test('a form that a script draws a moment after load is found, not drifted', async () => {
    const r = await check(broker('/late-form'), { settleMs: 3000 });
    assert.equal(r.status, 'ok', r.detail);
  });

  test('a manual broker only has to answer', async () => {
    const r = await check(broker('/ok', { method: 'manual', formFields: undefined, submitSelector: undefined }));
    assert.equal(r.status, 'ok');
    assert.equal((await check(broker('/gone', { method: 'manual' }))).status, 'dead');
  });

  test('an email broker is not checked and never opens a page', async () => {
    let opened = 0;
    const [entry] = await checkAllBrokers({
      brokers: [{ name: 'Mail One', method: 'email', emailTo: 'privacy@example.com' }],
      newPage: async () => { opened += 1; return context.newPage(); },
    });
    assert.equal(entry.status, 'n/a');
    assert.equal(opened, 0);
  });

  test('nothing is typed or submitted: only GET requests for the opt-out page reach the server', async () => {
    const before = server.requests.length;
    const entries = await checkAllBrokers({
      brokers: [broker('/ok'), broker('/drifted'), broker('/captcha-form'), broker('/late-form')],
      newPage: () => context.newPage(),
      checkOpts: { settleMs: 0 },
    });
    assert.equal(entries.length, 4);
    const seen = server.requests.slice(before);
    assert.ok(seen.length >= 4);
    assert.deepEqual([...new Set(seen.map((r) => r.method))], ['GET']);
    assert.equal(seen.some((r) => /^\/(search|submit)/.test(r.path)), false, 'no search URL and no form post');
  });
});
