/**
 * test/us-states.test.js
 *
 * USPhonebook's search page lives at /<first>-<last>/<state-slug>. These helpers
 * build the two slugs. A state that is not a US state has no slug: the broker then
 * gets no search URL for that person, so it cannot be searched for them.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stateSlug, nameSlug } = require('../brokers');

test('a two-letter code becomes the lower-case state slug', () => {
  assert.equal(stateSlug('CA'), 'california');
  assert.equal(stateSlug('tx'), 'texas');
  assert.equal(stateSlug(' nc '), 'north-carolina');
});

test('a full state name becomes a hyphenated slug, whatever its case or spacing', () => {
  assert.equal(stateSlug('New York'), 'new-york');
  assert.equal(stateSlug('north   dakota'), 'north-dakota');
  assert.equal(stateSlug('WEST VIRGINIA'), 'west-virginia');
});

test('all fifty states resolve, and every slug is unique', () => {
  const codes = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
  assert.equal(codes.length, 50);
  const slugs = codes.map(stateSlug);
  assert.ok(slugs.every(Boolean));
  assert.equal(new Set(slugs).size, 50);
});

test('anything that is not a US state has no slug', () => {
  for (const value of ['', undefined, null, 'ON', 'Ontario', 'Bavaria', 'ZZ', 'Narnia', 'U.S.']) {
    assert.equal(stateSlug(value), '', String(value));
  }
});

test('nameSlug lower-cases, turns spaces into hyphens and drops everything outside a-z, 0-9 and hyphen', () => {
  assert.equal(nameSlug('John Smith'), 'john-smith');
  assert.equal(nameSlug("Mary Ann O'Neil"), 'mary-ann-oneil');
  assert.equal(nameSlug('  Jane   Doe  '), 'jane-doe');
  assert.equal(nameSlug('Jean-Luc Picard Jr.'), 'jean-luc-picard-jr');
});

test('nameSlug of nothing usable is empty, and accents are dropped, not transliterated', () => {
  assert.equal(nameSlug(''), '');
  assert.equal(nameSlug(undefined), '');
  assert.equal(nameSlug('***'), '');
  assert.equal(nameSlug('Zoë'), 'zo');
});
