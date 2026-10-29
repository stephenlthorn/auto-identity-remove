/**
 * test/field-resolver-negation.test.js
 *
 * BRK-8 added :not([name*="first" i]) guards to the full-name selectors in
 * brokers.js so they cannot match firstname/lastname/company_name. When such a
 * selector misses, forms.js hands it to the semantic resolver, and
 * deriveIntent() reads every attribute VALUE in the selector. Without ignoring
 * what sits inside :not(...), the "first" in :not([name*="first" i]) made the
 * intent firstName, so the person's FULL name was typed into the first-name
 * box by the very fallback meant to rescue the miss.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deriveIntent } = require('../lib/field-resolver');

const NOT_PERSON_NAME = [
  'first', 'last', 'fname', 'lname', 'surname', 'family', 'given', 'middle',
  'user', 'nick', 'company', 'business', 'organi', 'file', 'maiden',
].map(w => `:not([name*="${w}" i])`).join('');

test('a full-name selector guarded by :not(first/last/...) is still a full-name intent', () => {
  assert.equal(deriveIntent(`input[name*="name" i]${NOT_PERSON_NAME}`, 'Jane Doe'), 'fullName');
});

test('the :not() values do not change the intent of a first-name selector either', () => {
  assert.equal(deriveIntent('input[name*="first" i]:not([name*="last" i])', 'Jane'), 'firstName');
});

test('an email selector excluding confirm fields is still an email intent', () => {
  assert.equal(deriveIntent('input[name*="email" i]:not([name*="confirm" i])', 'jane@example.com'), 'email');
});

test('a selector that only excludes email is not read as an email intent', () => {
  assert.equal(deriveIntent('input[name*="name" i]:not([type="email"])', 'Jane Doe'), 'fullName');
});

test('selectors without :not() keep their existing intent', () => {
  assert.equal(deriveIntent('input[name*="phone" i]', '5125550000'), 'phone');
  assert.equal(deriveIntent('input[name*="zip" i]', '73301'), 'zip');
});
