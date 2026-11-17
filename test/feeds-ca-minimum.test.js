/**
 * test/feeds-ca-minimum.test.js
 *
 * With no earlier count to compare against, a California file from the real registry URL
 * must hold at least 100 brokers. The edge is exact: 99 is a cut-off file, 100 is a registry.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const feeds = require('../lib/feeds');
const { caCsv } = require('./helpers/ca-registry-fixture');

const stubFetch = (body) => async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => body,
});
const row = (i) => [String(i), `Broker ${i}`, '', `broker-${i}.example`, 'x@x.example', '', '1 St', 'Town', 'CA', '90000', 'UNITED STATES', ''];
const build = async (n) => {
  const saved = process.env.CA_REGISTRY_URL;
  delete process.env.CA_REGISTRY_URL;
  try {
    return await feeds.buildFeedsFile({
      fetchImpl: stubFetch(caCsv(Array.from({ length: n }, (_, i) => row(i)))),
      now: new Date('2026-11-17T12:00:00Z'),
      explicitHosts: [],
      previous: null,
    });
  } finally {
    if (saved !== undefined) process.env.CA_REGISTRY_URL = saved;
  }
};

test('99 brokers from the real URL with no earlier count is refused', async () => {
  const out = await build(99);
  assert.equal(out.registries.CA.ok, false);
  assert.match(out.registries.CA.error, /99/);
});

test('100 brokers from the real URL is accepted', async () => {
  const out = await build(100);
  assert.equal(out.registries.CA.ok, true);
  assert.equal(out.registries.CA.count, 100);
});
