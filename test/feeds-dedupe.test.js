/**
 * test/feeds-dedupe.test.js
 *
 * Unit tests for dedupeFeedBrokers - registrable-domain dedup of normalized
 * feed brokers against the explicit brokers.js hosts and against each other.
 * Pure, no network, no file I/O.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { dedupeFeedBrokers } = require('../lib/feeds');

function entry(name, url) {
  return { name, optOutUrl: url, method: 'manual', source: 'ca' };
}

test('dedupeFeedBrokers drops a feed broker whose host matches an explicit host', () => {
  const feed = [entry('Spokeo', 'https://www.spokeo.com/opt_out')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com']);
  assert.equal(out.length, 0);
});

test('dedupeFeedBrokers keeps a feed broker whose host is not in the explicit set', () => {
  const feed = [entry('Acme', 'https://acme.example.com/opt-out')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com', 'beenverified.com']);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme');
});

test('dedupeFeedBrokers strips www. when comparing hosts (reuses serp-scan hostnameOf)', () => {
  const feed = [entry('Spokeo WWW', 'https://www.spokeo.com/optout')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com']);
  assert.equal(out.length, 0);
});

test('dedupeFeedBrokers dedups duplicate feed entries against each other by host', () => {
  const feed = [
    entry('Acme One', 'https://acme.example.com/opt-out'),
    entry('Acme Two', 'https://acme.example.com/do-not-sell'),
  ];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme One');
});

test('dedupeFeedBrokers keeps name-only rows with no parseable host', () => {
  const feed = [
    { name: 'Nameonly A', optOutUrl: '', method: 'manual', source: 'vt' },
    { name: 'Nameonly B', optOutUrl: '', method: 'manual', source: 'vt' },
  ];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 2);
});

test('dedupeFeedBrokers accepts a Set or array for explicitHosts', () => {
  const feed = [entry('Acme', 'https://acme.example.com/opt-out')];
  const fromSet = dedupeFeedBrokers(feed, new Set(['acme.example.com']));
  assert.equal(fromSet.length, 0);
  const fromArr = dedupeFeedBrokers(feed, ['acme.example.com']);
  assert.equal(fromArr.length, 0);
});

test('dedupeFeedBrokers tolerates null/undefined entries', () => {
  const feed = [null, entry('Acme', 'https://acme.example.com/opt-out'), undefined];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme');
});
