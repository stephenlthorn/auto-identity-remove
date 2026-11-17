/**
 * test/domains.test.js
 *
 * lib/domains.js is the one answer to "which company's domain is this host?". The
 * search step's off-site rule and the broker health check each grew their own copy
 * with a different rule for country suffixes; these tests pin the union of the two,
 * so every caller agrees on what "the same site" means.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const domains = require('../lib/domains');

test('a listed multi-part suffix keeps three labels', () => {
  assert.equal(domains.registrableDomain('privacy.shop.ukdata.co.uk'), 'ukdata.co.uk');
  assert.equal(domains.registrableDomain('www.acme.com.au'), 'acme.com.au');
});

test('a country suffix that is not on the list still keeps three labels', () => {
  // The list cannot name every registry. A two-letter country code under a
  // generic second-level label (co, com, org, net, gov, edu, ac) is a suffix too:
  // without this, two unrelated .co.kr sites would read as one site.
  assert.equal(domains.registrableDomain('www.acme.co.kr'), 'acme.co.kr');
  assert.equal(domains.registrableDomain('people.acme.com.sg'), 'acme.com.sg');
  assert.notEqual(domains.registrableDomain('a.co.kr'), domains.registrableDomain('b.co.kr'));
});

test('an ordinary two-letter country domain keeps two labels', () => {
  assert.equal(domains.registrableDomain('www.acme.de'), 'acme.de');
  assert.equal(domains.registrableDomain('search.acme.io'), 'acme.io');
});

test('a bare country suffix names no company', () => {
  assert.equal(domains.isPublicSuffix('co.kr'), true);
  assert.equal(domains.isPublicSuffix('com.sg'), true);
  assert.equal(domains.isPublicSuffix('co.uk'), true);
  assert.equal(domains.isPublicSuffix('acme.co.kr'), false);
  assert.equal(domains.isPublicSuffix('acme.de'), false);
  assert.equal(domains.isCoverableDomain('co.kr'), false);
});

test('an IP address or a bare host name is its own domain', () => {
  // The fixture servers in the test suite run on 127.0.0.1: reducing that to "0.1"
  // would make two different addresses the same site.
  assert.equal(domains.registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.notEqual(domains.registrableDomain('127.0.0.1'), domains.registrableDomain('10.0.0.1'));
  assert.equal(domains.registrableDomain('localhost'), 'localhost');
  assert.equal(domains.registrableDomain('[::1]'), '[::1]');
});

test('nothing at all is the empty string', () => {
  assert.equal(domains.registrableDomain(''), '');
  assert.equal(domains.registrableDomain(null), '');
});
