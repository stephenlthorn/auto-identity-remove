/**
 * test/find-listing-url-evidence.test.js
 *
 * "No listing" is only believed when the page really is a results page for THIS
 * search. radaris.com was transferred by court order: every URL on it answers
 * HTTP 200 with the same notice, which has no listing links, so it used to read as
 * "not listed" for every person. Now:
 *
 *   rule 1  the final URL is on the same registrable domain as the search URL
 *   rule 2  the page text or title contains the searched last name, and the first
 *           name too when it is known (skipped when no last name is known at all)
 *
 * Missing evidence is "could not tell" (UNVERIFIABLE), never null. A found
 * listing is unaffected. A broker may also state its own no-results page with
 * searchNotFound { status, text }: that answer is itself the evidence.
 */

'use strict';

process.env.TURBO = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findListingUrl } = require('../lib/forms');

const PERSON = { lastName: 'Sample' };
const BROKER = {
  name: 'ExampleBroker',
  searchUrl: 'https://www.example.com/p/Jane/Sample/',
  listingPattern: /example\.com\/people\//i,
};
const LISTING = 'https://www.example.com/people/jane-sample-1';

const RESULTS_TEXT = 'Search results for Jane Sample in Texas. Browse records, addresses and phone numbers. '.repeat(10);

const NOTICE_TEXT = (
  'This Domain Has Been Transferred by Court Order. The domain you are trying to reach was transferred '
  + 'to a new owner under an order of the court. The previous operator no longer controls this site and '
  + 'no records are published here. For questions about the transfer please read the notice below and '
  + 'contact the company named in it. Nothing on this page is a search result. '
).repeat(5);

function probeResult(overrides = {}) {
  const text = overrides.text !== undefined ? overrides.text : RESULTS_TEXT;
  return {
    url: BROKER.searchUrl,
    title: 'People search',
    text,
    textLength: text.length,
    markers: [],
    links: [],
    ...overrides,
  };
}

function makePage({ status = 200, probe = probeResult() } = {}) {
  return {
    goto: async () => ({ status: () => status }),
    evaluate: async () => probe,
  };
}

async function couldNotTell(page, broker = BROKER, person = PERSON) {
  try {
    await findListingUrl(page, broker, person);
  } catch (err) {
    assert.equal(err.code, 'UNVERIFIABLE', `${err.code}: ${err.message}`);
    return err;
  }
  return assert.fail('expected UNVERIFIABLE, but findListingUrl returned');
}

test('a results page that echoes the last name and has no listing is "not listed"', async () => {
  assert.equal(await findListingUrl(makePage(), BROKER, PERSON), null);
});

test('rule 2: a realistic "domain transferred" notice (200, ~3500 chars, no name) is could-not-tell', async () => {
  assert.ok(NOTICE_TEXT.length > 1000, 'fixture is page-sized');
  const err = await couldNotTell(makePage({ probe: probeResult({ text: NOTICE_TEXT, title: 'Domain Transferred' }) }));
  assert.match(err.message, /did not show a results page for this search/);
  assert.match(err.message, /example\.com/);
  assert.doesNotMatch(err.message, /Sample|Jane/, 'the message must not carry the person\'s name');
});

test('rule 2: a genuine no-results page that does not echo the name is could-not-tell (the safe direction)', async () => {
  const text = 'No records were found. Try a different spelling or another state. Browse by name, address or phone. '.repeat(3);
  await couldNotTell(makePage({ probe: probeResult({ text }) }));
});

test('rule 2: the last name in the TITLE alone is enough', async () => {
  const page = makePage({ probe: probeResult({ text: 'No records were found. '.repeat(10), title: 'Jane Sample - People Search' }) });
  assert.equal(await findListingUrl(page, BROKER, PERSON), null);
});

test('rule 2: the comparison ignores case, accents and runs of whitespace', async () => {
  const text = 'Resultados para  GARCIA\n\n  MARQUEZ  en Texas. '.repeat(10);
  const page = makePage({ probe: probeResult({ text }) });
  assert.equal(await findListingUrl(page, BROKER, { lastName: 'Garcia   Márquez' }), null);
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text: 'Résultats pour Müller. '.repeat(10) }) }), BROKER, { lastName: 'muller' }), null);
});

test('rule 2: the last name comes from the broker when the person carries none', async () => {
  await couldNotTell(makePage({ probe: probeResult({ text: NOTICE_TEXT }) }), { ...BROKER, lastName: 'Sample' }, {});
  assert.equal(await findListingUrl(makePage(), { ...BROKER, lastName: 'Sample' }, {}), null);
});

test('rule 2 cannot be checked with no last name anywhere, so it is skipped and null stands', async () => {
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text: NOTICE_TEXT }) }), BROKER, {}), null);
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text: NOTICE_TEXT }) }), BROKER), null);
});

test('a found listing is still found even when the page never echoes the name', async () => {
  const page = makePage({ probe: probeResult({ text: NOTICE_TEXT, links: [{ href: LISTING, text: 'J. S.' }] }) });
  assert.equal(await findListingUrl(page, BROKER, PERSON), LISTING);
});

test('rule 1: a redirect to another site is could-not-tell, even with the name on the page', async () => {
  const page = makePage({ probe: probeResult({ url: 'https://parked.example.net/lander?d=example.com' }) });
  await couldNotTell(page);
});

