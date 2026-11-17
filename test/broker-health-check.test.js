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
const { startFixtureServer, findChromium, EVENT_TYPES } = require('./helpers/health-fixture-server');
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

  test('a real form with 2 of 4 fields renamed and its usual CAPTCHA widget is drifted, not blocked (H1)', async () => {
    const r = await check(broker('/captcha-drifted', {
      captchaLikely: true,
      formFields: {
        'input[name="first"]': 'Jane', 'input[name="last"]': 'Sample',
        'input[name="email"]': 'jane.sample@example.com', 'input[name="zip"]': '90001',
      },
    }));
    assert.equal(r.status, 'drifted', r.detail);
    assert.deepEqual(r.missing.sort(), ['input[name="email"]', 'input[name="zip"]']);
  });

  test('a form that a script draws a moment after load is found, not drifted', async () => {
    const r = await check(broker('/late-form'), { settleMs: 3000 });
    assert.equal(r.status, 'ok', r.detail);
  });

  test('a Playwright-only selector (:has-text) is evaluated by Playwright, not reported as drift', async () => {
    const present = await check(broker('/ok', { submitSelector: 'button[type="submit"]:has-text("Remove")' }));
    assert.equal(present.status, 'ok', present.detail);
    const absent = await check(broker('/ok', { submitSelector: 'button[type="submit"]:has-text("Nonexistent")' }));
    assert.equal(absent.status, 'drifted');
    assert.deepEqual(absent.missing, ['button[type="submit"]:has-text("Nonexistent")']);
  });

  describe('a selector counts only when it matches a VISIBLE element (H5)', () => {
    for (const kind of ['display', 'visibility', 'offscreen', 'aria', 'tiny', 'tabindex', 'parent']) {
      test(`an email field that is hidden by ${kind} is missing, so the form is drifted`, async () => {
        const r = await check(broker(`/hidden/${kind}`));
        assert.equal(r.status, 'drifted', r.detail);
        assert.deepEqual(r.missing, ['input[name="email"]']);
      });
    }

    test('a hidden submit button is missing too', async () => {
      const r = await check(broker('/hidden/submit'));
      assert.equal(r.status, 'drifted', r.detail);
      assert.deepEqual(r.missing, ['button[type="submit"]']);
    });

    test('a submit button that keeps its box but is visibility:hidden is missing too', async () => {
      const r = await check(broker('/hidden/submit-visibility'));
      assert.equal(r.status, 'drifted', r.detail);
      assert.deepEqual(r.missing, ['button[type="submit"]']);
    });

    test('a hidden submit button is missing when the selector is a Playwright one', async () => {
      const r = await check(broker('/hidden/submit', { submitSelector: 'button[type="submit"]:has-text("Remove")' }));
      assert.equal(r.status, 'drifted', r.detail);
    });

    test('a hidden duplicate does not hide a visible field with the same selector', async () => {
      const r = await check(broker('/hidden/duplicate-first'));
      assert.equal(r.status, 'ok', r.detail);
    });

    test('a comma list needs only one visible alternative', async () => {
      const r = await check(broker('/hidden/display', { formFields: { 'input[name="nope"],input[name="email"],input[type="email"]': 'x' } }));
      assert.equal(r.status, 'drifted');
      const ok = await check(broker('/ok', { formFields: { 'input[name="nope"],input[name="email"]': 'x' } }));
      assert.equal(ok.status, 'ok', ok.detail);
    });
  });

  describe('a page on another domain is drifted, for every method (H5)', () => {
    test('a form broker that redirects off its domain', async () => {
      const r = await check(broker('/redirect-offsite'));
      assert.equal(r.status, 'drifted', r.detail);
      assert.match(r.detail, /redirected to localhost/);
    });

    test('a manual broker that redirects off its domain', async () => {
      const r = await check(broker('/redirect-offsite', { method: 'manual', formFields: undefined, submitSelector: undefined }));
      assert.equal(r.status, 'drifted', r.detail);
      assert.match(r.detail, /redirected to localhost/);
    });

    test('a redirect within the same site is fine', async () => {
      const r = await check(broker('/redirect-same-site'));
      assert.equal(r.status, 'ok', r.detail);
    });
  });

  test('a manual broker only has to answer', async () => {
    const r = await check(broker('/ok', { method: 'manual', formFields: undefined, submitSelector: undefined }));
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /a manual broker's form is not checked/);
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

  describe('read-only, seen from inside the page: the check causes no input event of any kind', () => {
    // The request log only sees traffic. A typed character, a click or a requestSubmit() that
    // sends nothing leaves no trace there, so every fixture page records these events itself.
    const eventsAfterCheck = async (b, opts = { settleMs: 0 }) => {
      const page = await context.newPage();
      try {
        const result = await checkBroker(page, b, opts);
        return { result, events: await page.evaluate(() => window.__events) };
      } finally { await page.close(); }
    };

    test('the recorder is live: a click the test performs itself is recorded (so silence means something)', async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${server.origin}/ok`);
        await page.click('h1');
        await page.fill('input[name="email"]', 'a@example.com');
        await page.press('input[name="email"]', 'Tab');
        const events = await page.evaluate(() => window.__events);
        for (const type of ['click', 'input', 'keydown', 'change']) {
          assert.ok(events.some((e) => e.startsWith(`${type} `)), `no ${type} in: ${events}`);
        }
        for (const type of ['input', 'change', 'click', 'keydown', 'submit']) assert.ok(EVENT_TYPES.includes(type));
      } finally { await page.close(); }
    });

    test('no input, change, click, key or submit event fires, on any kind of page or selector', async () => {
      const cases = [
        broker('/ok'),
        broker('/ok', { submitSelector: 'button[type="submit"]:has-text("Remove")' }),
        broker('/ok', { formFields: { 'input[name="email"],input[type="email"]': 'x' } }),
        broker('/drifted'),
        broker('/captcha-form', { captchaLikely: true }),
        broker('/captcha-drifted', { formFields: { 'input[name="first"]': 'Jane', 'input[name="zip"]': '90001' } }),
        broker('/hidden/display'),
        broker('/hidden/submit', { submitSelector: 'button[type="submit"]:has-text("Remove")' }),
        broker('/ok', { method: 'manual', formFields: undefined, submitSelector: undefined }),
        broker('/wall'),
      ];
      for (const b of cases) {
        const { events } = await eventsAfterCheck(b);
        assert.deepEqual(events, [], `${b.optOutUrl} ${b.submitSelector}: ${events}`);
      }
      const late = await eventsAfterCheck(broker('/late-form'), { settleMs: 3000 });
      assert.equal(late.result.status, 'ok', late.result.detail);
      assert.deepEqual(late.events, [], 'waiting for a script-drawn form does not touch it either');
    });

    test('the page object is only asked to look: goto, evaluate, locator reads, waits and close', async () => {
      const used = new Set();
      const spy = (target) => new Proxy(target, {
        get(obj, key) {
          const value = obj[key];
          if (typeof key === 'string') used.add(key);
          return typeof value === 'function' ? value.bind(obj) : value;
        },
      });
      const real = await context.newPage();
      try {
        await checkBroker(spy(real), broker('/ok', { submitSelector: 'button[type="submit"]:has-text("Remove")' }), { settleMs: 0 });
      } finally { await real.close(); }
      const allowed = new Set(['goto', 'evaluate', 'locator', 'waitForTimeout', 'url', 'title', 'content', 'then']);
      const unexpected = [...used].filter((k) => !allowed.has(k));
      assert.deepEqual(unexpected, [], `page methods used: ${[...used]}`);
    });
  });
});
