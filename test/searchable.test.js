'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canSearch } = require('../lib/searchable');

const pattern = /example\.com\/listing\/\d+/i;

test('canSearch: a search-form broker with a search page and a listing pattern', () => {
  assert.equal(canSearch({ method: 'search-form', searchUrl: 'https://a.example/s', listingPattern: pattern }), true);
});

test('canSearch: a direct-form broker with a search step can be searched too', () => {
  assert.equal(canSearch({ method: 'direct-form', searchUrl: 'https://a.example/s', listingPattern: pattern }), true);
});

test('canSearch: needs both halves of the search step', () => {
  assert.equal(canSearch({ method: 'direct-form', searchUrl: 'https://a.example/s' }), false);
  assert.equal(canSearch({ method: 'direct-form', listingPattern: pattern }), false);
  assert.equal(canSearch({ method: 'search-form', searchUrl: '', listingPattern: pattern }), false);
});

test('canSearch: email and manual brokers are not searchable, and junk is false', () => {
  assert.equal(canSearch({ method: 'email', optOutEmail: 'x@example.com' }), false);
  assert.equal(canSearch(null), false);
  assert.equal(canSearch(undefined), false);
  assert.equal(canSearch({}), false);
});
