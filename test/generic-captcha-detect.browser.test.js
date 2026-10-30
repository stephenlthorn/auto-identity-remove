/**
 * test/generic-captcha-detect.browser.test.js
 *
 * Real-browser (headless Chromium) check of the generic runner's CAPTCHA gate:
 * the selectors must be valid CSS in a real engine (they use :not(form *)), find a
 * widget in the form, and leave alone the things that are on a page without
 * guarding its opt-out form (a newsletter form's own widget, the reCAPTCHA v3
 * badge, an invisible v2 button).
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 is set, like generic-form-scope.browser.test.js:
 *
 *   AIDR_BROWSER_TESTS=1 node --test test/generic-captcha-detect.browser.test.js
 *
 * Set AIDR_CHROME_PATH to a Chrome/Chromium binary to use it instead of
 * Playwright's own download. Pages are local fixtures (page.setContent) and the
 * widget "frames" point at about:blank, so nothing ever touches the network.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

describe('generic-runner CAPTCHA gate in a real browser', { skip: !ENABLED }, () => {
  let browser;
  let gr;

  const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'real@home.example', state: 'CA', zip: '90001' };
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const BEHAVIOUR = `
    document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => {
      e.preventDefault();
      window.__submitted = (window.__submitted || []).concat([f.id]);
      const p = document.createElement('p'); p.textContent = 'Your opt-out request has been received.'; document.body.appendChild(p);
    }));
  `;

  before(() => {
    const { chromium } = require('playwright');
    gr = require('../generic-runner');
    gr._setConfig({ person: PERSON });
    return chromium.launch({ headless: true, executablePath: process.env.AIDR_CHROME_PATH || undefined }).then((b) => { browser = b; });
  });

  after(async () => {
    if (browser) await browser.close();
    gr._setConfig(null);
  });

  const optOutForm = (inside = '') => `
    <h1>Your privacy choices</h1>
    <form id="optout"><h2>Request removal of your information</h2>
      <label>Email <input type="email" name="email"></label>
      <label>First name <input name="firstName"></label>
      ${inside}
      <button type="submit">Submit</button></form>`;

  async function runFixture(body, { handler } = {}) {
    const calls = [];
    const handleCaptcha = handler === undefined ? undefined : async (page, ctx) => { calls.push(ctx.broker.name); return handler; };
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.goto = async () => {
      await page.setContent(`<!doctype html><html lang="en"><head><title>Acme</title></head><body><main>${body}</main><script>${BEHAVIOUR}</script></body></html>`, { waitUntil: 'domcontentloaded' });
      return { status: () => 200 };
    };
    const url = 'https://broker.example/opt-out';
    Object.defineProperty(page, 'url', { value: () => url });
    try {
      const result = await gr.processGenericUrl(page, { name: 'Fixture', url, source: 'markup' }, { optOuts: {} }, false, new Set(), {
        person: PERSON, dnsLookup: publicLookup, handleCaptcha,
      });
      const submitted = await page.evaluate(() => window.__submitted || []);
      const typed = await page.evaluate(() => [...document.querySelectorAll('#optout input[type=email], #optout input[name=firstName]')].map(i => i.value));
      return { result, calls, submitted, typed };
    } finally {
      await page.close();
    }
  }

  const WIDGETS_IN_FORM = {
    'a reCAPTCHA container': '<div class="g-recaptcha" data-sitekey="k"></div>',
    'the hidden reCAPTCHA response field': '<textarea name="g-recaptcha-response" style="display:none"></textarea>',
    'an hCaptcha frame': '<iframe src="about:blank#hcaptcha" title="hCaptcha"></iframe>',
    'a Turnstile response field': '<input type="hidden" name="cf-turnstile-response" value="">',
    'a widget that only carries a sitekey': '<div data-sitekey="k"></div>',
  };

  for (const [label, markup] of Object.entries(WIDGETS_IN_FORM)) {
    test(`${label} inside the form is detected and the handler is asked`, async () => {
      const { result, calls, submitted } = await runFixture(optOutForm(markup), { handler: 'solved' });
      assert.deepEqual(calls, ['Fixture']);
      assert.equal(result.status, 'success');
      assert.deepEqual(submitted, ['optout']);
    });
  }

  test('an unsolved CAPTCHA is not submitted into', async () => {
    const { result, submitted } = await runFixture(optOutForm('<div class="g-recaptcha" data-sitekey="k"></div>'), { handler: 'timeout' });
    assert.equal(result.status, 'captcha_failed');
    assert.deepEqual(submitted, []);
  });

  test('with no handler a CAPTCHA\'d form is captcha_failed and nothing was typed or sent', async () => {
    const { result, submitted, typed } = await runFixture(optOutForm('<div class="g-recaptcha" data-sitekey="k"></div>'));
    assert.equal(result.status, 'captcha_failed');
    assert.deepEqual(submitted, []);
    assert.deepEqual(typed, ['', ''], 'the person\'s details were not typed into a form that cannot be sent');
  });

  test('a visible widget loose on the page, outside any form, is detected', async () => {
    const loose = '<div class="h-captcha" data-sitekey="k" style="min-height:40px;width:120px"></div>';
    const { calls } = await runFixture(optOutForm() + loose, { handler: 'solved' });
    assert.deepEqual(calls, ['Fixture']);
  });

  test('a newsletter form\'s own widget does not count against the opt-out form', async () => {
    const newsletter = '<form id="news"><input type="email" name="email_signup"><div class="g-recaptcha" data-sitekey="k" style="min-height:40px;width:120px"></div><button type="submit">Subscribe</button></form>';
    const { result, calls, submitted } = await runFixture(optOutForm() + newsletter, { handler: 'solved' });
    assert.deepEqual(calls, [], 'the handler (a person\'s three minutes) is not spent on an unrelated widget');
    assert.equal(result.status, 'success');
    assert.deepEqual(submitted, ['optout']);
  });

  test('the reCAPTCHA v3 badge frame and an invisible v2 button do not count', async () => {
    const badge = '<iframe src="about:blank#recaptcha-anchor&size=invisible" title="reCAPTCHA"></iframe>';
    const invisibleButton = '<button class="g-recaptcha" data-sitekey="k" type="button">Notify me</button>';
    const { result, calls } = await runFixture(optOutForm() + badge + invisibleButton, { handler: 'solved' });
    assert.deepEqual(calls, []);
    assert.equal(result.status, 'success');
  });

  test('a form with no CAPTCHA never reaches the handler', async () => {
    const { result, calls } = await runFixture(optOutForm(), { handler: 'solved' });
    assert.deepEqual(calls, []);
    assert.equal(result.status, 'success');
  });
});
