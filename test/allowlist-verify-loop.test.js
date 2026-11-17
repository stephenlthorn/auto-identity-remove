/**
 * test/allowlist-verify-loop.test.js
 *
 * Verifies runVerify skips allowlisted brokers entirely:
 *   - an allowlisted broker is NOT re-searched (findUrl is never called for it)
 *   - it is NOT placed in still_listed (even though, un-allowlisted, it would be)
 *   - it appears in skipped with an allowlist reason
 *
 * A non-allowlisted broker with the same state is still searched and classified,
 * proving the guard is scoped to the allowlist.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runVerify } = require('../lib/verify-loop');

const PERSON = { firstName: 'Test', lastName: 'User' };

// 30 days ago - past the 7-day VERIFY_AFTER_DAYS gate.
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 86400000).toISOString();

function makeBroker(name) {
  return {
    name,
    method: 'search-form',
    searchUrl: `https://example.com/${name}/search`,
    listingPattern: /found/i,
  };
}

function makeContext() {
  return { newPage: async () => ({ close: async () => {} }) };
}

test('runVerify: allowlisted broker is skipped, not searched, not still_listed', async () => {
  const searched = [];
  // findUrl returns a non-null URL => would normally classify as still_listed.
  const findUrl = async (_page, broker) => { searched.push(broker.name); return 'https://example.com/listing'; };

  const state = {
    optOuts: {
      AllowedBroker: { lastSuccess: THIRTY_DAYS_AGO },
      NormalBroker: { lastSuccess: THIRTY_DAYS_AGO },
    },
  };

  const brokers = [makeBroker('AllowedBroker'), makeBroker('NormalBroker')];

  const result = await runVerify(makeContext(), brokers, [PERSON], {
    state,
    findUrl,
    config: { allowlist: ['AllowedBroker'] },
  });

  assert.ok(!searched.includes('AllowedBroker'), 'findUrl must NOT run for an allowlisted broker');
  assert.ok(searched.includes('NormalBroker'), 'findUrl SHOULD run for a non-allowlisted broker');

  assert.ok(
    !result.still_listed.some(e => e.broker === 'AllowedBroker'),
    'allowlisted broker must never be counted as still_listed'
  );
  assert.ok(
    result.still_listed.some(e => e.broker === 'NormalBroker'),
    'non-allowlisted broker with a found listing should be still_listed'
  );

  const skip = result.skipped.find(e => e.broker === 'AllowedBroker');
  assert.ok(skip, 'allowlisted broker should be in skipped');
  assert.match(skip.reason, /allowlist/i);
});

test('runVerify: no config (default) preserves existing behavior', async () => {
  const findUrl = async () => null; // listing absent => verified_clear
  // A listing was seen before, so an empty search page now is a removal.
  const state = { optOuts: { NormalBroker: { lastSuccess: THIRTY_DAYS_AGO, verifiedStillListedAt: new Date(Date.now() - 60 * 86400000).toISOString() } } };
  const brokers = [makeBroker('NormalBroker')];

  const result = await runVerify(makeContext(), brokers, [PERSON], { state, findUrl });

  assert.ok(result.verified_clear.some(e => e.broker === 'NormalBroker'));
});
