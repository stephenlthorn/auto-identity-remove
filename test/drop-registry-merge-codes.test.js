/**
 * test/drop-registry-merge-codes.test.js
 *
 * Two spellings of one site ("www.acme.example" and "acme.example") are one registry domain.
 * The codes of both spellings are kept, so a broker the file lists as CA under one spelling
 * and VT under the other is still on the California registry.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRegistryHosts, californiaDomains } = require('../lib/drop');

const load = (registryHosts) => loadRegistryHosts({ filePath: 'x', readFile: () => JSON.stringify({ registryHosts }) });

test('codes from two spellings of one domain are merged, not replaced', () => {
  const hosts = load({ 'acme-data.example': ['CA'], 'www.acme-data.example': ['VT'] });
  assert.deepEqual(hosts, { 'acme-data.example': ['CA', 'VT'] });
  assert.ok(californiaDomains(hosts).has('acme-data.example'));
});

test('the merge does not depend on which spelling comes last', () => {
  const hosts = load({ 'www.acme-data.example': ['VT'], 'acme-data.example': ['CA'] });
  assert.deepEqual(hosts, { 'acme-data.example': ['CA', 'VT'] });
});
