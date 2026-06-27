/**
 * test/feeds-normalize.test.js
 *
 * Pure unit tests for lib/feeds.js header mapping, CSV parsing, and row
 * normalization. No network, no file I/O - inline CSV/row fixtures only.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { normalizeFeedRow, parseCsv, mapHeaderRow } = require('../lib/feeds');

// ── mapHeaderRow ───────────────────────────────────────────────────────────────

test('mapHeaderRow lowercases and trims header cells into canonical keys', () => {
  const headers = ['  Business Name ', 'Website', 'Email Address'];
  const cells   = ['Acme Data Co', 'https://acme.example.com', 'privacy@acme.example.com'];
  const row = mapHeaderRow(headers, cells);
  assert.equal(row['business name'], 'Acme Data Co');
  assert.equal(row['website'], 'https://acme.example.com');
  assert.equal(row['email address'], 'privacy@acme.example.com');
});

test('mapHeaderRow tolerates rows with fewer cells than headers', () => {
  const headers = ['name', 'website', 'email'];
  const cells   = ['Acme'];
  const row = mapHeaderRow(headers, cells);
  assert.equal(row['name'], 'Acme');
  assert.equal(row['website'], '');
  assert.equal(row['email'], '');
});

// ── parseCsv ───────────────────────────────────────────────────────────────────

test('parseCsv parses a simple CSV into header-mapped row objects', () => {
  const csv = 'Name,Website\nAcme Data Co,https://acme.example.com\nBeta LLC,https://beta.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['name'], 'Acme Data Co');
  assert.equal(rows[0]['website'], 'https://acme.example.com');
  assert.equal(rows[1]['name'], 'Beta LLC');
});

test('parseCsv handles quoted fields containing commas', () => {
  const csv = 'Name,Website\n"Acme, Data & Co",https://acme.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['name'], 'Acme, Data & Co');
  assert.equal(rows[0]['website'], 'https://acme.example.com');
});

test('parseCsv unescapes doubled double-quotes inside a quoted field', () => {
  const csv = 'Name,Website\n"The ""Big"" Broker",https://big.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows[0]['name'], 'The "Big" Broker');
});

test('parseCsv ignores blank trailing lines and handles CRLF', () => {
  const csv = 'Name,Website\r\nAcme,https://acme.example.com\r\n\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['name'], 'Acme');
});

test('parseCsv returns [] for empty or header-only input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('Name,Website\n'), []);
});

// ── normalizeFeedRow ─────────────────────────────────────────────────────────────

test('normalizeFeedRow maps a California-style row to a generic broker entry', () => {
  const row = { 'data broker name': 'Acme Data Co', 'website url': 'https://acme.example.com/opt-out' };
  const entry = normalizeFeedRow(row, 'ca');
  assert.deepEqual(entry, {
    name: 'Acme Data Co',
    optOutUrl: 'https://acme.example.com/opt-out',
    method: 'direct-form',
    source: 'ca',
  });
});

test('normalizeFeedRow maps a Vermont-style row using alias headers', () => {
  const row = { 'business name': 'Beta Brokers LLC', 'website': 'https://beta.example.com/privacy' };
  const entry = normalizeFeedRow(row, 'vt');
  assert.equal(entry.name, 'Beta Brokers LLC');
  assert.equal(entry.optOutUrl, 'https://beta.example.com/privacy');
  assert.equal(entry.source, 'vt');
});

test('normalizeFeedRow classifies method as direct-form for opt-out style URLs', () => {
  for (const url of [
    'https://x.example.com/opt-out',
    'https://x.example.com/do-not-sell',
    'https://x.example.com/privacy-request',
    'https://x.example.com/dsar',
    'https://x.example.com/remove',
  ]) {
    const entry = normalizeFeedRow({ name: 'X', website: url }, 'ca');
    assert.equal(entry.method, 'direct-form', `expected direct-form for ${url}`);
  }
});

test('normalizeFeedRow classifies method as manual for a bare homepage URL', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://x.example.com/' }, 'ca');
  assert.equal(entry.method, 'manual');
});

test('normalizeFeedRow trims surrounding whitespace from name and url', () => {
  const entry = normalizeFeedRow({ name: '  Acme  ', website: '  https://acme.example.com  ' }, 'ca');
  assert.equal(entry.name, 'Acme');
  assert.equal(entry.optOutUrl, 'https://acme.example.com');
});

test('normalizeFeedRow prepends https:// to a scheme-less website', () => {
  const entry = normalizeFeedRow({ name: 'Acme', website: 'acme.example.com/opt-out' }, 'ca');
  assert.equal(entry.optOutUrl, 'https://acme.example.com/opt-out');
  assert.equal(entry.method, 'direct-form');
});

test('normalizeFeedRow returns null when no usable name is present', () => {
  assert.equal(normalizeFeedRow({ website: 'https://x.example.com' }, 'ca'), null);
  assert.equal(normalizeFeedRow({ name: '   ', website: 'https://x.example.com' }, 'ca'), null);
});

test('normalizeFeedRow keeps a name-only row with an empty optOutUrl as manual', () => {
  const entry = normalizeFeedRow({ name: 'Nameonly Broker' }, 'vt');
  assert.equal(entry.name, 'Nameonly Broker');
  assert.equal(entry.optOutUrl, '');
  assert.equal(entry.method, 'manual');
});

// ── Fix 6: classifyMethod tightened path-segment matching ─────────────────────

test('Fix6: URL containing "request" in a subdomain name is NOT classified as direct-form', () => {
  // Bug: "request.example.com/login" contains "request" as substring -> was over-classified
  const entry = normalizeFeedRow({ name: 'X', website: 'https://request.example.com/login' }, 'ca');
  assert.equal(
    entry.method, 'manual',
    'hostname containing "request" should not be classified as direct-form'
  );
});

test('Fix6: URL containing "remove" in a query param value is NOT classified as direct-form', () => {
  // "action=removeall" - "remove" is embedded in a value, not a segment
  const entry = normalizeFeedRow({ name: 'X', website: 'https://example.com/settings?action=removeall' }, 'ca');
  assert.equal(
    entry.method, 'manual',
    'query param value containing "remove" should not be classified as direct-form'
  );
});

test('Fix6: URL with "delete" as a whole path segment IS classified as direct-form', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://example.com/delete' }, 'ca');
  assert.equal(entry.method, 'direct-form', '/delete as a whole segment should be direct-form');
});

test('Fix6: URL with "request" as a whole path segment IS classified as direct-form', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://example.com/privacy/request' }, 'ca');
  assert.equal(entry.method, 'direct-form', '/request as a whole path segment should be direct-form');
});

test('Fix6: URL with "remove" as a whole path segment IS classified as direct-form', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://example.com/account/remove' }, 'ca');
  assert.equal(entry.method, 'direct-form', '/remove as a whole segment should be direct-form');
});

test('Fix6: homepage URL is still manual', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://example.com/' }, 'ca');
  assert.equal(entry.method, 'manual');
});

// ── end Fix 6 ─────────────────────────────────────────────────────────────────
