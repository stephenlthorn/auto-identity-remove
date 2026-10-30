/**
 * test/find-listing-url-load.test.js
 *
 * Review finding (verify-loop): "verified clear" came after a fixed 2 s wait and an
 * 80-character page, so a slow single-page app that had not drawn its results yet read
 * as "you are not listed", and the broker was recorded as verified removed.
 * findListingUrl() now waits for a load signal and looks again while the page is
 * still changing before it answers "no listing".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findListingUrl } = require('../lib/forms');

const BROKER = { searchUrl: 'https://example.com/search?q=Jane+Doe', listingPattern: /example\.com\/people\//i };
const LISTING = 'https://example.com/people/jane-doe-1';

const probeOf = (textLength, links = []) => ({
  url: BROKER.searchUrl,
  title: 'People search',
  text: 'Search results. '.repeat(Math.ceil(textLength / 16)).slice(0, textLength),
  textLength,
  markers: [],
  links: links.map((href) => ({ href, text: '' })),
});

/** A page whose successive probes are `probes` (the last one repeats), with a load-state log. */
function makePage(probes, { loadStates = true } = {}) {
  const page = { probes: 0, waited: [], goto: async () => ({ status: () => 200 }) };
  page.evaluate = async () => probes[Math.min(page.probes++, probes.length - 1)];
  if (loadStates) page.waitForLoadState = async (state) => { page.waited.push(state); };
  return page;
}

test('a client-rendered page that draws its results after the first look is not "not listed"', async () => {
  const page = makePage([probeOf(120), probeOf(120, [LISTING])]);
  assert.equal(await findListingUrl(page, BROKER), LISTING);
  assert.ok(page.waited.includes('networkidle') || page.waited.includes('load'), `a load signal was awaited: ${page.waited}`);
});

test('a page that is still growing is looked at again until it stops', async () => {
  const page = makePage([probeOf(100), probeOf(400), probeOf(900, [LISTING])]);
  assert.equal(await findListingUrl(page, BROKER), LISTING);
});

test('a page that settles with no listing is "not listed" (after the extra look)', async () => {
  const page = makePage([probeOf(500), probeOf(500)]);
  assert.equal(await findListingUrl(page, BROKER), null);
  assert.ok(page.probes <= 3, `${page.probes} probes`);
  assert.ok(page.waited.length > 0);
});

test('a page that never stops changing cannot be judged: unverifiable, not "verified clear"', async () => {
  const page = makePage([probeOf(100), probeOf(200), probeOf(300), probeOf(400), probeOf(500), probeOf(600)]);
  await assert.rejects(findListingUrl(page, BROKER), (err) => err.code === 'UNVERIFIABLE' && /still loading/i.test(err.message));
});

test('a load state that times out does not fail the search', async () => {
  const page = makePage([probeOf(500), probeOf(500)]);
  page.waitForLoadState = async () => { throw new Error('Timeout 5000ms exceeded'); };
  assert.equal(await findListingUrl(page, BROKER), null);
});

test('a stub without waitForLoadState still works (the second look is what counts)', async () => {
  const page = makePage([probeOf(120), probeOf(120, [LISTING])], { loadStates: false });
  assert.equal(await findListingUrl(page, BROKER), LISTING);
});

test('a page that already shows a listing is answered at once, with no extra wait', async () => {
  const page = makePage([probeOf(500, [LISTING])]);
  assert.equal(await findListingUrl(page, BROKER), LISTING);
  assert.equal(page.probes, 1);
  assert.deepEqual(page.waited, []);
});
