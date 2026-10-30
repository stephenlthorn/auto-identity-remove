/**
 * test/round2-runners.browser.test.js
 *
 * The round-2 broker findings against a real Chromium (the auditor's probes 1, 3, 4,
 * 5 and 6 as tests): BRK2-1, BRK2-3, BRK2-4, BRK2-5, BRK2-6.
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1. Set AIDR_CHROME_PATH to use an installed Chrome:
 *
 *   AIDR_BROWSER_TESTS=1 AIDR_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     node --test test/round2-runners.browser.test.js
 *
 * Pages are set with setContent() and page.goto is replaced, so nothing here touches
 * a real website.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makeContext, PERSON } = require('./broker-runner-harness');
const manual = require('../lib/manual-captcha');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

describe('round-2 broker findings in a real browser', { skip: !ENABLED }, () => {
  let browser;

  before(async () => {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.AIDR_CHROME_PATH || undefined });
  });
  after(async () => { if (browser) await browser.close(); });

  /** A page whose goto() just sets the markup; `events` collects what the page reports. */
  async function openPage(html) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const events = [];
    await page.exposeFunction('report', (what) => { events.push(what); });
    page.goto = async () => { await page.setContent(html, { waitUntil: 'domcontentloaded' }); return null; };
    return { page, events };
  }

  // ── BRK2-6 (probe1) ─────────────────────────────────────────────────────────

  test('BRK2-6: a field outside any <form> gets ITS OWN button, not the header newsletter\'s', async () => {
    const html = `<html lang="en"><body>
      <header><form id="news"><input name="nl" type="text" placeholder="newsletter"><button type="submit" id="nlbtn"
        onclick="event.preventDefault();report('newsletter');document.getElementById('msg').textContent='Your request has been received';">Join</button></form></header>
      <div id="msg"></div>
      <main><h1>Opt out</h1><div class="optout"><input name="email" type="text"><button type="submit" id="real" onclick="report('real')">Remove me</button></div></main></body></html>`;
    const { page, events } = await openPage(html);
    const h = loadRunner();
    h.runner.configure({ person: PERSON, personCount: 1, config: {} });
    await h.runner.processBrokerWithPerson(makeContext(page), {
      name: 'ProbeBroker', method: 'direct-form', optOutUrl: 'https://example.test/optout',
      formFields: { 'input[name="email"]': 'a@b.example' }, submitSelector: 'button[type="submit"]', captchaLikely: false,
    }, PERSON);
    assert.deepEqual(events, ['real']);
    assert.notEqual(h.logged.at(-1).status, 'success', 'the newsletter\'s message must not be taken for the answer');
  });

  test('BRK2-6: a form-less field with no button of its own finds nothing (never another form\'s)', async () => {
    const html = `<html lang="en"><body>
      <header><form id="news"><input name="nl" type="text"><button type="submit" onclick="event.preventDefault();report('newsletter')">Join</button></form></header>
      <main><div class="optout"><input name="email" type="text"></div></main></body></html>`;
    const { page, events } = await openPage(html);
    const h = loadRunner();
    h.runner.configure({ person: PERSON, personCount: 1, config: {} });
    await h.runner.processBrokerWithPerson(makeContext(page), {
      name: 'ProbeBroker', method: 'direct-form', optOutUrl: 'https://example.test/optout',
      formFields: { 'input[name="email"]': 'a@b.example' }, submitSelector: 'button[type="submit"]', captchaLikely: false,
    }, PERSON);
    assert.deepEqual(events, []);
    assert.equal(h.logged.at(-1).status, 'error');
    assert.match(h.logged.at(-1).detail, /not found/);
  });

  test('BRK2-6: a field inside a form still uses that form\'s button', async () => {
    const html = `<html lang="en"><body>
      <header><form id="news"><input name="nl" type="text"><button type="submit" onclick="event.preventDefault();report('newsletter')">Join</button></form></header>
      <main><form id="f" onsubmit="event.preventDefault();report('real');document.getElementById('m').textContent='Your request has been received'"><input name="email" type="text"><button type="submit">Remove me</button></form><p id="m"></p></main></body></html>`;
    const { page, events } = await openPage(html);
    const h = loadRunner();
    h.runner.configure({ person: PERSON, personCount: 1, config: {} });
    await h.runner.processBrokerWithPerson(makeContext(page), {
      name: 'ProbeBroker', method: 'direct-form', optOutUrl: 'https://example.test/optout',
      formFields: { 'input[name="email"]': 'a@b.example' }, submitSelector: 'button[type="submit"]', captchaLikely: false,
    }, PERSON);
    assert.deepEqual(events, ['real']);
    assert.equal(h.logged.at(-1).status, 'success');
  });

  // ── BRK2-3 (probes 4 and 5) ─────────────────────────────────────────────────

  const CAPTCHA_FORM = (script) => `<html lang="en"><body>
    <div id="root"><form id="f"><input name="email" type="text"><div class="g-recaptcha" data-sitekey="k"></div><textarea name="g-recaptcha-response" style="display:none"></textarea>
    <button type="submit" id="go">Send</button></form></div><div id="msg"></div><script>${script}</script></body></html>`;

  const STAYS = `document.getElementById('go').addEventListener('click',function(e){e.preventDefault();report('click');document.getElementById('msg').textContent='Request received';});`;
  const REPLACED = `document.getElementById('go').addEventListener('click',function(e){e.preventDefault();report('click');document.getElementById('root').innerHTML='<p>Your request has been received</p>';});`;

  for (const [name, script, expected] of [['the form stays on screen', STAYS, 'success'], ['the form is replaced by the confirmation', REPLACED, 'success']]) {
    test(`BRK2-3: the person presses Send during the wait and ${name}: exactly one click reaches the page`, async () => {
      const { page, events } = await openPage(CAPTCHA_FORM(script));
      const h = loadRunner();
      h.runner.configure({ person: PERSON, personCount: 1, config: { captcha: { manualTimeoutSec: 20 } }, manual: true, headless: false, isTTY: true });
      // the person: solves the CAPTCHA (a token appears), then presses Send a moment later
      setTimeout(async () => {
        await page.evaluate(() => { document.querySelector('textarea[name="g-recaptcha-response"]').value = 'tok'; }).catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
        await page.evaluate(() => document.getElementById('go').click()).catch(() => {});
      }, 600);
      await h.runner.processBrokerWithPerson(makeContext(page), {
        name: 'P', method: 'direct-form', optOutUrl: 'https://example.test/optout',
        formFields: { 'input[name="email"]': 'a@b.example' }, submitSelector: 'button[type="submit"]', captchaLikely: true,
      }, PERSON);
      assert.deepEqual(events, ['click'], 'a second click would be a second request at the broker');
      assert.equal(h.logged.at(-1).status, expected, JSON.stringify(h.logged));
    });
  }

  test('BRK2-3 (generic runner): the same, with the person pressing Submit inside handleCaptcha', async () => {
    const gr = require('../generic-runner');
    gr._setConfig({ person: { firstName: 'A', lastName: 'B', fullName: 'A B', email: 'a@b.example', state: 'TX', zip: '78701' } });
    try {
      for (const script of [STAYS, REPLACED]) {
        const html = `<html lang="en"><body><div id="root"><form id="f"><h2>Opt out request</h2><input name="email" type="email"><div class="g-recaptcha" data-sitekey="k"></div>
          <button type="submit" id="go">Submit</button></form></div><div id="msg"></div><script>${script}</script></body></html>`;
        const { page, events } = await openPage(html);
        const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
        const result = await gr.processGenericUrl(page, { name: 'G', url: 'https://broker.example.test/optout-request' }, { optOuts: {} }, false, new Set(), {
          person: { firstName: 'A', lastName: 'B', fullName: 'A B', email: 'a@b.example', state: 'TX', zip: '78701' },
          submissionEmail: 'alias@relay.example',
          dnsLookup: lookup,
          handleCaptcha: async (pg) => { await pg.evaluate(() => document.getElementById('go').click()); return 'solved'; },
        });
        assert.deepEqual(events, ['click'], JSON.stringify(result));
        assert.notEqual(result.status, 'error', JSON.stringify(result));
        await page.close();
      }
    } finally {
      gr._setConfig(null);
    }
  });

  // ── BRK2-5 and BRK2-4 (probe 3) ─────────────────────────────────────────────

  const WIDGET_PAGE = '<html><body><form><div class="g-recaptcha" data-sitekey="k"></div><textarea name="g-recaptcha-response" style="display:none"></textarea><button type="submit">Send</button></form></body></html>';

  test('BRK2-5: the page replaced by a 502 during the wait is "navigated", not solved', async () => {
    const page = await browser.newPage();
    await page.setContent(WIDGET_PAGE);
    setTimeout(() => page.setContent('<html><body><h1>502 Bad Gateway</h1></body></html>').catch(() => {}), 300);
    const t0 = Date.now();
    const outcome = await manual.handleCaptcha(page, { manual: true, timeoutMs: 8000, pollMs: 100, broker: { name: 'X' }, onWaiting() {} });
    assert.equal(outcome, 'navigated');
    assert.ok(Date.now() - t0 < 4000);
    await page.close();
  });

  test('BRK2-4: a page stuck in a busy loop ends the wait at its timeout and can be closed', async () => {
    const page = await browser.newPage();
    await page.setContent(WIDGET_PAGE);
    setTimeout(() => { page.evaluate(() => { setTimeout(() => { for (;;) {} }, 0); }).catch(() => {}); }, 300);
    const t0 = Date.now();
    const outcome = await Promise.race([
      manual.handleCaptcha(page, { manual: true, timeoutMs: 1000, pollMs: 100, broker: { name: 'X' }, onWaiting() {} }),
      new Promise((resolve) => setTimeout(() => resolve('STILL HUNG'), 15000)),
    ]);
    const took = Date.now() - t0;
    assert.equal(outcome, 'timeout');
    assert.ok(took < 5000, `a 1 s wait took ${took} ms`);
    const closeStarted = Date.now();
    await Promise.race([page.close({ runBeforeUnload: false }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8000))]);
    assert.ok(Date.now() - closeStarted < 8000, 'closing the stuck page must not hang either');
  });

  // ── BRK2-1 (probe 6) ────────────────────────────────────────────────────────

  test('BRK2-1: a Do Not Sell link that swaps in policy boilerplate is manual, never success', async () => {
    const gr = require('../generic-runner');
    const POLICY = `<h1>California Privacy Notice</h1><p>You may ask us to delete or stop selling your personal information. We will respond within 45 days after your request is received.</p><p>Call us at 1-800-555-0100.</p>`;
    const { page } = await openPage(`<html lang="en"><body><h1>Acme Data</h1><p>We sell lists.</p>
      <a id="dns" href="#">Do Not Sell My Personal Information</a>
      <script>document.getElementById('dns').addEventListener('click',function(e){e.preventDefault();document.body.innerHTML=${JSON.stringify(POLICY)};});</script></body></html>`);
    const result = await gr.processGenericUrl(page, { name: 'acme.com', url: 'https://acme.example.test/' }, { optOuts: {} }, false, new Set(), {
      person: { firstName: 'A', lastName: 'B', fullName: 'A B', email: 'a@b.example', state: 'TX', zip: '78701' },
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await page.close();
    assert.notEqual(result.status, 'success', JSON.stringify(result));
    assert.equal(result.status, 'manual');
  });
});
