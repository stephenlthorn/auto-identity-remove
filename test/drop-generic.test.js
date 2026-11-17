/**
 * test/drop-generic.test.js
 *
 * The generic pass and DROP. For a California person with a recorded request, a row
 * whose domain is on the California registry is not visited: it is logged as
 * skipped with the date of the request and counted. Anyone else, and anyone with
 * drop.alsoSubmit set, gets exactly the pass they always got.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('node:crypto');

const gr = require('../generic-runner');
const drop = require('../lib/drop');
const logger = require('../lib/logger');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', country: 'US' };
const BOB = { firstName: 'Bob', lastName: 'Sample', state: 'TX' };
const REGISTRY = { 'acme-data.example': ['CA'], 'vt-too.example': ['CA', 'VT'], 'vermont-only.example': ['VT'] };
const RECORDED = { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };

const ROWS = () => [
  { name: 'Acme Data', url: 'https://www.acme-data.example/optout', source: 'feed' },
  { name: 'Vermont Only', url: 'https://vermont-only.example/optout', source: 'feed' },
  { name: 'VT Too', url: 'https://privacy.vt-too.example/optout', source: 'feed' },
  { name: 'Unlisted Co', url: 'https://unlisted.example/optout', source: 'markup' },
];

async function pass({ person, state = RECORDED, config = {}, registryHosts = REGISTRY, rows = ROWS(), extra = {} }) {
  const visited = [];
  const logged = [];
  const saved = [];
  const coveredByDrop = drop.makeCoveredByDrop({ person, state, config, registryHosts });
  const page = { isClosed: () => false, close: async () => {}, waitForTimeout: async () => {} };
  const result = await gr.runGenericBrokers(
    { newPage: async () => page, pages: () => [page] },
    new Set(),
    state,
    (name, status, detail) => logged.push({ name, status, detail }),
    (key) => saved.push(key),
    {
      person,
      personCount: 1,
      injectedBrokers: rows,
      injectedProcessFn: async (_p, broker) => { visited.push(broker.name); return { status: 'success', detail: 'ok' }; },
      ...(coveredByDrop ? { coveredByDrop } : {}),
      ...extra,
    },
  );
  return { visited, logged, saved, result };
}

test('a California person with a recorded request: covered rows are skipped with a reason, the rest run', async () => {
  const { visited, logged, saved, result } = await pass({ person: JANE });
  assert.deepEqual(visited, ['Vermont Only', 'Unlisted Co']);
  for (const name of ['Acme Data', 'VT Too']) {
    const row = logged.find(l => l.name === name);
    assert.equal(row.status, 'skipped', name);
    assert.equal(row.detail, 'covered by your DROP request of 2026-09-01');
  }
  assert.deepEqual(saved, ['Vermont Only', 'Unlisted Co'], 'a skipped row writes no state');
  assert.equal(result.genericStats.covered_by_drop, 2);
  assert.equal(result.genericStats.attempted, 2, 'a skipped row was not attempted');
});

test('a person in another state is unaffected', async () => {
  const { visited, result } = await pass({ person: BOB, state: { optOuts: {}, drop: { 'Bob Sample': { submittedAt: '2026-09-01' } } } });
  assert.deepEqual(visited, ['Acme Data', 'Vermont Only', 'VT Too', 'Unlisted Co']);
  assert.equal(result.genericStats.covered_by_drop, 0);
});

test('drop.alsoSubmit: true restores the old behaviour for a California person', async () => {
  const { visited, result } = await pass({ person: JANE, config: { drop: { alsoSubmit: true } } });
  assert.deepEqual(visited, ['Acme Data', 'Vermont Only', 'VT Too', 'Unlisted Co']);
  assert.equal(result.genericStats.covered_by_drop, 0);
});

test('with no recorded request, or no registry list, nothing is skipped', async () => {
  assert.equal((await pass({ person: JANE, state: { optOuts: {} } })).visited.length, 4);
  assert.equal((await pass({ person: JANE, registryHosts: {} })).visited.length, 4);
});

test('the option is optional: runGenericBrokers without it behaves as before', async () => {
  const visited = [];
  const page = { isClosed: () => false, close: async () => {}, waitForTimeout: async () => {} };
  const result = await gr.runGenericBrokers(
    { newPage: async () => page, pages: () => [page] }, new Set(), { optOuts: {} }, () => {}, () => {},
    { injectedBrokers: ROWS(), injectedProcessFn: async (_p, b) => { visited.push(b.name); return { status: 'manual', detail: '' }; } },
  );
  assert.equal(visited.length, 4);
  assert.equal(result.genericStats.covered_by_drop, 0);
});

const keyHash = (name) => crypto.createHash('sha1').update(name).digest('hex').slice(0, 10);

test('a covered row counts as finished in the resume checkpoint, and an --only filter still applies first', async () => {
  const checkpoints = [];
  const { visited } = await pass({
    person: JANE,
    extra: { saveCheckpoint: (r) => checkpoints.push(r), checkpointDone: true, include: (n) => n !== 'Unlisted Co', now: () => checkpoints.length * 60000 },
  });
  assert.deepEqual(visited, ['Vermont Only']);
  // Queue after the filter: Acme Data (covered), Vermont Only, VT Too (covered). The only row
  // that runs is the second, so there is exactly one checkpoint, written before it runs.
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].phase, 'generic');
  assert.equal(checkpoints[0].key, 'Vermont Only');
  assert.equal(checkpoints[0].index, 1);
  assert.deepEqual(checkpoints[0].done, [keyHash('Acme Data')], 'the covered row before it is listed as finished');
  assert.equal(checkpoints[0].done.includes(keyHash('Unlisted Co')), false, 'a row the filter removed was never in the queue');
});

// D12: fixtures that look like the real registry, not already-reduced .example domains.
const ROWS_REAL = () => [
  { name: 'Portal Row', url: 'https://privacyportal.onetrust.com/webform/abc/def', source: 'markup' },
  { name: 'Portal Feed Row', url: 'https://privacyportal.onetrust.com/webform/ghi/jkl', source: 'feed', registries: ['CA'] },
  { name: 'UK Data', url: 'https://shop.ukdata.co.uk/optout', source: 'feed' },
  { name: 'Other UK', url: 'https://another.co.uk/optout', source: 'markup' },
  { name: 'WWW Host', url: 'https://www.acme-data.example/optout', source: 'markup' },
  { name: 'Deep Subdomain', url: 'https://a.b.acme-data.example/optout', source: 'markup' },
];
const REAL_REGISTRY = { 'ukdata.co.uk': ['CA'], 'acme-data.example': ['CA'], 'onetrust.com': ['CA'], 'co.uk': ['CA'] };

test('shared platforms, public suffixes, www and subdomains behave like real registry hosts', async () => {
  const { visited, logged } = await pass({ person: JANE, rows: ROWS_REAL(), registryHosts: REAL_REGISTRY });
  assert.deepEqual(visited, ['Portal Row', 'Other UK'], 'a portal page with no registries field, and an unrelated .co.uk, are submitted');
  const skipped = logged.filter(l => l.status === 'skipped').map(l => l.name).sort();
  assert.deepEqual(skipped, ['Deep Subdomain', 'Portal Feed Row', 'UK Data', 'WWW Host']);
});

test('the run summary says how many rows DROP covered', () => {
  logger.resetResults();
  logger.results.genericStats = { attempted: 10, submitted: 8, no_form_found: 1, error: 1, unverified: 0, captcha_failed: 0, covered_by_drop: 37 };
  assert.match(logger.buildSummary(), /37 covered by DROP/);
  logger.results.genericStats = { attempted: 10, submitted: 8, no_form_found: 1, error: 1, unverified: 0, captcha_failed: 0, covered_by_drop: 0 };
  assert.doesNotMatch(logger.buildSummary(), /covered by DROP/);
  logger.resetResults();
});
