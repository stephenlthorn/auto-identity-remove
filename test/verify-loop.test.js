/**
 * test/verify-loop.test.js
 *
 * Tests for lib/verify-loop.js — T+7 day post-submit verification loop.
 *
 * Verified behaviours:
 *  1. lastSuccess 8 days ago, listing absent  → verified_clear bucket + verifiedDeletedAt written
 *  2. lastSuccess 8 days ago, listing present → still_listed bucket + verifiedStillListedAt written
 *  3. lastSuccess 2 days ago                  → skipped (too recent, < 7 days)
 *  4. direct-form broker (no searchUrl)       → unverifiable
 *  5. no lastSuccess recorded                 → skipped (never submitted)
 *  6. multi-person: each person verified independently for same broker
 *  7. after still_listed, next run re-checks (verifiedStillListedAt present does NOT prevent re-check)
 *  8. verifyHistory appended on each outcome
 *  9. verifiedDeletedAt already set but older than lastSuccess → re-checks
 * 10. verifiedDeletedAt set and newer than lastSuccess → skipped
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Silence console/stdout during tests ────────────────────────────────────────
let origLog, origWrite;
beforeEach(() => {
  origLog   = console.log;
  origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = () => true;
});
afterEach(() => {
  console.log = origLog;
  process.stdout.write = origWrite;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Fake Playwright context — newPage() returns a stub. */
function makeContext() {
  const stub = {
    close: async () => {},
    goto:     async () => {},
    evaluate: async () => [],
    locator:  () => ({ first: () => ({ count: async () => 0 }) }),
    click:    () => { throw new Error('click() must not be called in verify mode'); },
    fill:     () => { throw new Error('fill() must not be called in verify mode'); },
  };
  return { newPage: async () => stub };
}

/** Build a search-form broker. */
function searchBroker(name) {
  return {
    name,
    method: 'search-form',
    searchUrl: `https://${name}.example/search`,
    listingPattern: /example\.com\/listing\/\d+/i,
  };
}

/** Build a direct-form broker (no searchUrl / no listingPattern). */
function directBroker(name) {
  return { name, method: 'direct-form', optOutUrl: `https://${name}.example/optout` };
}

/** Build state with a lastSuccess N days ago (default 8). */
function makeState(brokerName, lastSuccessDaysAgo = 8, extras = {}) {
  return {
    optOuts: {
      [brokerName]: {
        lastSuccess: daysAgo(lastSuccessDaysAgo),
        totalRuns: 1,
        ...extras,
      },
    },
  };
}

const { runVerify } = require('../lib/verify-loop');

// ── Test 1: verified_clear + verifiedDeletedAt written ───────────────────────
test('lastSuccess 8d ago, listing absent → verified_clear and verifiedDeletedAt written', async () => {
  const broker  = searchBroker('ClearBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = makeState('ClearBroker', 8);
  const context = makeContext();

  const fakeFind = async () => null; // listing not found

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.verified_clear.length, 1, 'one entry in verified_clear');
  assert.equal(result.verified_clear[0].broker, 'ClearBroker');
  assert.equal(result.verified_clear[0].person, person);
  assert.equal(result.still_listed.length, 0);
  assert.equal(result.unverifiable.length, 0);
  assert.equal(result.skipped.length, 0);

  // State must have been updated
  const entry = state.optOuts['ClearBroker'];
  assert.ok(entry.verifiedDeletedAt, 'verifiedDeletedAt must be written');
  assert.ok(Array.isArray(entry.verifyHistory), 'verifyHistory must be an array');
  assert.equal(entry.verifyHistory[entry.verifyHistory.length - 1].outcome, 'verified_clear');
});

