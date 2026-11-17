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

// ---------------------------------------------------------------------------
// Search steps and how they were validated (roadmap F2).
//
// A pattern that wrongly says "found" only causes a submission that would have
// happened anyway. A pattern that wrongly says "not found" makes `aidr run
// --found-only` skip a broker that really lists the person. So a search step is
// only added after it has been seen to work in BOTH directions on the live site
// (a very common name must give a matching link; a nonsense name must load a
// normal results page with none), and it carries searchCheckedAt to say when.
// ---------------------------------------------------------------------------

// These five search steps predate the validation rule. Each was re-checked on
// 2026-11-17 and could NOT be validated (a bot wall answered every request), so
// they stay as they were and are listed here on purpose. Radaris was on this list
// until its domain was transferred by court order and the entry was removed.
// A broker not in this list and without searchCheckedAt fails the test below.
const LEGACY_UNVALIDATED = ['Spokeo', 'WhitePages', 'FastPeopleSearch', 'MyLife', 'Nuwber'];

// A realistically shaped result link for each validated broker, taken from the
// live results page shape (made-up id). The per-broker tests below start running
// as soon as a validated search step is added. USPhonebook passed both directions
// live on 2026-11-17 (a common name gave person links; a nonsense name gave its 404).
const LISTING_EXAMPLES = {
  USPhonebook: 'https://www.usphonebook.com/jane-doe/U4ab12cd34ef56gh78ij',
};

const withSearchStep = list.filter(b => b.searchUrl && b.listingPattern);
const validated = withSearchStep.filter(b => b.searchCheckedAt);

test('every search step is either validated live (searchCheckedAt) or on the explicit legacy list', () => {
  for (const broker of withSearchStep) {
    if (broker.searchCheckedAt) continue;
    assert.ok(LEGACY_UNVALIDATED.includes(broker.name),
      `${broker.name} has a search step but no searchCheckedAt: validate it live in both directions first`);
  }
});

test('searchCheckedAt is an ISO date and never sits on a broker without a search step', () => {
  for (const broker of list.filter(b => b.searchCheckedAt)) {
    assert.match(broker.searchCheckedAt, /^\d{4}-\d{2}-\d{2}$/, broker.name);
    assert.ok(broker.searchUrl && broker.listingPattern, `${broker.name} has searchCheckedAt but no search step`);
  }
});

for (const broker of validated) {
  test(`${broker.name}: has a listing example and the pattern matches it`, () => {
    const example = LISTING_EXAMPLES[broker.name];
    assert.ok(example, `add a realistic listing URL for ${broker.name} to LISTING_EXAMPLES`);
    assert.equal(broker.listingPattern.test(example), true, `${broker.listingPattern} must match ${example}`);
  });

  test(`${broker.name}: the pattern does not match its own search page, for any person`, () => {
    const other = brokers.forPerson({ ...PERSON, firstName: 'Mary Ann', lastName: "O'Neil", fullName: "Mary Ann O'Neil", state: 'NC' });
    for (const b of [broker, other.find(x => x.name === broker.name)]) {
      assert.equal(b.listingPattern.test(b.searchUrl), false, `${b.listingPattern} matches ${b.searchUrl}`);
    }
  });

  test(`${broker.name}: the pattern does not match the homepage`, () => {
    for (const home of homepages(broker.searchUrl)) {
      assert.equal(broker.listingPattern.test(home), false, `${broker.listingPattern} matches ${home}`);
    }
  });

  test(`${broker.name}: the pattern has no global or sticky flag (RegExp.test would keep state)`, () => {
    assert.doesNotMatch(broker.listingPattern.flags, /[gy]/);
  });
}
