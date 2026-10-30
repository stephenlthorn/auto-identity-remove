/**
 * test/relay.test.js
 *
 * Pure unit tests for lib/relay.js.
 * No live network. No real config.json / state.json.
 *
 * Tested behaviours:
 *  1. getSubmissionEmail - no relay configured -> returns person.email unchanged
 *  2. getSubmissionEmail - relay configured but no apiKey -> fails closed (see relay-simplelogin.test.js)
 *  3. getSubmissionEmail - relay configured -> calls createImpl, caches alias
 *  4. getSubmissionEmail - second call reuses cached alias (createImpl not called again)
 *  5. getSubmissionEmail - distinct persons get distinct cache slots
 *  6. personKey - stable, lowercased email-based key
 *  7. createSimpleLoginAlias - posts to the documented endpoint with Authentication header
 *  8. createSimpleLoginAlias - throws a useful error on non-ok response
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getSubmissionEmail,
  personKey,
  createSimpleLoginAlias,
  RELAY_PROVIDERS,
} = require('../lib/relay');

// -- Fixtures ------------------------------------------------------------------

const PERSON_A = {
  firstName: 'Jane',
  lastName: 'Doe',
  fullName: 'Jane Doe',
  email: 'jane.doe@example.com',
};

const PERSON_B = {
  firstName: 'John',
  lastName: 'Smith',
  fullName: 'John Smith',
  email: 'john.smith@example.com',
};

function makeState() {
  return { optOuts: {} };
}

const RELAY_CFG = { relay: { provider: 'simplelogin', apiKey: 'sl-test-key' } };

// -- Tests --------------------------------------------------------------------

test('no relay configured returns person.email unchanged', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'should-not-be-used@aliases.test'; };

  const out = await getSubmissionEmail({ config: {}, person: PERSON_A, state, createImpl });

  assert.equal(out, 'jane.doe@example.com');
  assert.equal(createCalls, 0, 'createImpl must not be called when relay is absent');
  assert.equal(state.relayAliases, undefined, 'state must not be mutated when relay is absent');
});

test('relay configured but missing apiKey fails closed instead of falling back to person.email (NET-3)', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'x@aliases.test'; };

  await assert.rejects(
    () => getSubmissionEmail({
      config: { relay: { provider: 'simplelogin' } },
      person: PERSON_A,
      state,
      createImpl,
    }),
    (err) => err.code === 'RELAY_UNAVAILABLE'
  );
  assert.equal(createCalls, 0, 'createImpl must not be called without an apiKey');
});

test('relay configured creates an alias via createImpl and caches it', async () => {
  const state = makeState();
  const createArgs = [];
  const createImpl = async (args) => { createArgs.push(args); return 'jane.alias@aliases.simplelogin.io'; };

  const out = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });

  assert.equal(out, 'jane.alias@aliases.simplelogin.io');
  assert.equal(createArgs.length, 1, 'createImpl should be called exactly once');
  assert.equal(createArgs[0].apiKey, 'sl-test-key');
  assert.equal(createArgs[0].note.includes('Jane Doe'), true, 'note should reference the person');
  const key = personKey(PERSON_A);
  assert.equal(state.relayAliases[key], 'jane.alias@aliases.simplelogin.io');
});

test('second call reuses the cached alias without calling createImpl again', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'cached@aliases.simplelogin.io'; };

  const first = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });
  const second = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });

  assert.equal(first, 'cached@aliases.simplelogin.io');
  assert.equal(second, 'cached@aliases.simplelogin.io');
  assert.equal(createCalls, 1, 'createImpl should run only on the first call');
});

test('distinct persons get distinct cached aliases', async () => {
  const state = makeState();
  const createImpl = async ({ note }) => (note.includes('Jane Doe') ? 'jane@a.io' : 'john@a.io');

  const a = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });
  const b = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_B, state, createImpl });

  assert.equal(a, 'jane@a.io');
  assert.equal(b, 'john@a.io');
  assert.notEqual(personKey(PERSON_A), personKey(PERSON_B));
});

test('personKey is stable and case-insensitive on email', () => {
  const upper = personKey({ email: 'Jane.Doe@Example.com', firstName: 'Jane', lastName: 'Doe' });
  const lower = personKey({ email: 'jane.doe@example.com', firstName: 'Jane', lastName: 'Doe' });
  assert.equal(upper, lower);
});

test('RELAY_PROVIDERS lists simplelogin', () => {
  assert.equal(RELAY_PROVIDERS.includes('simplelogin'), true);
});

test('createSimpleLoginAlias posts to the documented endpoint with Authentication header', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ alias: 'generated.alias@aliases.simplelogin.io' }),
    };
  };

  const alias = await createSimpleLoginAlias({ apiKey: 'sl-test-key', note: 'opt-out for Jane Doe', fetchImpl });

  assert.equal(alias, 'generated.alias@aliases.simplelogin.io');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://app.simplelogin.io/api/alias/random/new');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].init.headers.Authentication, 'sl-test-key');
  assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
  const sentBody = JSON.parse(fetchCalls[0].init.body);
  assert.equal(sentBody.note, 'opt-out for Jane Doe');
});

test('createSimpleLoginAlias throws a useful error on a non-ok response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Wrong api key' }),
  });

  await assert.rejects(
    () => createSimpleLoginAlias({ apiKey: 'bad', note: 'x', fetchImpl }),
    /SimpleLogin alias creation failed.*401/
  );
});
