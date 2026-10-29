/**
 * test/brokers-listing-patterns.test.js
 *
 * BRK-9: BeenVerified's listingPattern was /beenverified\.com/, which matches
 * its own homepage and every nav link. findListingUrl() therefore always "found
 * a listing" (the logo link), so the runner never learned whether the person was
 * listed and --verify could never report anything but "still listed".
 *
 * Its searchUrl is the opt-out SEARCH FORM, a page with no person-specific
 * links at all, so tightening the pattern alone would flip that to "never
 * listed" (runner skips the opt-out, verify reports "verified clear"). The
 * honest model is a direct form: the page IS the form, nothing to look up
 * first, and --verify reports it unverifiable.
 *
 * These are structural invariants over every explicit broker.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const brokers = require('../brokers');

const PERSON = {
  firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe',
  email: 'jane@example.com', city: 'Austin', state: 'TX', zip: '73301', country: 'US',
};
const list = brokers.forPerson(PERSON);

const searchable = list.filter(b => b.method === 'search-form' && b.listingPattern);

function homepages(url) {
  const { hostname } = new URL(url);
  const bare = hostname.replace(/^www\./, '');
  return [`https://${hostname}/`, `https://${bare}/`, `https://www.${bare}/`, `https://www.${bare}`];
}

test('there are search-form brokers to check (guards the loop below against an empty list)', () => {
  assert.ok(searchable.length >= 5);
});

for (const broker of searchable) {
  test(`${broker.name}: listingPattern does not match the broker's own homepage`, () => {
    for (const home of homepages(broker.searchUrl)) {
      assert.equal(broker.listingPattern.test(home), false, `${broker.listingPattern} matches ${home}`);
    }
  });

  test(`${broker.name}: searchUrl is a results page, not the opt-out form`, () => {
    assert.notEqual(broker.searchUrl, broker.optOutUrl, 'a form page has no listing links to find');
  });
}

test('every listingPattern requires a path segment after the host', () => {
  for (const broker of searchable) {
    assert.match(broker.listingPattern.source, /\\\//, `${broker.name}: ${broker.listingPattern} has no path part`);
  }
});

test('BeenVerified is a direct form (its search page is the opt-out form)', () => {
  const bv = list.find(b => b.name === 'BeenVerified');
  assert.equal(bv.method, 'direct-form');
  assert.equal(bv.listingPattern, undefined);
  assert.equal(bv.searchUrl, undefined);
  assert.ok(bv.formFields['input[name="firstName"]'] !== undefined, 'its form fields are untouched');
});

test('search-form brokers carry the last name so the listing choice can prefer that person', () => {
  for (const broker of searchable) {
    assert.equal(broker.lastName, 'Doe', `${broker.name} should expose lastName`);
  }
});
