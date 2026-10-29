/**
 * test/forms-real-browser.test.js
 *
 * Real-browser (headless Chromium) checks of the pieces the stub-based tests
 * cannot prove, because they depend on what a real DOM and real CSS do:
 *
 *   - findListingUrl's page-side probe: interstitial elements, a visible vs an
 *     invisible reCAPTCHA frame, listing links, blank pages, HTTP status.
 *   - the brokers.js full-name selectors (:not() chains) against a real form.
 *   - the bot-trap guard (left:-9999px etc.) in fillForm and the resolver.
 *   - a real <select> with a country code, with every wait bounded.
 *
 * Runs ONLY when AIDR_BROWSER_TESTS=1 (the default suite stays browser-free), like
 * field-resolver.browser.test.js. Set AIDR_CHROME_PATH to use an installed
 * Chrome/Chromium instead of Playwright's own download:
 *
 *   AIDR_BROWSER_TESTS=1 AIDR_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     node --test test/forms-real-browser.test.js
 *
 * The only pages loaded are served from 127.0.0.1 by this file or set directly
 * with setContent(). Nothing here touches a real website.
 */

'use strict';

process.env.TURBO = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

const FILLER = '<p>Search results for people in Texas. Browse records, addresses and phone numbers.</p>'.repeat(30);

const PAGES = {
  '/ok': { body: `<title>Jane Doe - People Search</title>${FILLER}<a href="/people/jane-doe-123">Jane Doe, 34</a><a href="/people/john-smith-9">John Smith</a><a href="/">Home</a>` },
  '/empty': { body: `<title>No results</title>${FILLER}<a href="/">Home</a><footer>Protected by reCAPTCHA.</footer>` },
  '/forbidden': { status: 403, body: '<title>403 Forbidden</title><h1>Forbidden</h1>' },
  '/cf': { body: '<title>Just a moment...</title><div id="challenge-form"><p>Checking your browser before accessing the site.</p></div>' },
  '/recaptcha': { body: `<title>Search</title>${FILLER}<iframe src="/recaptcha/api2/anchor?k=x&size=normal" width="304" height="78"></iframe>` },
  '/recaptcha-invisible': { body: `<title>Search</title>${FILLER}<iframe src="/recaptcha/api2/anchor?k=x&size=invisible" width="256" height="60"></iframe>` },
  '/recaptcha/api2/anchor': { body: '<p>widget</p>' },
  '/blank': { body: '<title></title>' },
};

