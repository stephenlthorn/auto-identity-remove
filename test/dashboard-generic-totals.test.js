/**
 * test/dashboard-generic-totals.test.js
 *
 * R8: the ~490 generic brokers never appeared in the dashboard. The summary now
 * counts them (the way generic-runner loads them) and totals their state.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGenericList, tallyGeneric } = require('../dashboard/generic');

const GENERIC = [{ name: 'Acme Data' }, { name: 'Bolt Search' }, { name: 'Cedar Records' }, { name: 'Delta People' }, { name: 'Echo Index' }];

test('tallyGeneric counts one status per generic broker and the rest as untried', () => {
  const optOuts = {
    'Acme Data': { history: ['success'] },
    'Bolt Search': { history: ['pending_confirm'] },
    'Cedar Records': { history: ['error'] },
  };
  assert.deepEqual(tallyGeneric(optOuts, GENERIC), {
    total: 5, optedOut: 1, pending: 1, error: 1, notListed: 0, manual: 0, other: 0, untried: 2,
  });
});

test('tallyGeneric reads the per-person keys and takes the worst status per broker', () => {
  const optOuts = {
    'Acme Data|Alice Smith': { history: ['success'] },
    'Acme Data|Bob Jones': { history: ['error'] },
    'Bolt Search|Alice Smith': { history: ['success'] },
    'Bolt Search|Bob Jones': { history: ['success'] },
  };
  const t = tallyGeneric(optOuts, GENERIC);
  assert.equal(t.optedOut, 1, 'Bolt only: Acme has a person whose attempt errored');
  assert.equal(t.error, 1);
  assert.equal(t.untried, 3);
});

test('tallyGeneric ignores state for explicit brokers and tolerates a missing or hostile state', () => {
  assert.equal(tallyGeneric({ Spokeo: { history: ['success'] } }, GENERIC).optedOut, 0);
  assert.equal(tallyGeneric(undefined, GENERIC).untried, 5);
  assert.equal(tallyGeneric([], GENERIC).untried, 5);
  assert.equal(tallyGeneric({ 'Acme Data': 'not an entry' }, GENERIC).untried, 5);
  assert.equal(tallyGeneric({}, []).total, 0);
});

test('tallyGeneric does not let a broker named like an Object.prototype key throw', () => {
  const t = tallyGeneric({}, [{ name: 'constructor' }, { name: '__proto__' }, { name: 'toString' }]);
  assert.equal(t.total, 3);
  assert.equal(t.untried, 3);
});

test('a generic broker listed twice by name is counted once', () => {
  assert.equal(tallyGeneric({}, [{ name: 'Acme Data' }, { name: 'Acme Data' }]).total, 1);
});

test('loadGenericList loads the shipped datasets the way generic-runner does', () => {
  const list = loadGenericList({ explicitBrokers: [] });
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 400, `expected the shipped datasets to give hundreds of rows, got ${list.length}`);
  assert.ok(list.every(b => typeof b.name === 'string' && b.name));
});

test('loadGenericList drops rows that are the same site as an explicit broker', () => {
  const all = loadGenericList({ explicitBrokers: [] });
  const sample = all.find(b => /^https?:\/\//.test(b.url || ''));
  assert.ok(sample, 'precondition: a generic row with a url');
  const host = new URL(sample.url).hostname.replace(/^www\./, '');
  const fewer = loadGenericList({ explicitBrokers: [{ name: 'Explicit', optOutUrl: `https://${host}/optout` }] });
  assert.ok(fewer.length < all.length, 'the explicit broker covers that host');
  assert.ok(!fewer.some(b => b.name === sample.name && b.url === sample.url));
});

test('loadGenericList returns null instead of throwing when the datasets cannot be read', () => {
  assert.equal(loadGenericList({ explicitBrokers: [], load: () => { throw new Error('boom'); } }), null);
});
