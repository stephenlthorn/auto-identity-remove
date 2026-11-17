/**
 * test/search-step-direct-form.test.js
 *
 * A direct-form broker may carry searchUrl + listingPattern so `aidr scan` can
 * tell whether the person is listed. That must not change its opt-out: the
 * runner only looks a listing up for method 'search-form', so a direct-form
 * broker still goes straight to optOutUrl and never calls findListingUrl.
 * The other readers of searchUrl all prefer optOutUrl, so the host they derive
 * stays the same.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const brokers = require('../brokers');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');

// A fixture first, so the rule is pinned even while no real direct-form broker
// has a search step; then every real one that gains a search step.
const FIXTURE = {
  name: 'DirectWithSearch',
  method: 'direct-form',
  optOutUrl: 'https://www.example.com/removal',
  searchUrl: 'https://www.example.com/jane-sample/texas',
  listingPattern: /example\.com\/[a-z-]+\/U[A-Za-z0-9]{15,}/,
  searchCheckedAt: '2026-11-17',
  formFields: {},
  submitSelector: 'button[type="submit"]',
};
const directWithSearch = [
  FIXTURE,
  ...brokers.forPerson(PERSON).filter(b => b.method === 'direct-form' && b.searchUrl),
];

for (const broker of directWithSearch) {
  test(`${broker.name}: opt-out still goes to optOutUrl and never runs the listing lookup`, async () => {
    const h = loadRunner();
    h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
    const page = makePage({ before: 'Opt out of this site', after: 'Your request has been received.' });

    await h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON);

    assert.equal(h.calls.findListingUrl.length, 0, 'findListingUrl is for search-form brokers only');
    assert.equal(page.gotos[0].url, broker.optOutUrl);
  });

  test(`${broker.name}: the host other readers derive (optOutUrl first) is the same site as the search page`, () => {
    const host = (u) => new URL(u).hostname.replace(/^www\./, '');
    assert.equal(host(broker.optOutUrl), host(broker.searchUrl));
  });
}
