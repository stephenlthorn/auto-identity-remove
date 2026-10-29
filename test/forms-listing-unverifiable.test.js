/**
 * test/forms-listing-unverifiable.test.js
 *
 * BRK-9 / NET-4: findListingUrl() turned every failure into "no listing".
 *
 *   - lib/broker-runner.js did `.catch(() => null)`, so a timeout or DNS error
 *     became "Not listed - nothing to remove".
 *   - It never read the HTTP status. A 403 gave zero links, and --verify then
 *     recorded the broker as verifiedDeletedAt ("Verified removed"), which also
 *     suppresses the regulator complaint (findOverdue).
 *   - A Cloudflare / DataDome / PerimeterX / CAPTCHA interstitial is a 200 page
 *     with zero listing links, so it read as "verified clear" too.
 *
 * Contract (see FIX-WAVE1.md): the listing URL string, or null ONLY when the
 * search page loaded (2xx, no bot wall) and simply has no matching listing; and
 * an Error with err.code === 'UNVERIFIABLE' for a failed navigation, a non-2xx
 * response or a bot wall. Callers map that throw to error/unverifiable, never to
 * "not listed" or "verified clear".
 *
 * The page stub answers evaluate() with the facts the page-side probe collects
 * (url, title, visible text, interstitial markers, matching links), so these
 * tests exercise the classification, status handling and link choice.
 */

'use strict';

process.env.TURBO = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findListingUrl } = require('../lib/forms');

const BROKER = {
  name: 'ExampleBroker',
  searchUrl: 'https://www.example.com/search?q=Jane%20Doe&state=TX',
  listingPattern: /example\.com\/people\//i,
};

const MIN_PAGE = 80;
const FILLER = 'Search results for people in Texas. Browse records, addresses and phone numbers. '.repeat(40);

function probeResult(overrides = {}) {
  return {
    url: BROKER.searchUrl,
    title: 'Jane Doe - People Search',
    text: FILLER,
    textLength: FILLER.length,
    markers: [],
    links: [],
    ...overrides,
  };
}

function makePage({ status = 200, noResponse = false, gotoError, probe = probeResult(), evaluateError } = {}) {
  const seen = { goto: [] };
  return {
    seen,
    goto: async (url, opts) => {
      seen.goto.push({ url, opts });
      if (gotoError) throw gotoError;
      return noResponse ? null : { status: () => status };
    },
    evaluate: async (fn, args) => {
      if (evaluateError) throw evaluateError;
      seen.evaluateArgs = args;
      return typeof probe === 'function' ? probe(fn, args) : probe;
    },
  };
}

