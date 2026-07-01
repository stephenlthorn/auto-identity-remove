/**
 * test/find-listing-url.test.js
 *
 * Unit tests for findListingUrl() in lib/forms.js.
 *
 * Uses a Playwright page stub — no real browser. Verifies that:
 *   1. Links matching listingPattern are returned
 *   2. waitUntil:'domcontentloaded' is requested (P4: avoid full networkidle waits on tracker-heavy sites)
 *   3. Returns null when no link matches
 *   4. Returns first match when multiple links match
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findListingUrl } = require('../lib/forms');

function makePage(links = [], gotoOptions = {}) {
  const captured = {};
  return {
    goto: async (url, opts) => {
      captured.url = url;
      captured.opts = opts;
    },
    evaluate: async (fn, args) => {
      // findListingUrl now passes { src, flags } so that regex flags (e.g. 'i') are
      // preserved inside page.evaluate. The stub mirrors that interface.
      const re = new RegExp(args.src, args.flags);
      return links.filter(h => re.test(h));
    },
    _captured: captured,
  };
}

const BROKER = {
  searchUrl: 'https://example.com/search?q=Jane+Doe',
  listingPattern: /example\.com\/people\//i,
};

test('returns first matching link', async () => {
  const page = makePage([
    'https://example.com/people/jane-doe-123',
    'https://example.com/people/jane-doe-456',
  ]);
  const result = await findListingUrl(page, BROKER);
  assert.equal(result, 'https://example.com/people/jane-doe-123');
});

test('returns null when no link matches the pattern', async () => {
  const page = makePage([
    'https://example.com/other/jane-doe',
    'https://example.com/contact',
  ]);
  const result = await findListingUrl(page, BROKER);
  assert.equal(result, null);
});

test('returns null when page has no links', async () => {
  const page = makePage([]);
  const result = await findListingUrl(page, BROKER);
  assert.equal(result, null);
});

test('uses domcontentloaded waitUntil (P4: not networkidle)', async () => {
  const page = makePage([]);
  await findListingUrl(page, BROKER);
  assert.equal(
    page._captured.opts?.waitUntil,
    'domcontentloaded',
    `expected waitUntil:'domcontentloaded', got: ${page._captured.opts?.waitUntil}`
  );
});

test('navigates to broker searchUrl', async () => {
  const page = makePage([]);
  await findListingUrl(page, BROKER);
  assert.equal(page._captured.url, BROKER.searchUrl);
});
