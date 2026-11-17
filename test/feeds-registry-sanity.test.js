/**
 * test/feeds-registry-sanity.test.js
 *
 * D10 of the 2.1 review: a registry file that parses but is wrong must not be
 * reported as a success. A rights cell that is prose falls back to the website; a
 * file cut off by a stray quote, or one that shrank to a fraction of the earlier
 * list, counts as that registry FAILING for this run (the earlier rows are kept).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const feeds = require('../lib/feeds');
const { caCsv } = require('./helpers/ca-registry-fixture');

const CA_URL = 'https://ca.test/registry.csv';
const NOW = new Date('2026-11-17T12:00:00Z');
const stubFetch = (body) => async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => body,
});
const row = (id, name, website, rights = '') => [id, name, '', website, 'x@x.example', '', '1 St', 'Town', 'CA', '90000', 'UNITED STATES', rights];
const many = (n) => Array.from({ length: n }, (_, i) => row(String(i), `Broker ${i}`, `broker-${i}.example`));

test('a rights cell with whitespace or more than one URL is ignored and the website is used', () => {
  const header = {
    'data broker name': 'Acme',
    'data broker primary website': 'acme-data.example',
  };
  const key = "data broker's primary website that contains details on how consumers can exercise their ca consumer privacy rights";
  const pick = (rights) => feeds.normalizeFeedRow({ ...header, [key]: rights }, 'ca').optOutUrl;
  assert.equal(pick('https://x.example/privacy or email privacy@x.example'), 'https://acme-data.example');
  assert.equal(pick('https://x.example/a b'), 'https://acme-data.example');
  assert.equal(pick('ftp://x.example/privacy'), 'https://acme-data.example');
  assert.equal(pick('see our website'), 'https://acme-data.example');
  assert.equal(pick(' https://x.example/privacy '), 'https://x.example/privacy', 'surrounding spaces are only padding');
});

test('a quote left open in the middle of the file makes California fail, and the earlier rows are kept', async () => {
  const csv = caCsv(many(4)).replace('Broker 1', '"Broker 1');
  const previous = {
    brokers: [{ name: 'Old', optOutUrl: 'https://old.example/optout', source: 'ca', registries: ['CA'] }],
    registryHosts: { 'old.example': ['CA'] },
    registries: { CA: { ok: true, count: 4, knownCount: 4 } },
  };
  const out = await feeds.buildFeedsFile({ fetchImpl: stubFetch(csv), caUrl: CA_URL, now: NOW, explicitHosts: [], previous });
  assert.equal(out.registries.CA.ok, false);
  assert.match(out.registries.CA.error, /quote/i);
  assert.equal(out.registries.CA.carriedOver, true);
  assert.deepEqual(out.brokers.map(b => b.name), ['Old']);
});

test('a registry that shrank below half of the earlier list fails; half or more is fine', async () => {
  const previous = {
    brokers: [{ name: 'Old', optOutUrl: 'https://old.example/optout', source: 'ca', registries: ['CA'] }],
    registryHosts: { 'old.example': ['CA'] },
    registries: { CA: { ok: true, count: 400, knownCount: 400 } },
  };
  const run = (n) => feeds.buildFeedsFile({ fetchImpl: stubFetch(caCsv(many(n))), caUrl: CA_URL, now: NOW, explicitHosts: [], previous });

  const small = await run(150);
  assert.equal(small.registries.CA.ok, false);
  assert.match(small.registries.CA.error, /150/);
  assert.match(small.registries.CA.error, /400/);
  assert.equal(small.registries.CA.carriedOver, true);
  assert.equal(small.registries.CA.knownCount, 400, 'the earlier count is kept');
  assert.deepEqual(small.brokers.map(b => b.name), ['Old']);

  const half = await run(200);
  assert.equal(half.registries.CA.ok, true, 'exactly half is not "less than half"');
  assert.equal(half.registries.CA.count, 200);
});

function withoutOverride(fn) {
  const saved = process.env.CA_REGISTRY_URL;
  delete process.env.CA_REGISTRY_URL;
  return Promise.resolve(fn()).finally(() => { if (saved !== undefined) process.env.CA_REGISTRY_URL = saved; });
}

test('with no earlier file, a California count under 100 is a failure on the real URL', () => withoutOverride(async () => {
  const run = (n) => feeds.buildFeedsFile({ fetchImpl: stubFetch(caCsv(many(n))), now: NOW, explicitHosts: [] });
  const small = await run(3);
  assert.equal(small.registries.CA.ok, false);
  assert.match(small.registries.CA.error, /3/);
  assert.match(small.registries.CA.error, /several hundred|100/);
  assert.equal(small.brokers.length, 0);
  assert.equal((await run(100)).registries.CA.ok, true);
}));

test('the under-100 rule is off when the registry URL is overridden, by option or by environment', () => withoutOverride(async () => {
  const csv = caCsv(many(3));
  const byOption = await feeds.buildFeedsFile({ fetchImpl: stubFetch(csv), caUrl: CA_URL, now: NOW, explicitHosts: [] });
  assert.equal(byOption.registries.CA.ok, true);

  process.env.CA_REGISTRY_URL = 'https://ca.test/other.csv';
  try {
    const byEnv = await feeds.buildFeedsFile({ fetchImpl: stubFetch(csv), now: NOW, explicitHosts: [] });
    assert.equal(byEnv.registries.CA.ok, true);
  } finally {
    delete process.env.CA_REGISTRY_URL;
  }
}));
