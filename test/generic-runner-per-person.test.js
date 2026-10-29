/**
 * test/generic-runner-per-person.test.js
 *
 * Cross-model review finding P1 #3, now fixed properly.
 *
 * The generic pass over ~490 brokers ran ONCE, outside watcher.js's
 * `for (const person of persons)` loop, and filled every form from
 * `activePerson()` = `persons[0]`. State was keyed on the bare broker name with
 * no person component. So for a household config:
 *
 *   - only persons[0] was ever actually submitted to the form-based brokers;
 *   - every other person was left uncovered; and
 *   - the single state entry marked the broker done for all of them, so the next
 *     run skipped it and the report claimed everyone was opted out.
 *
 * Explicit brokers already got this right via stateKey(name, person, count),
 * which produces "Broker|First Last" in multi-person mode. The generic runner now
 * uses the same convention and takes the person to submit as an argument.
 *
 * Cost, stated openly: a multi-person run now does the generic pass once per
 * person, so the wall-clock of an N-person monthly run scales with N. Correct
 * coverage is worth it; silently telling someone their spouse was removed from
 * 490 brokers is not.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runGenericBrokers, _setConfig } = require('../generic-runner');
const { stateKey } = require('../lib/config');

const ALICE = {
  firstName: 'Alice', lastName: 'Anderson', fullName: 'Alice Anderson',
  email: 'alice@example.com', state: 'CA', zip: '94601',
};
const BOB = {
  firstName: 'Bob', lastName: 'Baker', fullName: 'Bob Baker',
  email: 'bob@example.com', state: 'NY', zip: '10001',
};

const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

/**
 * Minimal context whose page is one real opt-out form. What gets typed lands in
 * `filled`; the form confirms with success wording, so the run is recorded.
 */
function makeContext(filled) {
  const page = makeFakePage({
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const typed = page.filled;
  typed.push = (entry) => { filled.push(entry.value); return Array.prototype.push.call(typed, entry); };
  return { newPage: async () => page };
}

/** Run the generic pass for one person against a single injected broker. */
async function runFor(person, personCount, state, filled) {
  const recorded = [];
  await runGenericBrokers(
    makeContext(filled),
    new Set(),
    state,
    () => {},
    (key, detail) => recorded.push({ key, detail }),
    {
      dryRun: false,
      person,
      personCount,
      injectedBrokers: [{ name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'test' }],
      injectedDeadSet: new Set(),
    },
  );
  return recorded;
}

test.before(() => {
  _setConfig({ persons: [ALICE, BOB] });
});

test('the person passed in is the person whose details are submitted', async () => {
  const filled = [];
  await runFor(BOB, 2, { optOuts: {} }, filled);
  assert.ok(filled.includes(BOB.email), "Bob's run must submit Bob's email");
  assert.ok(!filled.includes(ALICE.email), "Bob's run must not submit Alice's email");
});

test('each person in a household submits their own details', async () => {
  const aliceFilled = [];
  const bobFilled = [];
  const state = { optOuts: {} };
  await runFor(ALICE, 2, state, aliceFilled);
  await runFor(BOB, 2, state, bobFilled);

  assert.ok(aliceFilled.includes(ALICE.email));
  assert.ok(bobFilled.includes(BOB.email));
  assert.ok(!bobFilled.includes(ALICE.email), "the second person's run must not reuse the first person's PII");
});

test('state is keyed per person, so one person being done does not skip another', async () => {
  const state = { optOuts: {} };
  const aliceRecorded = await runFor(ALICE, 2, state, []);
  assert.equal(aliceRecorded.length, 1, "precondition: Alice's submission is recorded");
  assert.equal(
    aliceRecorded[0].key,
    stateKey('ExampleBroker', ALICE, 2),
    'the generic runner must use the same composite key as the explicit brokers',
  );

  // Simulate the recorded success landing in state, as recordSuccess would.
  state.optOuts[stateKey('ExampleBroker', ALICE, 2)] = {
    lastSuccess: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
  };

  const bobFilled = [];
  const bobRecorded = await runFor(BOB, 2, state, bobFilled);
  assert.equal(
    bobRecorded.length,
    1,
    "Bob must still be submitted even though the same broker is already done for Alice",
  );
  assert.ok(bobFilled.includes(BOB.email));
});

test("a person already done is skipped by their own key, not someone else's", async () => {
  const state = { optOuts: {} };
  state.optOuts[stateKey('ExampleBroker', BOB, 2)] = {
    lastSuccess: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
  };
  const bobFilled = [];
  const bobRecorded = await runFor(BOB, 2, state, bobFilled);
  assert.equal(bobRecorded.length, 0, 'a recent success for this person must suppress a resubmission');
  assert.equal(bobFilled.length, 0, 'and must not retype PII into the form');
});

test('single-person configs keep the bare broker name as the state key', async () => {
  // Backwards compatibility: existing state files use the bare name, and a key
  // change would silently resubmit every broker for every existing user.
  const recorded = await runFor(ALICE, 1, { optOuts: {} }, []);
  assert.equal(recorded[0].key, 'ExampleBroker');
  assert.equal(stateKey('ExampleBroker', ALICE, 1), 'ExampleBroker');
});

test('omitting person falls back to the config, preserving old call sites', async () => {
  const filled = [];
  const recorded = [];
  await runGenericBrokers(
    makeContext(filled),
    new Set(),
    { optOuts: {} },
    () => {},
    (key, detail) => recorded.push({ key, detail }),
    {
      dryRun: false,
      injectedBrokers: [{ name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'test' }],
      injectedDeadSet: new Set(),
    },
  );
  assert.equal(recorded[0].key, 'ExampleBroker', 'no person + no count behaves as single-person');
  assert.ok(filled.includes(ALICE.email), 'and falls back to persons[0] from config');
});
