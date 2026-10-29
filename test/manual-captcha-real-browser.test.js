/**
 * test/manual-captcha-real-browser.test.js
 *
 * R1 (issue #16) against a real DOM: a local page with a fake CAPTCHA widget, a
 * scripted "human" who fills the widget's hidden response field while the tool
 * waits, and the real broker runner clicking submit and classifying the result.
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 (the default suite stays browser-free),
 * like forms-real-browser.test.js. Set AIDR_CHROME_PATH to use an installed Chrome:
 *
 *   AIDR_BROWSER_TESTS=1 AIDR_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     node --test test/manual-captcha-real-browser.test.js
 *
 * Pages are set with setContent() or served from 127.0.0.1 by this file (the runner
 * navigates to the opt-out URL itself); nothing here touches a real website.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadRunner, makeContext, PERSON } = require('./broker-runner-harness');
const realManual = require('../lib/manual-captcha');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

const FORM = (widget) => `<!doctype html><html lang="en"><body>
<h1>Opt out of this site</h1>
<form id="optout" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Your request has been received.';">
  <input name="email" type="email" value="test.user@example.com">
  ${widget}
  <button type="submit">Remove my record</button>
</form>
<p id="result"></p>
</body></html>`;

const RECAPTCHA = '<div class="g-recaptcha" data-sitekey="fake-site-key"></div><textarea name="g-recaptcha-response" style="display:none"></textarea>';
const HCAPTCHA = '<div class="h-captcha" data-sitekey="fake-site-key"></div><textarea name="h-captcha-response" style="display:none"></textarea>';
const TURNSTILE = '<div class="cf-turnstile" data-sitekey="fake-site-key"></div><input type="hidden" name="cf-turnstile-response" value="">';

const BROKER = {
  name: 'RealBrowserCaptchaSite',
  method: 'direct-form',
  optOutUrl: 'https://example.test/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
  captchaLikely: true,
};

/** The scripted human: after `ms`, fill the response field. */
function humanSolvesAfter(page, ms, selector) {
  return setTimeout(() => {
    page.evaluate((sel) => {
      const field = document.querySelector(sel);
      field.value = 'FAKE-TOKEN-FROM-A-PERSON';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector).catch(() => {});
  }, ms);
}

describe('manual CAPTCHA, real browser', { skip: !ENABLED }, () => {
  let chromium;
  let browser;
  let server;
  let optOutUrl;

  before(async () => {
    ({ chromium } = require('playwright'));
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FORM(RECAPTCHA));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    optOutUrl = `http://127.0.0.1:${server.address().port}/optout`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.AIDR_CHROME_PATH || undefined,
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(r => server.close(r));
  });

  async function openPage(html) {
    const page = await browser.newPage();
    await page.setContent(html);
    return page;
  }

  const fast = (extra = {}) => ({ pollMs: 100, ...extra });

  for (const [label, widget, field] of [
    ['reCAPTCHA', RECAPTCHA, 'textarea[name="g-recaptcha-response"]'],
    ['hCaptcha', HCAPTCHA, 'textarea[name="h-captcha-response"]'],
    ['Turnstile', TURNSTILE, 'input[name="cf-turnstile-response"]'],
  ]) {
    test(`${label}: handleCaptcha returns solved once the person fills the response field`, async () => {
      const page = await openPage(FORM(widget));
      const waiting = [];
      const timer = humanSolvesAfter(page, 400, field);
      try {
        const result = await realManual.handleCaptcha(page, fast({
          manual: true, broker: BROKER, timeoutMs: 10000, onWaiting: (info) => waiting.push(info),
        }));
        assert.equal(result, 'solved');
        assert.equal(waiting.length, 1);
      } finally {
        clearTimeout(timer);
        await page.close();
      }
    });
  }

  test('a page with no CAPTCHA is none', async () => {
    const page = await openPage(FORM(''));
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: true, broker: BROKER })), 'none');
    } finally {
      await page.close();
    }
  });

  test('nobody solves it: timeout, in about the time given', async () => {
    const page = await openPage(FORM(RECAPTCHA));
    const started = Date.now();
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: true, broker: BROKER, timeoutMs: 600 })), 'timeout');
      assert.ok(Date.now() - started < 5000, 'must not hang past the timeout');
    } finally {
      await page.close();
    }
  });

  test('manual off: skipped at once, no waiting', async () => {
    const page = await openPage(FORM(RECAPTCHA));
    const started = Date.now();
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: false, broker: BROKER })), 'skipped');
      assert.ok(Date.now() - started < 2000);
    } finally {
      await page.close();
    }
  });

  test('a "verify you are human" page is solved when the challenge goes away', async () => {
    const page = await openPage('<!doctype html><body><h1>Verify you are human</h1><p>One moment.</p></body>');
    const timer = setTimeout(() => {
      page.evaluate(() => {
        const welcome = document.createElement('h1');
        welcome.textContent = 'Welcome';
        document.body.replaceChildren(welcome);
      }).catch(() => {});
    }, 400);
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: true, broker: BROKER, timeoutMs: 10000 })), 'solved');
    } finally {
      clearTimeout(timer);
      await page.close();
    }
  });

  test('closing the window during the wait ends it as failed, not as an exception', async () => {
    const page = await openPage(FORM(RECAPTCHA));
    const timer = setTimeout(() => { page.close().catch(() => {}); }, 300);
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: true, broker: BROKER, timeoutMs: 10000 })), 'failed');
    } finally {
      clearTimeout(timer);
    }
  });

  test('a page that navigates during the wait is tolerated and the new page decides', async () => {
    const page = await openPage(FORM(RECAPTCHA));
    const timer = setTimeout(() => {
      page.setContent('<!doctype html><body><h1>Thank you</h1></body>').catch(() => {});
    }, 400);
    try {
      assert.equal(await realManual.handleCaptcha(page, fast({ manual: true, broker: BROKER, timeoutMs: 10000 })), 'solved');
    } finally {
      clearTimeout(timer);
      await page.close();
    }
  });

  // ── the whole runner, on the real DOM ──────────────────────────────────────

  test('the runner records success after a person solves the CAPTCHA and the tool submits', async () => {
    const page = await browser.newPage();
    const toasts = [];
    const h = loadRunner({
      './manual-captcha': {
        ...realManual,
        handleCaptcha: (p, o) => realManual.handleCaptcha(p, { ...o, pollMs: 100 }),
      },
      './notify': { desktopNotify: (title, message) => toasts.push({ title, message }) },
    });
    h.runner.configure({ person: PERSON, personCount: 1, capsolver: null, manual: true, headless: false, isTTY: true, config: {} });
    const timer = humanSolvesAfter(page, 1500, 'textarea[name="g-recaptcha-response"]');
    try {
      await h.runner.processBrokerWithPerson(makeContext(page), { ...BROKER, optOutUrl }, PERSON);
      assert.equal(h.logged.at(-1).status, 'success', JSON.stringify(h.logged));
      assert.equal(h.recorded.success.length, 1);
      assert.equal(toasts.length, 1);
    } finally {
      clearTimeout(timer);
    }
  });

  test('the runner records captcha_failed when nobody comes, without submitting', async () => {
    const page = await browser.newPage();
    const h = loadRunner({
      './manual-captcha': {
        ...realManual,
        handleCaptcha: (p, o) => realManual.handleCaptcha(p, { ...o, pollMs: 100 }),
      },
      './notify': { desktopNotify: () => {} },
    });
    h.runner.configure({
      person: PERSON, personCount: 1, capsolver: null, manual: true, headless: false, isTTY: true,
      config: { captcha: { manualTimeoutSec: 1 } },
    });
    await h.runner.processBrokerWithPerson(makeContext(page), { ...BROKER, optOutUrl }, PERSON);
    const last = h.logged.at(-1);
    assert.equal(last.status, 'captcha_failed');
    assert.match(last.detail, /aidr captchas/);
    assert.equal(h.recorded.success.length, 0);
  });
});