describe('forms real-browser checks', { skip: !ENABLED }, () => {
  let chromium;
  let browser;
  let server;
  let base;
  let findListingUrl;
  let fillForm;
  let brokersFor;

  before(async () => {
    ({ chromium } = require('playwright'));
    ({ findListingUrl, fillForm } = require('../lib/forms'));

    server = http.createServer((req, res) => {
      const page = PAGES[req.url.split('?')[0]] || PAGES['/ok'];
      res.writeHead(page.status || 200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>${page.body}</body></html>`);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.AIDR_CHROME_PATH || undefined,
    });

    brokersFor = (person) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-rb-'));
      fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
      fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ person }));
      try { return require(path.join(dir, 'brokers.js')).forPerson(person); } finally {
        for (const p of Object.keys(require.cache)) if (p.startsWith(dir)) delete require.cache[p];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(r => server.close(r));
  });

  const listing = (route, extra = {}) => ({
    searchUrl: `${base}${route}?q=x`,
    listingPattern: /127\.0\.0\.1:\d+\/people\//i,
    ...extra,
  });

  async function run(route, extra, person) {
    const page = await browser.newPage();
    try {
      return { value: await findListingUrl(page, listing(route, extra), person) };
    } catch (err) {
      return { error: err };
    } finally {
      await page.close();
    }
  }

  // ── findListingUrl against real pages ──────────────────────────────────────

  test('a results page returns the listing link, never the homepage link', async () => {
    const r = await run('/ok');
    assert.equal(r.value, `${base}/people/jane-doe-123`);
  });

  test('the last name picks the right person among several links', async () => {
    const r = await run('/ok', {}, { lastName: 'Smith' });
    assert.equal(r.value, `${base}/people/john-smith-9`);
  });

  test('a normal page with no matching link is null, even with a reCAPTCHA footer', async () => {
    const r = await run('/empty');
    assert.equal(r.error, undefined);
    assert.equal(r.value, null);
  });

  test('HTTP 403 is UNVERIFIABLE', async () => {
    const r = await run('/forbidden');
    assert.equal(r.error && r.error.code, 'UNVERIFIABLE');
  });

  test('a Cloudflare-style interstitial is UNVERIFIABLE', async () => {
    const r = await run('/cf');
    assert.equal(r.error && r.error.code, 'UNVERIFIABLE');
  });

  test('a visible reCAPTCHA checkbox frame is UNVERIFIABLE', async () => {
    const r = await run('/recaptcha');
    assert.equal(r.error && r.error.code, 'UNVERIFIABLE');
  });

  test('an invisible reCAPTCHA v3 badge frame is NOT a wall', async () => {
    const r = await run('/recaptcha-invisible');
    assert.equal(r.error, undefined);
    assert.equal(r.value, null);
  });

  test('a blank page is UNVERIFIABLE', async () => {
    const r = await run('/blank');
    assert.equal(r.error && r.error.code, 'UNVERIFIABLE');
  });

  test('a refused connection is UNVERIFIABLE with the original error as cause', async () => {
    const page = await browser.newPage();
    try {
      await findListingUrl(page, { searchUrl: 'http://127.0.0.1:1/search?q=Jane+Doe', listingPattern: /x/ });
      assert.fail('expected a throw');
    } catch (err) {
      assert.equal(err.code, 'UNVERIFIABLE');
      assert.ok(err.cause instanceof Error);
      assert.doesNotMatch(err.message, /Jane|Doe/);
    } finally {
      await page.close();
    }
  });

  // ── fillForm against real forms ───────────────────────────────────────────

  const PERSON = {
    firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe',
    email: 'jane@example.com', city: 'Austin', state: 'TX', zip: '73301', country: 'US',
  };

  async function formPage(html) {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`, { waitUntil: 'domcontentloaded' });
    return page;
  }
  const valueOf = (page, sel) => page.locator(sel).first().inputValue();

  for (const name of ['FastPeopleSearch', 'TruePeopleSearch', 'ThatsThem', 'SearchPeopleFree', 'PeopleSearchNow', 'SocialCatfish']) {
    test(`${name}: full name goes only into the name field on a real form`, async () => {
      const broker = brokersFor(PERSON).find(b => b.name === name);
      const page = await formPage(`
        <input name="firstname"><input name="lastname"><input name="company_name"><input name="username">
        <input name="name" id="optout_name" placeholder="Your name"><input name="email" type="email">`);
      try {
        await fillForm(page, broker.formFields, PERSON);
        assert.equal(await valueOf(page, '[name="name"]'), 'Jane Doe');
        for (const trap of ['firstname', 'lastname', 'company_name', 'username']) {
          assert.equal(await valueOf(page, `[name="${trap}"]`), '', `${trap} must stay empty`);
        }
      } finally {
        await page.close();
      }
    });
  }

  test('Experian: the city is not typed into "Email address", and goes to a real city field', async () => {
    const broker = brokersFor(PERSON).find(b => b.name === 'Experian (marketing)');
    const noCity = await formPage(`
      <input name="first_name"><input name="last_name">
      <label for="c">Email address</label><input id="c" name="contact"><input name="zip">`);
    try {
      await fillForm(noCity, broker.formFields, PERSON);
      assert.equal(await valueOf(noCity, '#c'), '');
    } finally {
      await noCity.close();
    }
    const withCity = await formPage('<input name="first_name"><input name="last_name"><input name="city"><input name="zip">');
    try {
      await fillForm(withCity, broker.formFields, PERSON);
      assert.equal(await valueOf(withCity, '[name="city"]'), 'Austin');
    } finally {
      await withCity.close();
    }
  });

  test('a non-email selector never fills an email control, by name or through its label', async () => {
    const page = await formPage(`
      <input name="email_addr" id="a">
      <label for="b">Contact</label><input id="b" name="contact_email" type="email">`);
    try {
      await fillForm(page, { 'input[name*="addr" i]': 'Austin' });
      await fillForm(page, { 'input[name*="contact" i]': 'Austin' });
      assert.equal(await valueOf(page, '#a'), '');
      assert.equal(await valueOf(page, '#b'), '');
    } finally {
      await page.close();
    }
  });

  const TRAPS = {
    'left:-9999px': 'position:absolute;left:-9999px;top:0',
    'top:-9999px': 'position:absolute;top:-9999px;left:0',
    '1px box (default padding and border)': 'width:1px;height:1px;overflow:hidden',
    'opacity:0': 'opacity:0',
  };
  for (const [label, css] of Object.entries(TRAPS)) {
    test(`a honeypot email field styled ${label} is not filled; the real one is`, async () => {
      const page = await formPage(`
        <input type="email" name="email" id="trap" style="${css}" autocomplete="email">
        <input type="email" name="email" id="real" autocomplete="email">`);
      try {
        await fillForm(page, { 'input[name="email"]': 'jane@example.com' });
        assert.equal(await valueOf(page, '#trap'), '');
        assert.equal(await valueOf(page, '#real'), 'jane@example.com');
      } finally {
        await page.close();
      }
    });
  }

  test('a tabindex=-1 aria-hidden trap is not filled by the semantic resolver either', async () => {
    const page = await formPage(`
      <input type="email" id="trap" tabindex="-1" aria-hidden="true" autocomplete="email" name="usr_mail">
      <input type="email" id="real" autocomplete="email" name="contact_addr">`);
    try {
      // Neither name matches the selector, so this goes through the resolver.
      await fillForm(page, { 'input[name="email"]': 'jane@example.com' });
      assert.equal(await valueOf(page, '#trap'), '');
      assert.equal(await valueOf(page, '#real'), 'jane@example.com');
    } finally {
      await page.close();
    }
  });

  test('a non-US country code selects the country by value, instantly', async () => {
    const page = await formPage(`
      <input name="first">
      <select name="country"><option value="">Select</option><option value="US">United States</option><option value="CA">Canada</option></select>`);
    try {
      const t0 = Date.now();
      await fillForm(page, { 'input[name*="first" i]': 'Jane' }, { country: 'CA', state: 'ON', zip: 'K1A 0A6' });
      assert.equal(await page.locator('select[name="country"]').inputValue(), 'CA');
      assert.ok(Date.now() - t0 < 5000, 'no 30 s wait');
    } finally {
      await page.close();
    }
  });

  test('a country the select does not list returns quickly instead of waiting 60 s', async () => {
    const page = await formPage(`
      <select name="country"><option value="US">United States</option><option value="CA">Canada</option></select>`);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const t0 = Date.now();
      await fillForm(page, { 'input[name*="first" i]': 'Jane' }, { country: 'NZ', state: '', zip: '6011' });
      assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    } finally {
      console.warn = warn;
      await page.close();
    }
  });
});
