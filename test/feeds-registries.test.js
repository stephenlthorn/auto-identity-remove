/**
 * test/feeds-registries.test.js
 *
 * The current California registry format, the per-registry `registries` field,
 * the `registryHosts` map the DROP package reads, and honest per-registry
 * failure reporting. No network: every fetch is an injected stub.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const feeds = require('../lib/feeds');
const { caCsv, CA_ROWS } = require('./helpers/ca-registry-fixture');

const CA_URL = 'https://ca.test/registry.csv';
const VT_URL = 'https://vt.test/export.csv';
const NOW = new Date('2026-11-17T12:00:00Z');

function stubFetch(byUrl, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    const hit = byUrl[url];
    if (!hit) return { ok: false, status: 404, headers: new Map(), text: async () => '' };
    const res = typeof hit === 'string' ? { body: hit } : hit;
    const headers = new Map([['content-type', res.type || 'text/csv']]);
    return { ok: (res.status || 200) < 400, status: res.status || 200, headers, text: async () => res.body };
  };
}

const HTML_PAGE = '<!doctype html><html><head><title>App</title></head><body>hi</body></html>';

async function build(byUrl, extra = {}) {
  return feeds.buildFeedsFile({
    fetchImpl: stubFetch(byUrl), caUrl: CA_URL, now: NOW, explicitHosts: [], ...extra,
  });
}

test('California: the count is reported and every row carries registries', async () => {
  const out = await build({ [CA_URL]: caCsv(CA_ROWS) });
  assert.equal(out.registries.CA.ok, true);
  assert.equal(out.registries.CA.count, 3);
  assert.equal(out.stats.ca, 3);
  assert.equal(out.brokers.length, 3);
  for (const b of out.brokers) assert.deepEqual(b.registries, ['CA']);
});

test('California: the consumer-rights URL is preferred, the website is the fallback', async () => {
  const out = await build({ [CA_URL]: caCsv(CA_ROWS) });
  const by = Object.fromEntries(out.brokers.map(b => [b.name, b]));
  assert.equal(by['Acme Data Co'].optOutUrl, 'https://rights.acme-data.example/opt-out');
  assert.equal(by['Acme Data Co'].method, 'direct-form');
  assert.equal(by['Other Brokers, Inc.'].optOutUrl, 'https://other.example');
  assert.equal(by['Third Party LLC'].optOutUrl, 'https://third.example/');
});

test('registryHosts holds the primary website domains only, never the rights-page host', async () => {
  const out = await build({ [CA_URL]: caCsv(CA_ROWS) });
  assert.deepEqual(out.registryHosts, {
    'acme-data.example': ['CA'],
    'other.example': ['CA'],
    'third.example': ['CA'],
  });
});

test('registryHosts is built before the dedupe against explicit brokers', async () => {
  const out = await build({ [CA_URL]: caCsv(CA_ROWS) }, { explicitHosts: ['other.example'] });
  assert.equal(out.brokers.some(b => b.name === 'Other Brokers, Inc.'), false);
  assert.deepEqual(out.registryHosts['other.example'], ['CA']);
});

test('a domain listed by two registries carries both codes on the row and in registryHosts', async () => {
  const vt = 'Business Name,Website\nAcme Data Co,https://www.acme-data.example/privacy\nVermont Only,https://vt-only.example/\n';
  const out = await build({ [CA_URL]: caCsv(CA_ROWS), [VT_URL]: vt }, { vtUrl: VT_URL });
  assert.deepEqual(out.registryHosts['acme-data.example'], ['CA', 'VT']);
  assert.deepEqual(out.registryHosts['vt-only.example'], ['VT']);
  const acme = out.brokers.filter(b => b.name === 'Acme Data Co');
  assert.equal(acme.length, 1);
  assert.deepEqual(acme[0].registries, ['CA', 'VT']);
  assert.equal(out.registries.VT.count, 2);
});

test('requests carry a browser-like User-Agent', async () => {
  const seen = [];
  await feeds.buildFeedsFile({ fetchImpl: stubFetch({ [CA_URL]: caCsv(CA_ROWS) }, seen), caUrl: CA_URL, now: NOW });
  const ua = seen[0].init && seen[0].init.headers && seen[0].init.headers['User-Agent'];
  assert.match(String(ua), /^Mozilla\/5\.0 /);
});

test('an HTML response is a reported failure, not an empty success', async () => {
  const out = await build({ [CA_URL]: { body: HTML_PAGE, type: 'text/html; charset=utf-8' } });
  assert.equal(out.registries.CA.ok, false);
  assert.match(out.registries.CA.error, /HTML/);
  assert.equal(out.brokers.length, 0);
});

test('HTML served as text/csv is still caught by sniffing the body', async () => {
  const out = await build({ [CA_URL]: HTML_PAGE });
  assert.equal(out.registries.CA.ok, false);
  assert.match(out.registries.CA.error, /HTML/);
});

test('a non-2xx status and a header-only file are failures too', async () => {
  const bad = await build({ [CA_URL]: { body: 'nope', status: 403 } });
  assert.equal(bad.registries.CA.ok, false);
  assert.match(bad.registries.CA.error, /HTTP 403/);
  const empty = await build({ [CA_URL]: caCsv([]) });
  assert.equal(empty.registries.CA.ok, false);
  assert.match(empty.registries.CA.error, /no (parseable )?rows/i);
});

test('Vermont is skipped with one plain line unless VT_REGISTRY_URL points somewhere', async () => {
  const seen = [];
  const out = await feeds.buildFeedsFile({
    fetchImpl: stubFetch({ [CA_URL]: caCsv(CA_ROWS) }, seen), caUrl: CA_URL, now: NOW,
  });
  assert.equal(out.registries.VT.skipped, true);
  assert.equal(out.registries.VT.ok, false);
  assert.match(out.registries.VT.error, /no longer offers a file export/);
  assert.equal(seen.every(s => s.url === CA_URL), true);
  assert.equal(out.stats.vt, 0);
});

function previousFile() {
  return {
    brokers: [
      { name: 'Old Acme', optOutUrl: 'https://old-acme.example/opt-out', method: 'direct-form', source: 'ca', registries: ['CA'] },
    ],
    registryHosts: { 'old-acme.example': ['CA'] },
    registries: { CA: { ok: true, count: 1, fetchedAt: '2026-11-01T00:00:00.000Z' } },
  };
}

test('a failed registry keeps its earlier rows and says they are from the earlier date', async () => {
  const logs = [];
  let written = null;
  const result = await feeds.runUpdateBrokers({
    brokers: [], logFn: m => logs.push(m), writeFn: f => { written = f; },
    readPreviousFn: previousFile, now: NOW,
    buildFn: opts => feeds.buildFeedsFile({
      ...opts, fetchImpl: stubFetch({ [CA_URL]: { body: HTML_PAGE, type: 'text/html' } }),
      caUrl: CA_URL, vtUrl: VT_URL,
    }),
  });
  assert.equal(result.exitCode, 1);
  const text = logs.join('\n');
  assert.match(text, /California: FAILED/);
  assert.match(text, /Kept 1 earlier row\(s\) from 2026-11-01/);
  assert.equal(written, null, 'nothing is rewritten when every registry failed');
});

test('one registry failing while another succeeds still writes, keeps rows, and exits 0', async () => {
  const logs = [];
  let written = null;
  const vt = 'Business Name,Website\nVermont Only,https://vt-only.example/\n';
  const result = await feeds.runUpdateBrokers({
    brokers: [], logFn: m => logs.push(m), writeFn: f => { written = f; },
    readPreviousFn: previousFile, now: NOW,
    buildFn: opts => feeds.buildFeedsFile({
      ...opts, fetchImpl: stubFetch({ [CA_URL]: { body: 'x', status: 403 }, [VT_URL]: vt }),
      caUrl: CA_URL, vtUrl: VT_URL,
    }),
  });
  assert.equal(result.exitCode, 0);
  const names = written.brokers.map(b => b.name).sort();
  assert.deepEqual(names, ['Old Acme', 'Vermont Only']);
  assert.deepEqual(written.registryHosts['old-acme.example'], ['CA']);
  assert.equal(written.registries.CA.carriedOver, true);
  assert.match(logs.join('\n'), /Vermont: 1 broker/);
});

test('a clean run prints one line per registry and exits 0', async () => {
  const logs = [];
  let written = null;
  const result = await feeds.runUpdateBrokers({
    brokers: [], logFn: m => logs.push(m), writeFn: f => { written = f; },
    readPreviousFn: () => null, now: NOW,
    buildFn: opts => feeds.buildFeedsFile({
      ...opts, fetchImpl: stubFetch({ [CA_URL]: caCsv(CA_ROWS) }), caUrl: CA_URL,
    }),
  });
  assert.equal(result.exitCode, 0);
  const text = logs.join('\n');
  assert.match(text, /California: 3 brokers/);
  assert.match(text, /Vermont: skipped/);
  assert.equal(text.includes('0 brokers'), false);
  assert.ok(written.registryHosts && written.brokers.length === 3);
});

test('header normalisation drops the BOM, colons, bracketed notes, curly quotes and odd spaces', () => {
  const n = feeds.normalizeHeader;
  assert.equal(n('﻿Data broker name:'), 'data broker name');
  assert.equal(n('Data broker primary phone number: [optional]'), 'data broker primary phone number');
  assert.equal(n('Data broker’s  site'), "data broker's site");
  assert.equal(n('third‑party thing'), 'third-party thing');
});
