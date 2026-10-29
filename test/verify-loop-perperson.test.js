/**
 * test/verify-loop-perperson.test.js
 *
 * NET-4b / CORE-2 (P1): `--verify` checked every person against persons[0]'s
 * search URL (the module-level broker list is built for persons[0]), so a
 * second person was recorded verified_clear from somebody else's search.
 * runVerify now takes opts.brokersFor(person) and uses it for each person.
 *
 * It also must never turn "could not tell" into "verified clear": a thrown
 * UNVERIFIABLE (contract with lib/forms.js findListingUrl) and any return value
 * other than null (no listing) or a URL string are unverifiable.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runVerify } = require('../lib/verify-loop');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeContext() {
  return { newPage: async () => ({ close: async () => {} }) };
}

const ALICE = { firstName: 'Alice', lastName: 'Archer' };
const BOB = { firstName: 'Bob', lastName: 'Builder' };

/** Mirrors brokers.forPerson: the searchUrl embeds the person it was built for. */
function brokerFor(person, name = 'Spokeo') {
  return {
    name,
    method: 'search-form',
    searchUrl: `https://${name.toLowerCase()}.example/search?q=${person.firstName}-${person.lastName}`,
    listingPattern: /example\/listing\/\d+/i,
  };
}

function twoPersonState(name = 'Spokeo') {
  return {
    optOuts: {
      [`${name}|Alice Archer`]: { lastSuccess: daysAgo(10), totalRuns: 1 },
      [`${name}|Bob Builder`]: { lastSuccess: daysAgo(10), totalRuns: 1 },
    },
  };
}

test('two persons: each person is searched with THEIR OWN broker definition', async () => {
  const searched = [];
  const findUrl = async (_page, broker) => { searched.push(broker.searchUrl); return null; };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE, BOB], {
    state: twoPersonState(),
    findUrl,
    brokersFor: (person) => [brokerFor(person)],
  });

  assert.equal(searched.length, 2);
  assert.match(searched[0], /Alice-Archer/);
  assert.match(searched[1], /Bob-Builder/, 'the second search must use person B, not persons[0]');
  assert.equal(result.verified_clear.length, 2);
});

test('two persons: A still listed, B clear -> outcomes are recorded per person, not copied from A', async () => {
  const findUrl = async (_page, broker) => (/Alice-Archer/.test(broker.searchUrl) ? 'https://spokeo.example/listing/1' : null);
  const state = twoPersonState();

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE, BOB], {
    state,
    findUrl,
    brokersFor: (person) => [brokerFor(person)],
  });

  assert.deepEqual(result.still_listed.map(e => e.person), [ALICE]);
  assert.deepEqual(result.verified_clear.map(e => e.person), [BOB]);
  assert.ok(state.optOuts['Spokeo|Alice Archer'].verifiedStillListedAt);
  assert.equal(state.optOuts['Spokeo|Alice Archer'].verifiedDeletedAt, undefined);
  assert.ok(state.optOuts['Spokeo|Bob Builder'].verifiedDeletedAt);
});

test('brokersFor is evaluated once per person, and the person is still passed to findUrl', async () => {
  const built = [];
  const seenPersons = [];

  await runVerify(makeContext(), [brokerFor(ALICE), brokerFor(ALICE, 'Radaris')], [ALICE, BOB], {
    state: {
      optOuts: {
        'Spokeo|Alice Archer': { lastSuccess: daysAgo(10) },
        'Spokeo|Bob Builder': { lastSuccess: daysAgo(10) },
        'Radaris|Alice Archer': { lastSuccess: daysAgo(10) },
        'Radaris|Bob Builder': { lastSuccess: daysAgo(10) },
      },
    },
    findUrl: async (_page, _broker, person) => { seenPersons.push(person); return null; },
    brokersFor: (person) => { built.push(person); return [brokerFor(person), brokerFor(person, 'Radaris')]; },
  });

  assert.deepEqual(built, [ALICE, BOB]);
  assert.equal(seenPersons.length, 4);
});

test('a broker missing from a person\'s list is unverifiable for that person, never cleared', async () => {
  const state = twoPersonState();

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE, BOB], {
    state,
    findUrl: async () => null,
    brokersFor: (person) => (person === ALICE ? [brokerFor(person)] : []),
  });

  assert.equal(result.verified_clear.length, 1);
  assert.equal(result.unverifiable.length, 1);
  assert.equal(result.unverifiable[0].person, BOB);
  assert.equal(state.optOuts['Spokeo|Bob Builder'].verifiedDeletedAt, undefined);
});

test('brokersFor throwing makes that person unverifiable and does not abort the run', async () => {
  const state = twoPersonState();

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE, BOB], {
    state,
    findUrl: async () => null,
    brokersFor: (person) => { if (person === BOB) throw new Error('config gone'); return [brokerFor(person)]; },
  });

  assert.equal(result.verified_clear.length, 1);
  assert.equal(result.unverifiable.length, 1);
  assert.match(result.unverifiable[0].reason, /config gone/);
});

test('single person without brokersFor keeps working (backward compatible)', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE], { state, findUrl: async () => null });

  assert.equal(result.verified_clear.length, 1);
});

// -- UNVERIFIABLE -------------------------------------------------------------

test('a thrown UNVERIFIABLE is unverifiable: no verifiedDeletedAt, no verified_clear, no history entry', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10), totalRuns: 1 } } };
  const before = JSON.stringify(state);
  const findUrl = async () => {
    const err = new Error('search page returned HTTP 403');
    err.code = 'UNVERIFIABLE';
    throw err;
  };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE], { state, findUrl });

  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.still_listed.length, 0);
  assert.equal(result.unverifiable.length, 1);
  assert.match(result.unverifiable[0].reason, /403/);
  assert.equal(JSON.stringify(state), before, 'state must be untouched');
});

test('findUrl returning undefined (contract breach) is unverifiable, not "verified clear"', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE], { state, findUrl: async () => undefined });

  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.unverifiable.length, 1);
  assert.equal(state.optOuts.Spokeo.verifiedDeletedAt, undefined);
});

test('findUrl returning an empty string is unverifiable too; only null means "no listing"', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE], { state, findUrl: async () => '' });

  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.unverifiable.length, 1);
});

test('findUrl returning null is still verified clear (search loaded fine, no matching listing)', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };

  const result = await runVerify(makeContext(), [brokerFor(ALICE)], [ALICE], { state, findUrl: async () => null });

  assert.equal(result.verified_clear.length, 1);
  assert.ok(state.optOuts.Spokeo.verifiedDeletedAt);
});

test('the page is closed even when findUrl throws UNVERIFIABLE', async () => {
  let closed = 0;
  const context = { newPage: async () => ({ close: async () => { closed += 1; } }) };
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };
  const findUrl = async () => { const e = new Error('bot wall'); e.code = 'UNVERIFIABLE'; throw e; };

  await runVerify(context, [brokerFor(ALICE)], [ALICE], { state, findUrl });

  assert.equal(closed, 1);
});