// ── Test 2: still_listed + verifiedStillListedAt written ─────────────────────
test('lastSuccess 8d ago, listing present → still_listed and verifiedStillListedAt written', async () => {
  const broker  = searchBroker('ListedBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = makeState('ListedBroker', 8);
  const context = makeContext();

  const fakeFind = async () => 'https://listedbroker.example/listing/42';

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.still_listed.length, 1);
  assert.equal(result.still_listed[0].broker, 'ListedBroker');
  assert.equal(result.still_listed[0].person, person);
  assert.equal(result.verified_clear.length, 0);

  const entry = state.optOuts['ListedBroker'];
  assert.ok(entry.verifiedStillListedAt, 'verifiedStillListedAt must be written');
  assert.equal(entry.verifyHistory[entry.verifyHistory.length - 1].outcome, 'still_listed');
  // verifiedDeletedAt should NOT be set
  assert.equal(entry.verifiedDeletedAt, undefined, 'verifiedDeletedAt must not be set on still_listed');
});

// ── Test 3: too recent → skipped ──────────────────────────────────────────────
test('lastSuccess 2d ago → skipped (< 7 days)', async () => {
  const broker  = searchBroker('RecentBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = makeState('RecentBroker', 2);
  const context = makeContext();

  const fakeFind = async () => { throw new Error('should not be called'); };

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].broker, 'RecentBroker');
  assert.ok(result.skipped[0].reason, 'skipped entry must have a reason');
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.still_listed.length, 0);
});

// ── Test 4: direct-form broker → unverifiable ─────────────────────────────────
test('direct-form broker (no searchUrl) → unverifiable', async () => {
  const broker  = directBroker('DirectOptOut');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = makeState('DirectOptOut', 8);
  const context = makeContext();

  const fakeFind = async () => { throw new Error('should not be called'); };

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.unverifiable.length, 1);
  assert.equal(result.unverifiable[0].broker, 'DirectOptOut');
  assert.equal(result.unverifiable[0].person, person);
  assert.ok(result.unverifiable[0].reason, 'unverifiable entry must have a reason');
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.still_listed.length, 0);
  assert.equal(result.skipped.length, 0);
});

// ── Test 5: no lastSuccess → skipped ─────────────────────────────────────────
test('broker with no lastSuccess → skipped (never submitted)', async () => {
  const broker  = searchBroker('NeverOptedOut');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = { optOuts: {} }; // no entry for this broker
  const context = makeContext();

  const fakeFind = async () => { throw new Error('should not be called'); };

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].broker, 'NeverOptedOut');
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.still_listed.length, 0);
  assert.equal(result.unverifiable.length, 0);
});

// ── Test 6: multi-person — each person verified independently ─────────────────
test('multi-person: each person is verified independently for the same broker', async () => {
  const broker  = searchBroker('MultiPerson');
  const alice   = { firstName: 'Alice', lastName: 'Smith' };
  const bob     = { firstName: 'Bob',   lastName: 'Jones' };

  // Each person gets their own state entry
  const state = {
    optOuts: {
      'MultiPerson|Alice Smith': { lastSuccess: daysAgo(10), totalRuns: 1 },
      'MultiPerson|Bob Jones':   { lastSuccess: daysAgo(10), totalRuns: 1 },
    },
  };
  const context = makeContext();

  // Alice: clear, Bob: still listed
  const fakeFind = async (_page, _broker, person) => {
    if (person && person.firstName === 'Alice') return null;
    return 'https://multibroker.example/listing/1';
  };

  const result = await runVerify(context, [broker], [alice, bob], { findUrl: fakeFind, state });

  assert.equal(result.verified_clear.length, 1, 'Alice should be verified_clear');
  assert.equal(result.verified_clear[0].person, alice);
  assert.equal(result.still_listed.length, 1, 'Bob should be still_listed');
  assert.equal(result.still_listed[0].person, bob);
});

// ── Test 7: still_listed does NOT prevent re-check on next run ────────────────
test('still_listed on previous run: next runVerify still re-checks (no skip)', async () => {
  const broker  = searchBroker('StillListedBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  // State has verifiedStillListedAt set (previous run found listing) but lastSuccess >= 7d
  const state   = makeState('StillListedBroker', 10, {
    verifiedStillListedAt: daysAgo(1),
    verifyHistory: [{ at: daysAgo(1), outcome: 'still_listed' }],
  });
  const context = makeContext();

  // This time the listing is gone
  const fakeFind = async () => null;

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.verified_clear.length, 1, 'should re-check and find clear');
  assert.equal(result.skipped.length, 0, 'must not skip because of prior still_listed');
});