async function unverifiable(page, broker = BROKER, person) {
  try {
    await findListingUrl(page, broker, person);
  } catch (err) {
    assert.equal(err.code, 'UNVERIFIABLE', `expected code UNVERIFIABLE, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail('findListingUrl was expected to throw UNVERIFIABLE but returned');
}

// ── the happy paths ──────────────────────────────────────────────────────────

test('a 2xx page with a matching listing link returns that link', async () => {
  const page = makePage({ probe: probeResult({ links: [{ href: 'https://www.example.com/people/jane-doe-123', text: 'Jane Doe, 34' }] }) });
  assert.equal(await findListingUrl(page, BROKER), 'https://www.example.com/people/jane-doe-123');
});

test('a 2xx page that loaded and has no matching link returns null (really not listed)', async () => {
  assert.equal(await findListingUrl(makePage(), BROKER), null);
});

test('an unreadable status (no Response object) is not itself a failure', async () => {
  assert.equal(await findListingUrl(makePage({ noResponse: true }), BROKER), null);
});

test('a long normal page that only MENTIONS captcha in its footer is not a bot wall', async () => {
  const text = FILLER + ' This site is protected by reCAPTCHA and the Google Privacy Policy applies.';
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text, textLength: text.length }) }), BROKER), null);
});

test('a SHORT no-results page with the usual reCAPTCHA footer blurb is still "not listed"', async () => {
  // The no-results page is exactly the page that must be allowed to say null; it
  // is short, and many search forms add the Google reCAPTCHA notice to the footer.
  const text = 'Jane Doe - People Search. No records found for this search. Try a different spelling or state. '
    + 'Privacy Terms Contact. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply. '
    + 'Browse by name, address or phone number. '.repeat(6);
  assert.ok(text.length > MIN_PAGE && text.length < 2500, `fixture must be a short real page, is ${text.length} chars`);
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text, textLength: text.length }) }), BROKER), null);
});

test('a short page that tells the visitor to solve a CAPTCHA is a bot wall', async () => {
  const text = 'Please complete the CAPTCHA below to continue to the site. '.repeat(3);
  await unverifiable(makePage({ probe: probeResult({ text, textLength: text.length }) }));
});

// ── navigation failures ──────────────────────────────────────────────────────

test('a navigation timeout throws UNVERIFIABLE and keeps the original error as cause', async () => {
  const original = Object.assign(new Error('page.goto: Timeout 20000ms exceeded at https://www.example.com/search?q=Jane%20Doe'), { name: 'TimeoutError' });
  const err = await unverifiable(makePage({ gotoError: original }));
  assert.equal(err.cause, original);
  assert.ok(err instanceof Error);
});

test('a DNS failure throws UNVERIFIABLE', async () => {
  const original = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.example.com/search?q=Jane%20Doe');
  const err = await unverifiable(makePage({ gotoError: original }));
  assert.match(err.message, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(err.cause, original);
});

test('the error message never carries the searched name (it ends up in logs and reports)', async () => {
  const original = new Error('page.goto: net::ERR_CONNECTION_RESET at https://www.example.com/search?q=Jane%20Doe&state=TX');
  const err = await unverifiable(makePage({ gotoError: original }));
  assert.doesNotMatch(err.message, /Jane|Doe|q=|state=TX/);
});

test('a page that dies during inspection throws UNVERIFIABLE', async () => {
  const original = new Error('page.evaluate: Execution context was destroyed');
  const err = await unverifiable(makePage({ evaluateError: original }));
  assert.equal(err.cause, original);
});

// ── HTTP status ──────────────────────────────────────────────────────────────

for (const status of [301, 400, 401, 403, 404, 410, 429, 451, 500, 502, 503]) {
  test(`HTTP ${status} throws UNVERIFIABLE instead of reading as "not listed"`, async () => {
    const err = await unverifiable(makePage({ status }));
    assert.match(err.message, new RegExp(String(status)));
  });
}

test('a 403 whose body has no listing links is exactly the NET-4 false "verified removed"', async () => {
  await unverifiable(makePage({ status: 403, probe: probeResult({ links: [] }) }));
});

// ── bot walls on a 200 page ─────────────────────────────────────────────────

const WALLS = {
  'Cloudflare "Just a moment..."': { title: 'Just a moment...', text: 'Checking your browser before accessing the site.', textLength: 50 },
  'Cloudflare "Attention Required"': { title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked', textLength: 29 },
  'Cloudflare challenge element': { markers: ['cloudflare-challenge'] },
  'Akamai "Access Denied"': { title: 'Access Denied', text: "You don't have permission to access this server. Reference #18.abc", textLength: 66 },
  '"verify you are human"': { title: 'Example', text: 'Please verify you are human to continue.', textLength: 40 },
  '"verify you are human" on a long page': { text: FILLER + ' Verify you are human before viewing these results.', textLength: FILLER.length + 52 },
  'PerimeterX "Press & Hold"': { markers: ['perimeterx'], text: 'Press & Hold to confirm you are a human', textLength: 40 },
  'DataDome captcha frame': { markers: ['datadome'] },
  'a visible reCAPTCHA challenge': { markers: ['recaptcha'] },
  'a visible hCaptcha challenge': { markers: ['hcaptcha'] },
  'a visible Turnstile challenge': { markers: ['turnstile'] },
  'Incapsula "Request unsuccessful"': { text: 'Request unsuccessful. Incapsula incident ID: 123-456', textLength: 53 },
  'a blank page that rendered nothing': { title: '', text: '', textLength: 0 },
  'a redirect to a captcha path': { url: 'https://www.example.com/captcha?return=%2Fsearch' },
  'a redirect to another site': { url: 'https://geo.captcha-delivery.com/captcha/?initialCid=abc' },
};

for (const [label, overrides] of Object.entries(WALLS)) {
  test(`bot wall: ${label} throws UNVERIFIABLE (200 status, zero listing links)`, async () => {
    await unverifiable(makePage({ probe: probeResult(overrides) }));
  });
}

test('a bot-wall marker beside a real listing link does not hide the listing (weak signal)', async () => {
  const page = makePage({ probe: probeResult({
    markers: ['recaptcha'],
    links: [{ href: 'https://www.example.com/people/jane-doe-9', text: 'Jane Doe' }],
  }) });
  assert.equal(await findListingUrl(page, BROKER), 'https://www.example.com/people/jane-doe-9');
});

test('an interstitial title still wins over listing-looking links (strong signal)', async () => {
  const page = makePage({ probe: probeResult({
    title: 'Just a moment...',
    text: 'Checking your browser',
    textLength: 21,
    links: [{ href: 'https://www.example.com/people/jane-doe-9', text: 'Jane Doe' }],
  }) });
  await unverifiable(page);
});

test('a same-site redirect (www to a subdomain) is not treated as leaving the site', async () => {
  const page = makePage({ probe: probeResult({ url: 'https://search.example.com/results?q=x' }) });
  assert.equal(await findListingUrl(page, BROKER), null);
});

// ── which link is taken ──────────────────────────────────────────────────────

const LOOSE = { ...BROKER, listingPattern: /example\.com/i };

test("the broker's own homepage and nav links are never a listing", async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/', text: 'Home' },
    { href: 'https://www.example.com', text: 'Example' },
    { href: 'https://www.example.com/#top', text: 'Top' },
  ] }) });
  assert.equal(await findListingUrl(page, LOOSE), null);
});

test('a link back to the search page itself is never a listing', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/search?q=Jane%20Doe&state=TX', text: 'Search' },
    { href: 'https://www.example.com/search', text: 'New search' },
  ] }) });
  assert.equal(await findListingUrl(page, LOOSE), null);
});

test('with a last name, the link naming that person wins over an earlier one', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/john-smith-1', text: 'John Smith' },
    { href: 'https://www.example.com/people/jane-doe-2', text: 'Jane Doe' },
  ] }) });
  assert.equal(await findListingUrl(page, BROKER, { lastName: 'Doe' }), 'https://www.example.com/people/jane-doe-2');
});

test('the last name is also taken from the broker object', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/john-smith-1', text: 'John Smith' },
    { href: 'https://www.example.com/people/jane-doe-2', text: 'Jane Doe' },
  ] }) });
  assert.equal(await findListingUrl(page, { ...BROKER, lastName: 'Doe' }), 'https://www.example.com/people/jane-doe-2');
});

test('the last name may appear only in the link text', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/a1', text: 'Mark Lee' },
    { href: 'https://www.example.com/people/b2', text: 'Jane Doe, age 34' },
  ] }) });
  assert.equal(await findListingUrl(page, BROKER, { lastName: 'doe' }), 'https://www.example.com/people/b2');
});

test('a multi-word last name matches its hyphenated slug', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/ann-lee-1', text: 'Ann Lee' },
    { href: 'https://www.example.com/people/maria-de-la-cruz-2', text: 'Maria' },
  ] }) });
  assert.equal(await findListingUrl(page, BROKER, { lastName: 'De La Cruz' }), 'https://www.example.com/people/maria-de-la-cruz-2');
});

test('when no link names the person, the first matching link is still preferred over nothing', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/a1', text: 'View' },
    { href: 'https://www.example.com/people/b2', text: 'View' },
  ] }) });
  assert.equal(await findListingUrl(page, BROKER, { lastName: 'Doe' }), 'https://www.example.com/people/a1');
});

test('without a last name the first matching link is returned (unchanged behaviour)', async () => {
  const page = makePage({ probe: probeResult({ links: [
    { href: 'https://www.example.com/people/a1', text: 'A' },
    { href: 'https://www.example.com/people/b2', text: 'B' },
  ] }) });
  assert.equal(await findListingUrl(page, BROKER), 'https://www.example.com/people/a1');
});

// ── navigation request ───────────────────────────────────────────────────────

test('it navigates to broker.searchUrl with domcontentloaded and a bounded timeout', async () => {
  const page = makePage();
  await findListingUrl(page, BROKER);
  assert.equal(page.seen.goto[0].url, BROKER.searchUrl);
  assert.equal(page.seen.goto[0].opts.waitUntil, 'domcontentloaded');
  assert.ok(page.seen.goto[0].opts.timeout > 0 && page.seen.goto[0].opts.timeout <= 30000);
});

test('the pattern source and flags are handed to the page-side probe', async () => {
  const page = makePage();
  await findListingUrl(page, BROKER);
  assert.equal(page.seen.evaluateArgs.src, BROKER.listingPattern.source);
  assert.equal(page.seen.evaluateArgs.flags, BROKER.listingPattern.flags);
});