test('rule 1: a redirect to another site is could-not-tell when no last name is known either', async () => {
  const page = makePage({ probe: probeResult({ url: 'https://parked.example.net/lander' }) });
  await couldNotTell(page, BROKER, {});
});

test('rule 1: a redirect to a different company under the same two-part suffix is not "the same site"', async () => {
  const broker = { ...BROKER, searchUrl: 'https://www.people.co.uk/p/Jane/Sample/' };
  const page = makePage({ probe: probeResult({ url: 'https://www.parked.co.uk/lander' }) });
  await couldNotTell(page, broker);
});

test('rule 1: a listing-looking link on a page from another site is not trusted (a parked lander can copy the broker\'s links)', async () => {
  const page = makePage({ probe: probeResult({
    url: 'https://parked.example.net/lander?d=example.com',
    links: [{ href: LISTING, text: 'Jane Sample' }],
  }) });
  await couldNotTell(page);
});

test('rule 1: www and a subdomain on the same registrable domain are the same site', async () => {
  const page = makePage({ probe: probeResult({ url: 'https://search.example.com/results?q=x' }) });
  assert.equal(await findListingUrl(page, BROKER, PERSON), null);
});

// ── searchNotFound: a broker states its own "no results" answer ──────────────

const NOT_FOUND_BROKER = {
  ...BROKER,
  searchNotFound: { status: 404, text: /0 Public Records Found/i },
};
const NOT_FOUND_TEXT = 'Zqxvw Plorkeniz. 0 Public Records Found. Try another search. '.repeat(4);

test('searchNotFound: the stated status with the stated text is "no listing" (null)', async () => {
  const page = makePage({ status: 404, probe: probeResult({ text: NOT_FOUND_TEXT }) });
  assert.equal(await findListingUrl(page, NOT_FOUND_BROKER, PERSON), null);
});

test('searchNotFound: the text match is the evidence, so the last name is not also required', async () => {
  const page = makePage({ status: 404, probe: probeResult({ text: '0 Public Records Found' }) });
  assert.equal(await findListingUrl(page, NOT_FOUND_BROKER, PERSON), null);
});

test('searchNotFound: the stated status with other text is could-not-tell', async () => {
  const page = makePage({ status: 404, probe: probeResult({ text: 'Page not found. The link may be broken.' }) });
  const err = await couldNotTell(page, NOT_FOUND_BROKER);
  assert.match(err.message, /HTTP 404/);
});

test('searchNotFound: a different status with the stated text is could-not-tell', async () => {
  for (const status of [403, 410, 500, 503]) {
    const page = makePage({ status, probe: probeResult({ text: NOT_FOUND_TEXT }) });
    await couldNotTell(page, NOT_FOUND_BROKER);
  }
});

test('searchNotFound: a 200 notice page that merely has no name on it still needs the normal evidence', async () => {
  const page = makePage({ status: 200, probe: probeResult({ text: NOTICE_TEXT }) });
  await couldNotTell(page, NOT_FOUND_BROKER);
});

test('searchNotFound: a 200 results page with a listing is found as usual', async () => {
  const page = makePage({ probe: probeResult({ links: [{ href: LISTING, text: 'Jane Sample' }] }) });
  assert.equal(await findListingUrl(page, NOT_FOUND_BROKER, PERSON), LISTING);
});

test('without searchNotFound a 404 stays could-not-tell exactly as before', async () => {
  const page = makePage({ status: 404, probe: probeResult({ text: NOT_FOUND_TEXT }) });
  const err = await couldNotTell(page, BROKER);
  assert.match(err.message, /HTTP 404/);
});

// A last name can be an ordinary word. The real radaris.com notice reads "Superior
// Court of New Jersey, Law Division": for someone called Law, rule 2 on the last name
// alone would have believed that notice was their results page.
const COURT_NOTICE = (
  'This Domain Has Been Transferred by Court Order. Superior Court of New Jersey, Law Division, '
  + 'Middlesex County. Pursuant to a final judgment the domain name has been transferred and is no '
  + 'longer under the control of its former operators. Nothing on this page is a search result. '
).repeat(5);

test('rule 2: a notice that happens to contain the last name as a word is could-not-tell when the first name is missing', async () => {
  const person = { firstName: 'Jude', lastName: 'Law' };
  const err = await couldNotTell(makePage({ probe: probeResult({ text: COURT_NOTICE, title: 'Domain Transferred' }) }), BROKER, person);
  assert.match(err.message, /did not show a results page for this search/);
  assert.doesNotMatch(err.message, /Jude|Law/, 'the message must not carry the person\'s name');
});

test('rule 2: a results page that echoes the first and the last name is "not listed"', async () => {
  const person = { firstName: 'Jude', lastName: 'Law' };
  const text = 'No results for Jude Law in Texas. Try a different spelling or another state. '.repeat(6);
  assert.equal(await findListingUrl(makePage({ probe: probeResult({ text }) }), BROKER, person), null);
});

test('rule 2: with a first name known, the last name alone is not enough', async () => {
  const person = { firstName: 'Jude', lastName: 'Sample' };
  await couldNotTell(makePage({ probe: probeResult({ text: 'Records for the Sample family across Texas. '.repeat(10) }) }), BROKER, person);
});
