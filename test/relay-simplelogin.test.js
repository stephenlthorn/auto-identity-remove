/**
 * test/relay-simplelogin.test.js
 *
 * NET-3 (P1): lib/relay.js called POST /api/alias/custom/new with {note}, which
 * is not a valid SimpleLogin call, so alias creation always failed and the real
 * email was used silently. The earlier tests mocked fetch and passed anyway.
 *
 * Pins: the real random-alias endpoint, fail-closed behaviour (the real address
 * is never returned on failure unless relay.failOpen === true), and dry-run
 * never minting an alias.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getSubmissionEmail,
  resolveSubmissionEmail,
  createSimpleLoginAlias,
  RelayUnavailableError,
  DRY_RUN_PLACEHOLDER,
  SIMPLELOGIN_ALIAS_URL,
} = require('../lib/relay');

const PERSON = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'jane.doe@example.com' };
const RELAY = { relay: { provider: 'simplelogin', apiKey: 'sl-test-key' } };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function quietWarn() {
  const lines = [];
  return { lines, warn: (msg) => lines.push(String(msg)) };
}

// -- the request itself -------------------------------------------------------

test('createSimpleLoginAlias POSTs to the random-alias endpoint with the Authentication header and a note', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse(201, { alias: 'quick.fox@simplelogin.com' });
  };

  const alias = await createSimpleLoginAlias({ apiKey: 'sl-key', note: 'opt-outs for Jane', fetchImpl });

  assert.equal(alias, 'quick.fox@simplelogin.com');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://app.simplelogin.io/api/alias/random/new');
  assert.equal(SIMPLELOGIN_ALIAS_URL, 'https://app.simplelogin.io/api/alias/random/new');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authentication, 'sl-key');
  assert.deepEqual(JSON.parse(seen[0].init.body), { note: 'opt-outs for Jane' });
});

test('createSimpleLoginAlias accepts the alias in the "email" field too (documented alias-object shape)', async () => {
  const fetchImpl = async () => jsonResponse(201, { id: 7, email: 'calm.owl@simplelogin.com' });

  assert.equal(await createSimpleLoginAlias({ apiKey: 'k', note: 'n', fetchImpl }), 'calm.owl@simplelogin.com');
});

test('createSimpleLoginAlias rejects a response with no usable address', async () => {
  const fetchImpl = async () => jsonResponse(201, { id: 7 });

  await assert.rejects(() => createSimpleLoginAlias({ apiKey: 'k', note: 'n', fetchImpl }), /alias/i);
});

test('createSimpleLoginAlias surfaces HTTP status and the server error text', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'Wrong api key' });

  await assert.rejects(
    () => createSimpleLoginAlias({ apiKey: 'bad', note: 'n', fetchImpl }),
    /401.*Wrong api key/
  );
});

// -- fail closed --------------------------------------------------------------

test('creation failure throws RelayUnavailableError and never hands back the real email', async () => {
  const state = { optOuts: {} };
  const createImpl = async () => { throw new Error('HTTP 404'); };

  await assert.rejects(
    () => getSubmissionEmail({ config: RELAY, person: PERSON, state, createImpl }),
    (err) => err instanceof RelayUnavailableError && err.code === 'RELAY_UNAVAILABLE' && /404/.test(err.message)
  );
  assert.deepEqual(state.relayAliases || {}, {}, 'nothing cached on failure');
});

test('resolveSubmissionEmail returns { email: null, error } on failure and never throws', async () => {
  const createImpl = async () => { throw new Error('boom'); };

  const out = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state: {}, createImpl });

  assert.equal(out.email, null);
  assert.equal(out.source, 'unavailable');
  assert.match(out.error.message, /boom/);
});

test('through the real request path: a 404 from SimpleLogin does not leak person.email', async () => {
  const fetchImpl = async () => jsonResponse(404, { error: 'not found' });

  const out = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state: {}, fetchImpl });

  assert.equal(out.email, null);
  assert.notEqual(out.email, PERSON.email);
});

test('a relay block that names a provider but has no apiKey fails closed (the user asked for masking)', async () => {
  const out = await resolveSubmissionEmail({
    config: { relay: { provider: 'simplelogin' } },
    person: PERSON,
    state: {},
    createImpl: async () => { throw new Error('must not be called'); },
  });

  assert.equal(out.email, null);
  assert.equal(out.source, 'unavailable');
});

test('an unsupported provider fails closed', async () => {
  const out = await resolveSubmissionEmail({
    config: { relay: { provider: 'madeup', apiKey: 'k' } },
    person: PERSON,
    state: {},
  });

  assert.equal(out.email, null);
});

test('createImpl returning nothing is a failure, not a silent fallback to the real email', async () => {
  const out = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state: {}, createImpl: async () => '' });

  assert.equal(out.email, null);
});

test('createImpl returning a non-address is rejected', async () => {
  const out = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state: {}, createImpl: async () => 'not-an-email' });

  assert.equal(out.email, null);
});

// -- explicit opt-in to the old behaviour ------------------------------------

test('relay.failOpen === true falls back to the real email with a loud warning', async () => {
  const { lines, warn } = quietWarn();
  const config = { relay: { ...RELAY.relay, failOpen: true } };

  const out = await resolveSubmissionEmail({
    config, person: PERSON, state: {}, warn,
    createImpl: async () => { throw new Error('HTTP 500'); },
  });

  assert.equal(out.email, PERSON.email);
  assert.equal(out.source, 'real-fallback');
  assert.match(out.error.message, /500/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /REAL email/i);
  assert.match(lines[0], /failOpen/);
});

test('failOpen must be exactly true: truthy strings do not opt in', async () => {
  const config = { relay: { ...RELAY.relay, failOpen: 'true' } };

  const out = await resolveSubmissionEmail({
    config, person: PERSON, state: {}, warn: () => {},
    createImpl: async () => { throw new Error('x'); },
  });

  assert.equal(out.email, null);
});

test('getSubmissionEmail with failOpen returns the real email string', async () => {
  const config = { relay: { ...RELAY.relay, failOpen: true } };

  const email = await getSubmissionEmail({
    config, person: PERSON, state: {}, warn: () => {},
    createImpl: async () => { throw new Error('x'); },
  });

  assert.equal(email, PERSON.email);
});

// -- dry run -----------------------------------------------------------------

test('dryRun never creates an alias and does not touch state when none is cached', async () => {
  const state = { optOuts: {} };
  let created = 0;

  const email = await getSubmissionEmail({
    config: RELAY, person: PERSON, state, dryRun: true,
    createImpl: async () => { created += 1; return 'x@simplelogin.com'; },
  });

  assert.equal(created, 0);
  assert.equal(email, DRY_RUN_PLACEHOLDER);
  assert.equal(DRY_RUN_PLACEHOLDER, 'relay-alias-would-be-created@example.invalid');
  assert.equal(state.relayAliases, undefined);
});

test('dryRun reuses a cached alias', async () => {
  const state = { relayAliases: { 'jane.doe@example.com': 'cached.alias@simplelogin.com' } };

  const out = await resolveSubmissionEmail({
    config: RELAY, person: PERSON, state, dryRun: true,
    createImpl: async () => { throw new Error('must not be called'); },
  });

  assert.equal(out.email, 'cached.alias@simplelogin.com');
  assert.equal(out.source, 'cache');
});

test('dryRun with no relay configured still returns the real email (nothing to mask)', async () => {
  const email = await getSubmissionEmail({ config: {}, person: PERSON, state: {}, dryRun: true });

  assert.equal(email, PERSON.email);
});

// -- unchanged happy paths ---------------------------------------------------

test('success: alias is created once, cached under personKey, and returned', async () => {
  const state = {};
  let calls = 0;
  const createImpl = async () => { calls += 1; return 'fresh.alias@simplelogin.com'; };

  const first = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state, createImpl });
  const second = await resolveSubmissionEmail({ config: RELAY, person: PERSON, state, createImpl });

  assert.equal(first.email, 'fresh.alias@simplelogin.com');
  assert.equal(first.source, 'created');
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1);
  assert.deepEqual(state.relayAliases, { 'jane.doe@example.com': 'fresh.alias@simplelogin.com' });
});

test('no relay configured: real email, no state mutation', async () => {
  const state = {};

  const out = await resolveSubmissionEmail({ config: {}, person: PERSON, state });

  assert.equal(out.email, PERSON.email);
  assert.equal(out.source, 'real');
  assert.equal(state.relayAliases, undefined);
});

test('an empty relay block ({}) counts as not configured', async () => {
  const out = await resolveSubmissionEmail({ config: { relay: {} }, person: PERSON, state: {} });

  assert.equal(out.email, PERSON.email);
});
