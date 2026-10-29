/**
 * test/imap-confirm-person.test.js
 *
 * NET-2 (P1): recordSuccess(broker.name) used the bare broker name, but
 * multi-person pending state is keyed "Broker|First Last". The confirmation
 * mail must be mapped to a person (To:/Delivered-To: matching person.email or
 * that person's cached relay alias) and the same stateKey the runner used must
 * be passed to the pending check and to recordSuccess.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processConfirmationEmails, addressesIn } = require('../lib/imap-confirm');

const SPOKEO = { name: 'Spokeo', expectedSender: 'optout@spokeo.com' };

const ALICE = { firstName: 'Alice', lastName: 'Archer', email: 'alice@example.com' };
const BOB = { firstName: 'Bob', lastName: 'Builder', email: 'bob@example.com' };

function memStore() {
  const ids = new Set();
  return { has: (id) => ids.has(id), add: (id) => { ids.add(id); } };
}

function eml(headerLines) {
  return [
    'From: optout@spokeo.com',
    ...headerLines,
    'Subject: Confirm',
    '',
    'Confirm: https://spokeo.com/confirm?t=1',
  ].join('\r\n');
}

function makeContext() {
  const calls = [];
  return {
    calls,
    newPage: async () => ({
      goto: async (url) => { calls.push(url); return { status: () => 200 }; },
      url: () => 'https://spokeo.com/confirm?t=1',
      textContent: async () => 'Confirmed.',
      close: async () => {},
    }),
  };
}

async function run(content, { persons, relayAliases, pendingKeys, dryRun = false }) {
  const ctx = makeContext();
  const successes = [];
  const pendingAsked = [];
  const result = await processConfirmationEmails(ctx, [SPOKEO], {
    dir: 'confirms',
    dryRun,
    persons,
    relayAliases,
    _readDir: () => ['m.eml'],
    _readFile: () => content,
    _moveFile: () => true,
    _recordSuccess: (key) => successes.push(key),
    _isPending: (key) => { pendingAsked.push(key); return pendingKeys.includes(key); },
    _processedStore: memStore(),
  });
  return { result, ctx, successes, pendingAsked };
}

test('two persons: a mail To: bob clears the composite key "Spokeo|Bob Builder", never bare "Spokeo"', async () => {
  const { result, successes, pendingAsked } = await run(
    eml(['To: bob@example.com']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Bob Builder'] }
  );

  assert.deepEqual(successes, ['Spokeo|Bob Builder']);
  assert.deepEqual(pendingAsked, ['Spokeo|Bob Builder']);
  assert.equal(result.processed[0].person, BOB);
});

test('two persons: matching works through the cached relay alias (keyed by relay personKey)', async () => {
  const { successes } = await run(
    eml(['To: Opt Outs <x7k2.mango@simplelogin.com>']),
    {
      persons: [ALICE, BOB],
      relayAliases: { 'alice@example.com': 'a1.apple@simplelogin.com', 'bob@example.com': 'x7k2.mango@simplelogin.com' },
      pendingKeys: ['Spokeo|Bob Builder'],
    }
  );

  assert.deepEqual(successes, ['Spokeo|Bob Builder']);
});

test('two persons: Delivered-To is used when To: names somebody else', async () => {
  const { successes } = await run(
    eml(['To: undisclosed-recipients:;', 'Delivered-To: alice@example.com']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Alice Archer'] }
  );

  assert.deepEqual(successes, ['Spokeo|Alice Archer']);
});

test('two persons: a display name that looks like an address cannot steer the match', async () => {
  const { successes } = await run(
    eml(['To: "alice@example.com" <bob@example.com>']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Alice Archer', 'Spokeo|Bob Builder'] }
  );

  assert.deepEqual(successes, ['Spokeo|Bob Builder']);
});

test('two persons: no person matches -> log-and-leave-pending, never guess', async () => {
  const { result, ctx, successes } = await run(
    eml(['To: someone.else@example.org']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Alice Archer', 'Spokeo|Bob Builder'] }
  );

  assert.equal(ctx.calls.length, 0, 'must not click without knowing whose confirmation it is');
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'no_person');
});

test('two persons sharing one address: ambiguous, so nothing is clicked', async () => {
  const twin = { firstName: 'Alan', lastName: 'Archer', email: 'alice@example.com' };
  const { result, ctx, successes } = await run(
    eml(['To: alice@example.com']),
    { persons: [ALICE, twin], pendingKeys: ['Spokeo|Alice Archer', 'Spokeo|Alan Archer'] }
  );

  assert.equal(ctx.calls.length, 0);
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'ambiguous_person');
});

test('two persons: mail matches Alice but only Bob is pending -> not_pending, no click', async () => {
  const { result, ctx, successes } = await run(
    eml(['To: alice@example.com']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Bob Builder'] }
  );

  assert.equal(ctx.calls.length, 0);
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'not_pending');
  assert.equal(result.unmatched[0].key, 'Spokeo|Alice Archer');
});

test('single person: no To: match is required and the key stays the bare broker name', async () => {
  const { successes } = await run(
    eml(['To: forwarded-from-somewhere@example.net']),
    { persons: [ALICE], pendingKeys: ['Spokeo'] }
  );

  assert.deepEqual(successes, ['Spokeo']);
});

test('no persons option (legacy call): bare broker name, as before', async () => {
  const { successes } = await run(
    eml(['To: anyone@example.net']),
    { pendingKeys: ['Spokeo'] }
  );

  assert.deepEqual(successes, ['Spokeo']);
});

test('dryRun in multi-person mode reports the resolved person without clicking', async () => {
  const { result, ctx, successes } = await run(
    eml(['To: bob@example.com']),
    { persons: [ALICE, BOB], pendingKeys: ['Spokeo|Bob Builder'], dryRun: true }
  );

  assert.equal(ctx.calls.length, 0);
  assert.equal(successes.length, 0);
  assert.equal(result.processed[0].key, 'Spokeo|Bob Builder');
});

test('addressesIn ignores quoted display names and comments, lowercases, handles lists', () => {
  assert.deepEqual(
    addressesIn('"Doe, Jane" <Jane@Example.com>, (old: x@y.com) bob@example.com'),
    ['jane@example.com', 'bob@example.com']
  );
});
