/**
 * test/generic-form-scope.browser.test.js
 *
 * Real-browser (headless Chromium) check of the generic runner's form handling:
 * describeFormElement() runs inside a real DOM, fill and click stay inside one
 * <form>, and the outcome is judged from the text the click added.
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 is set, like field-resolver.browser.test.js:
 *
 *   AIDR_BROWSER_TESTS=1 node --test test/generic-form-scope.browser.test.js
 *
 * Set AIDR_CHROME_PATH to a Chrome/Chromium binary to use it instead of
 * Playwright's own download. Pages are local fixtures (page.setContent); page.goto
 * is replaced so nothing ever touches the network.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

describe('generic-runner form scoping in a real browser', { skip: !ENABLED }, () => {
  let browser;
  let gr;

  const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'real@home.example', state: 'CA', zip: '90001' };
  const ALIAS = 'alias@relay.example';
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const BEHAVIOUR = `
    const note = (f, text) => { const p = document.createElement('p'); p.textContent = text; document.body.appendChild(p); window.__submitted = (window.__submitted || []).concat([f.id]); };
    document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => {
      e.preventDefault();
      if ('ok' in f.dataset) note(f, 'Your opt-out request has been received.');
      else if ('bad' in f.dataset) note(f, 'This field is required.');
      else window.__submitted = (window.__submitted || []).concat([f.id]);
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

  async function runFixture(body, { url = 'https://broker.example/opt-out', method } = {}) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.goto = async () => {
      await page.setContent(`<!doctype html><html lang="en"><head><title>Acme</title></head><body>${body}<script>${BEHAVIOUR}</script></body></html>`, { waitUntil: 'domcontentloaded' });
      return { status: () => 200 };
    };
    Object.defineProperty(page, 'url', { value: () => url });
    try {
      const result = await gr.processGenericUrl(page, { name: 'Fixture', url, source: 'markup', method }, { optOuts: {} }, false, new Set(), {
        person: PERSON, dnsLookup: publicLookup, submissionEmail: ALIAS,
      });
      const submitted = await page.evaluate(() => window.__submitted || []);
      const emails = await page.evaluate(() => [...document.querySelectorAll('input[type=email]')].map(i => i.value));
      return { result, submitted, emails };
    } finally {
      await page.close();
    }
  }

  test('a header search form and a footer newsletter are left alone; only the opt-out form is submitted, with the alias', async () => {
    const { result, submitted, emails } = await runFixture(`
      <header><form id="hdrsearch" role="search"><input type="search" name="q"><button>Go</button></form></header>
      <main><h1>Your privacy choices</h1><section><h2>Request removal of your information</h2>
        <form id="optout" data-ok><label>Email <input type="email" name="email"></label><label>First name <input name="firstName"></label><button type="submit">Submit</button></form></section></main>
      <footer><form id="news"><input type="email" name="email_signup"><button type="submit">Subscribe</button></form></footer>`);
    assert.equal(result.status, 'success');
    assert.deepEqual(submitted, ['optout']);
    assert.deepEqual(emails, [ALIAS, ''], 'the relay alias goes into the opt-out form only');
  });

  test('a page whose only form is a footer newsletter is never filled or submitted', async () => {
    const { result, submitted, emails } = await runFixture(`
      <main><h1>Welcome</h1></main>
      <footer><form id="news"><label>Get offers <input type="email" name="email"></label><button type="submit">Sign up</button></form></footer>`);
    assert.equal(result.status, 'manual');
    assert.deepEqual(submitted, []);
    assert.deepEqual(emails, ['']);
  });

  test('a form that answers "This field is required" is an error', async () => {
    const { result } = await runFixture(`<main><h1>Opt out</h1><form id="optout" data-bad><input type="email" name="email"><button type="submit">Opt Out</button></form></main>`);
    assert.equal(result.status, 'error');
  });

  test('a click that native validation swallowed is unverified, never success', async () => {
    const { result, submitted } = await runFixture(`<main><h1>Opt out</h1><form id="optout"><input type="email" name="email"><input name="address" required><button type="submit">Opt Out</button></form></main>`);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(submitted, []);
  });

  test('a feed row classified manual never reaches the form filler', async () => {
    const { result, submitted } = await runFixture(`<main><h1>Opt out</h1><form id="optout" data-ok><input type="email" name="email"><button type="submit">Submit</button></form></main>`, { method: 'manual' });
    assert.equal(result.status, 'manual');
    assert.deepEqual(submitted, []);
  });

  test('Do Not Sell opening a modal form: only the modal form is submitted', async () => {
    const { result, submitted } = await runFixture(`
      <main><a href="#" onclick="document.getElementById('dlg').style.display='block'; return false;">Do Not Sell My Personal Information</a>
      <div id="dlg" role="dialog" style="display:none"><h2>Privacy request</h2><form id="modalform" data-ok><input type="email" name="email"><button type="submit">Submit</button></form></div></main>
      <footer><form id="news"><input type="email" name="email"><button type="submit">Subscribe</button></form></footer>`, { url: 'https://broker.example/' });
    assert.equal(result.status, 'success');
    assert.deepEqual(submitted, ['modalform']);
  });
});
