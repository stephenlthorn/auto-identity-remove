/**
 * test/drop-coverage.test.js
 *
 * D1 of the 2.1 review: DROP coverage must never be inferred from a shared form
 * platform, a bare public suffix or a rights-page host. The registry hosts are the
 * registrable domains of each broker's PRIMARY WEBSITE, and one function decides
 * "covered" for both the generic pass and the complaint finder.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const domains = require('../lib/domains');
const drop = require('../lib/drop');
const feeds = require('../lib/feeds');
const complaint = require('../lib/complaint');
const { caCsv } = require('./helpers/ca-registry-fixture');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', country: 'US' };
const RECORDED = { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
const CA_URL = 'https://ca.test/registry.csv';
const NOW = new Date('2026-11-17T12:00:00Z');

const stubFetch = (body) => async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => body,
});

// row: [id, name, dba, website, email, phone, street, city, state, zip, country, rightsUrl]
const row = (id, name, website, rights) => [id, name, '', website, 'x@x.example', '', '1 St', 'Town', 'CA', '90000', 'UNITED STATES', rights];

const REGISTRY_ROWS = [
  row('1', 'Acme Data Co', 'www.acme-data.example', 'https://privacyportal.onetrust.com/webform/abc/def'),
  row('2', 'Docs Co', 'docsco.example', 'https://docs.google.com/forms/d/xyz'),
  row('3', 'UK Data', 'https://www.ukdata.co.uk/', 'https://www.ukdata.co.uk/privacy'),
  row('4', 'Bare Suffix', 'co.uk', ''),
];

test('lib/domains: registrable domains know multi-part suffixes, shared platforms and public suffixes', () => {
  assert.equal(domains.registrableDomain('privacy.shop.ukdata.co.uk'), 'ukdata.co.uk');
  assert.equal(domains.registrableDomain('www.acme.example'), 'acme.example');
  assert.equal(domains.registrableDomain('co.uk'), 'co.uk');
  assert.equal(domains.isPublicSuffix('co.uk'), true);
  assert.equal(domains.isPublicSuffix('com'), true);
  assert.equal(domains.isPublicSuffix('ukdata.co.uk'), false);
  assert.equal(domains.isSharedPlatformHost('privacyportal.onetrust.com'), true);
  assert.equal(domains.isSharedPlatformHost('docs.google.com'), true);
  assert.equal(domains.isSharedPlatformHost('www.acme.example'), false);
});

test('update-brokers writes only primary-website registrable domains into registryHosts', async () => {
  const out = await feeds.buildFeedsFile({
    fetchImpl: stubFetch(caCsv(REGISTRY_ROWS)), caUrl: CA_URL, now: NOW, explicitHosts: [],
  });
  assert.deepEqual(out.registryHosts, {
    'acme-data.example': ['CA'],
    'docsco.example': ['CA'],
    'ukdata.co.uk': ['CA'],
  });
});

test('a registry file that holds shared platforms or a public suffix covers nothing on them', () => {
  const registryHosts = { 'onetrust.com': ['CA'], 'google.com': ['CA'], 'co.uk': ['CA'], 'ukdata.co.uk': ['CA'] };
  const fn = drop.makeCoveredByDrop({ person: JANE, state: RECORDED, config: {}, registryHosts });
  assert.equal(fn({ name: 'X', url: 'https://privacyportal.onetrust.com/webform/q' }), null);
  assert.equal(fn({ name: 'Y', url: 'https://docs.google.com/forms/d/q' }), null);
  assert.equal(fn({ name: 'Z', url: 'https://unrelated.co.uk/optout' }), null);
  assert.match(fn({ name: 'UK', url: 'https://shop.ukdata.co.uk/optout' }), /covered by your DROP request/);
});

test('a row is covered by its own registries field, even on a shared platform', () => {
  const fn = drop.makeCoveredByDrop({ person: JANE, state: RECORDED, config: {}, registryHosts: { 'acme-data.example': ['CA'] } });
  const onPlatform = 'https://privacyportal.onetrust.com/webform/abc/def';
  assert.match(fn({ name: 'Acme', url: onPlatform, registries: ['CA', 'VT'] }), /covered/);
  assert.equal(fn({ name: 'Acme', url: onPlatform, registries: ['VT'] }), null, 'a Vermont-only row is not California');
  assert.equal(fn({ name: 'Bundled', url: onPlatform }), null, 'no registries field and a shared platform: submitted');
  assert.match(fn({ name: 'Own site', url: 'https://www.acme-data.example/optout' }), /covered/);
});

test('isCoveredByDrop on a shared platform host is false, on a primary website (any subdomain) true', () => {
  const registryHosts = { 'acme-data.example': ['CA'], 'google.com': ['CA'] };
  const covered = (host) => drop.isCoveredByDrop({ person: JANE, state: RECORDED, config: {}, host, registryHosts });
  assert.equal(covered('docs.google.com'), false);
  assert.equal(covered('privacy.www.acme-data.example'), true);
  assert.equal(covered('https://www.acme-data.example/optout'), true);
});

test('findDropOverdue uses the same rule: a shared platform page is never "registered"', () => {
  const now = new Date('2026-12-05T12:00:00Z');
  const state = {
    ...RECORDED,
    optOuts: {
      'Docs Broker|Jane Sample': { lastSuccess: '2026-09-02T00:00:00Z', verifiedStillListedAt: '2026-12-02T10:00:00Z' },
      'Acme Data|Jane Sample': { lastSuccess: '2026-09-02T00:00:00Z', verifiedStillListedAt: '2026-12-02T10:00:00Z' },
    },
  };
  const urls = { 'Docs Broker': 'https://docs.google.com/forms/d/q', 'Acme Data': 'https://www.acme-data.example/optout' };
  const out = complaint.findDropOverdue(state, {
    persons: [JANE], now,
    registryHosts: { 'google.com': ['CA'], 'acme-data.example': ['CA'] },
    hostFor: (name) => urls[name],
  });
  assert.deepEqual(out.map(r => r.broker), ['Acme Data']);
});

test('three registry brokers on one form platform all survive update-brokers (D5)', async () => {
  const portal = 'https://privacyportal.onetrust.com/webform';
  const out = await feeds.buildFeedsFile({
    fetchImpl: stubFetch(caCsv([
      row('1', 'Alpha Data', 'alpha-data.example', `${portal}/aaa/111`),
      row('2', 'Beta Data', 'beta-data.example', `${portal}/bbb/222`),
      row('3', 'Gamma Data', 'gamma-data.example', `${portal}/ccc/333`),
    ])),
    caUrl: CA_URL, now: NOW, explicitHosts: [],
  });
  assert.deepEqual(out.brokers.map(b => b.name).sort(), ['Alpha Data', 'Beta Data', 'Gamma Data']);
  assert.equal(out.brokers[0].optOutUrl.startsWith(portal), true, 'the opt-out URL stays the rights URL');
  assert.equal(out.stats.total, 3);
});

test('the same company listed by two registries is still one row (identity is the primary website)', async () => {
  const portal = 'https://privacyportal.onetrust.com/webform';
  const vt = 'Business Name,Website\nAlpha Data,https://www.alpha-data.example/privacy\n';
  const out = await feeds.buildFeedsFile({
    fetchImpl: async (url) => ({
      ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]),
      text: async () => (url === CA_URL ? caCsv([row('1', 'Alpha Data', 'alpha-data.example', `${portal}/aaa/111`)]) : vt),
    }),
    caUrl: CA_URL, vtUrl: 'https://vt.test/x.csv', now: NOW, explicitHosts: [],
  });
  assert.equal(out.brokers.length, 1);
  assert.deepEqual(out.brokers[0].registries, ['CA', 'VT']);
});

test('two rows with the same shared-platform page and no website are one row; different pages are two', async () => {
  const portal = 'https://privacyportal.onetrust.com/webform';
  const out = await feeds.buildFeedsFile({
    fetchImpl: stubFetch(caCsv([
      row('1', 'No Site One', '', `${portal}/aaa/111`),
      row('2', 'No Site Two', '', `${portal}/aaa/111`),
      row('3', 'No Site Three', '', `${portal}/bbb/222`),
    ])),
    caUrl: CA_URL, now: NOW, explicitHosts: [],
  });
  assert.deepEqual(out.brokers.map(b => b.name), ['No Site One', 'No Site Three']);
});