// ── Test 8: verifyHistory is appended on each run ─────────────────────────────
test('verifyHistory accumulates across multiple calls', async () => {
  const broker  = searchBroker('HistoryBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const context = makeContext();

  // First call: lastSuccess 10d ago, no prior verify → should run and find listing
  const state1 = makeState('HistoryBroker', 10);
  await runVerify(context, [broker], [person], { findUrl: async () => 'https://x.com/1', state: state1 });

  assert.ok(state1.optOuts['HistoryBroker'].verifyHistory.length >= 1, 'first call writes history');
  assert.equal(state1.optOuts['HistoryBroker'].verifyHistory[0].outcome, 'still_listed');

  // Second call: simulate a new submission (lastSuccess more recent than verifiedStillListedAt)
  // by updating the state to have a fresh lastSuccess and then calling again.
  // Move lastSuccess forward past the verifiedStillListedAt by using a brand-new state
  // that has the verifyHistory from the first run but a fresh lastSuccess (8d ago reset).
  const state2 = {
    optOuts: {
      'HistoryBroker': {
        ...state1.optOuts['HistoryBroker'],
        lastSuccess: daysAgo(8),
        // verifiedStillListedAt from state1 is still there but verifiedDeletedAt is absent
        // so gate 3 (verifiedDeletedAt newer than lastSuccess) does NOT fire
        verifiedDeletedAt: undefined,
      },
    },
  };
  // Remove undefined keys so they don't interfere
  delete state2.optOuts['HistoryBroker'].verifiedDeletedAt;

  await runVerify(context, [broker], [person], { findUrl: async () => null, state: state2 });

  const history = state2.optOuts['HistoryBroker'].verifyHistory;
  assert.ok(history.length >= 2, 'should have at least 2 history entries after two calls');
  assert.equal(history[history.length - 1].outcome, 'verified_clear');
});

// ── Test 9: verifiedDeletedAt older than lastSuccess → re-checks ──────────────
test('verifiedDeletedAt older than lastSuccess → re-checks (new submit since last verify)', async () => {
  const broker  = searchBroker('StaleVerifyBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  // verifiedDeletedAt set 20d ago, lastSuccess set 8d ago (more recent — re-check needed)
  const state   = makeState('StaleVerifyBroker', 8, {
    verifiedDeletedAt: daysAgo(20),
  });
  const context = makeContext();

  const fakeFind = async () => null;

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.verified_clear.length, 1, 'should re-check when verifiedDeletedAt < lastSuccess');
  assert.equal(result.skipped.length, 0);
});

// ── Test 10: verifiedDeletedAt newer than lastSuccess → skip ──────────────────
test('verifiedDeletedAt newer than lastSuccess → skipped (already verified after last submit)', async () => {
  const broker  = searchBroker('FreshVerifyBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  // lastSuccess 8d ago, verifiedDeletedAt 3d ago (more recent than lastSuccess → skip)
  const state   = makeState('FreshVerifyBroker', 8, {
    verifiedDeletedAt: daysAgo(3),
  });
  const context = makeContext();

  const fakeFind = async () => { throw new Error('should not be called'); };

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.skipped.length, 1, 'should skip when already verified after last submit');
  assert.equal(result.skipped[0].broker, 'FreshVerifyBroker');
  assert.equal(result.verified_clear.length, 0);
});

// ── Test 11: findListingUrl error → unverifiable ──────────────────────────────
test('findListingUrl throws → unverifiable (not a false positive)', async () => {
  const broker  = searchBroker('FlakeyBroker');
  const person  = { firstName: 'Jane', lastName: 'Doe' };
  const state   = makeState('FlakeyBroker', 8);
  const context = makeContext();

  const fakeFind = async () => { throw new Error('net::ERR_TIMED_OUT'); };

  const result = await runVerify(context, [broker], [person], { findUrl: fakeFind, state });

  assert.equal(result.unverifiable.length, 1);
  assert.equal(result.unverifiable[0].broker, 'FlakeyBroker');
  assert.ok(result.unverifiable[0].reason.includes('search failed'));
  assert.equal(result.still_listed.length, 0);
  assert.equal(result.verified_clear.length, 0);
});
