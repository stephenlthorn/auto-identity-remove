/**
 * test/verify-loop-context-for.test.js
 *
 * R7 gives every person their own browser profile, and the watcher hands out
 * their contexts one at a time (the previous one is closed before the next one
 * starts, which is what keeps a small NAS inside its memory). runVerify took ONE
 * context, so --verify searched every person from the same profile, and its
 * broker-major loop (for each broker, for each person) would have swapped the
 * browser on every single step.
 *
 * opts.contextFor(person, index) returns the context for that person. The loop
 * then runs person by person, asks for a person's context only when something
 * has to be searched, and still reports results in the order callers always saw
 * (broker first, then person).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runVerify } = require('../lib/verify-loop');

const day = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * day).toISOString();

const ALICE = { firstName: 'Alice', lastName: 'Archer' };
const BOB = { firstName: 'Bob', lastName: 'Builder' };

const searchBroker = (name) => ({
  name,
  method: 'search-form',
  searchUrl: `https://${name.toLowerCase()}.example/search`,
  listingPattern: /listing/i,
});

const stateFor = (names) => ({
  optOuts: Object.fromEntries(names.flatMap(n => [
    [`${n}|Alice Archer`, { lastSuccess: daysAgo(10) }],
    [`${n}|Bob Builder`, { lastSuccess: daysAgo(10) }],
  ])),
});

/** A context that records which page it opened, under its owner's label. */
function contexts(log) {
  const make = label => ({ newPage: async () => { log.push(`page:${label}`); return { close: async () => {} }; } });
  return { alice: make('alice'), bob: make('bob') };
}

test('each person is searched in that person\'s own context, one person at a time', async () => {
  const log = [];
  const ctx = contexts(log);
  const requested = [];
  const brokers = [searchBroker('Spokeo'), searchBroker('Radaris'), searchBroker('Whitepages')];

  await runVerify(null, brokers, [ALICE, BOB], {
    state: stateFor(brokers.map(b => b.name)),
    findUrl: async () => null,
    brokersFor: () => brokers,
    contextFor: (person, index) => { requested.push(index); return index === 0 ? ctx.alice : ctx.bob; },
  });

  assert.deepEqual(log, ['page:alice', 'page:alice', 'page:alice', 'page:bob', 'page:bob', 'page:bob'],
    'all of Alice, then all of Bob: a browser swap per broker would relaunch Chromium 6 times');
  assert.deepEqual([...new Set(requested)], [0, 1]);
  assert.deepEqual(requested, [...requested].sort(), 'contexts are requested in person order, never back to a previous person');
});

test('results keep the broker-then-person order callers always saw', async () => {
  const brokers = [searchBroker('Spokeo'), searchBroker('Radaris')];
  const ctx = contexts([]);
  const run = (extra) => runVerify(ctx.alice, brokers, [ALICE, BOB], {
    state: stateFor(['Spokeo', 'Radaris']),
    findUrl: async () => null,
    brokersFor: () => brokers,
    ...extra,
  });

  const plain = await run({});
  const perPerson = await run({ contextFor: (p, i) => (i === 0 ? ctx.alice : ctx.bob) });

  const shape = r => r.verified_clear.map(e => `${e.broker}|${e.person.firstName}`);
  assert.deepEqual(shape(perPerson), shape(plain));
  assert.deepEqual(shape(perPerson), ['Spokeo|Alice', 'Spokeo|Bob', 'Radaris|Alice', 'Radaris|Bob']);
});

test('a person with nothing to search never gets a context', async () => {
  const requested = [];
  const ctx = contexts([]);
  const state = { optOuts: { 'Spokeo|Alice Archer': { lastSuccess: daysAgo(10) } } }; // Bob has no recorded submission
  const result = await runVerify(null, [searchBroker('Spokeo')], [ALICE, BOB], {
    state,
    findUrl: async () => null,
    brokersFor: () => [searchBroker('Spokeo')],
    contextFor: (person, index) => { requested.push(index); return ctx.alice; },
  });
  assert.deepEqual(requested, [0], 'launching a browser for Bob only to skip him would be a wasted Chromium');
  assert.equal(result.skipped.length, 1);
});

test('an allowlisted broker is skipped once, in its broker position, and opens nothing', async () => {
  const log = [];
  const ctx = contexts(log);
  const brokers = [searchBroker('Spokeo'), searchBroker('Radaris')];
  const result = await runVerify(null, brokers, [ALICE, BOB], {
    state: stateFor(['Spokeo', 'Radaris']),
    config: { allowlist: ['Spokeo'] },
    findUrl: async () => null,
    brokersFor: () => brokers,
    contextFor: (p, i) => (i === 0 ? ctx.alice : ctx.bob),
  });
  assert.deepEqual(result.skipped.map(s => s.broker), ['Spokeo']);
  assert.deepEqual(log, ['page:alice', 'page:bob']);
  assert.deepEqual(result.verified_clear.map(e => e.broker), ['Radaris', 'Radaris']);
});

test('without contextFor the single context is used exactly as before', async () => {
  const log = [];
  const ctx = contexts(log);
  const brokers = [searchBroker('Spokeo')];
  await runVerify(ctx.alice, brokers, [ALICE, BOB], {
    state: stateFor(['Spokeo']),
    findUrl: async () => null,
    brokersFor: () => brokers,
  });
  assert.deepEqual(log, ['page:alice', 'page:alice']);
});

test('a contextFor that cannot launch makes that person unverifiable, never verified clear', async () => {
  const brokers = [searchBroker('Spokeo')];
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };
  const result = await runVerify(null, brokers, [ALICE], {
    state,
    findUrl: async () => null,
    brokersFor: () => brokers,
    contextFor: async () => { throw new Error('browser would not start'); },
  });
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.unverifiable.length, 1);
  assert.match(result.unverifiable[0].reason, /browser would not start/);
  assert.equal(state.optOuts.Spokeo.verifiedDeletedAt, undefined);
});
