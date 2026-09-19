/**
 * test/multi-person-keying.test.js
 *
 * TDD tests for H1: multi-person state-key consistency.
 *
 * Verified behaviours:
 *  1. stateKey('X', {firstName:'A',lastName:'B'}, 1)  === 'X'   (single person)
 *  2. stateKey('X', {firstName:'A',lastName:'B'}, 2)  === 'X|A B' (multi-person)
 *  3. stateKey('X', null, 3)                          === 'X'   (no person)
 *  4. brokerRunner with personCount:1 -> recordSuccess('BrokerName', ...)
 *  5. brokerRunner with personCount:2 and person Jane Doe -> recordSuccess('BrokerName|Jane Doe', ...)
 *  6. shouldSkip called with composite key when personCount:2
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

// ── stateKey unit tests (directly from config) ─────────────────────────────────

test('stateKey: single-person (totalPersons=1) returns bare broker name', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', { firstName: 'A', lastName: 'B' }, 1), 'X');
});

test('stateKey: multi-person (totalPersons=2) returns composite key', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', { firstName: 'A', lastName: 'B' }, 2), 'X|A B');
});

test('stateKey: null person always returns bare broker name', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', null, 3), 'X');
});

test('stateKey: no person arg (undefined) returns bare broker name', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', undefined, 2), 'X');
});

test('stateKey: totalPersons=0 returns bare broker name', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', { firstName: 'A', lastName: 'B' }, 0), 'X');
});

test('stateKey: totalPersons omitted (undefined) returns bare broker name', () => {
  const { stateKey } = require('../lib/config');
  assert.equal(stateKey('X', { firstName: 'A', lastName: 'B' }), 'X');
});

// ── broker-runner keying tests ─────────────────────────────────────────────────

// Capture state operation keys
const recorded = { successKeys: [], failureKeys: [], skipCheckedKeys: [], checkpointKeys: [] };

let classifyReturn = { outcome: 'success', snippet: 'You have been removed.' };

const configMockFactory = () => ({
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: (key) => { recorded.skipCheckedKeys.push(key); return null; },
  isPendingConfirmation: () => false,
  recordSuccess: (key) => recorded.successKeys.push(key),
  recordPendingConfirmation: () => {},
  recordFailure: (key) => recorded.failureKeys.push(key),
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: (key) => recorded.checkpointKeys.push(key),
  stateKey: require('../lib/config').stateKey,
});

function makePatchedLoad(configMock) {
  return function patchedLoad(request, parent, isMain) {
    if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
    if (request === './config') return configMock;
    if (request === './logger') return {
      logResult: () => {},
      STATUS_BUCKET: {},
    };
    if (request === './forms') return {
      fillForm: async () => {},
      findListingUrl: async () => null,
    };
    if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
    if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
    if (request === './success') return { classifyPostSubmit: () => classifyReturn };
    if (request === './retry') return { withRetry: fn => fn() };
    if (request === './timing') return { jitterSleep: async () => {} };
    if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
    return originalLoad(request, parent, isMain);
  };
}

function clearRecorded() {
  recorded.successKeys.length = 0;
  recorded.failureKeys.length = 0;
  recorded.skipCheckedKeys.length = 0;
  recorded.checkpointKeys.length = 0;
}

function makeContext() {
  return {
    newPage: async () => ({
      goto: async () => {},
      locator: () => ({
        first: () => ({
          fill: async () => {},
          count: async () => 1,
          isVisible: async () => true,
          click: async () => {},
        }),
      }),
      evaluate: async () => 'You have been removed.',
      close: async () => {},
    }),
  };
}

const DIRECT_BROKER = {
  name: 'BrokerName',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

const JANE = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', country: 'US' };

// Load broker-runner with fresh mocks for each keying test group.
// We do this once here since the mock captures are module-level.
const configMock = configMockFactory();
Module._load = makePatchedLoad(configMock);
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

// ── Test 4: personCount:1 uses bare broker name ────────────────────────────────

test('broker-runner personCount:1 - recordSuccess called with bare broker name', async () => {
  clearRecorded();
  classifyReturn = { outcome: 'success', snippet: 'You have been removed.' };
  configure({ dryRun: false, person: JANE, capsolver: null, personCount: 1 });

  await processBrokerWithPerson(makeContext(), DIRECT_BROKER, JANE);

  assert.ok(
    recorded.successKeys.length > 0,
    'recordSuccess must have been called'
  );
  assert.equal(
    recorded.successKeys[0],
    'BrokerName',
    'personCount:1 must use bare broker name'
  );
});

// ── Test 5: personCount:2 uses composite key ───────────────────────────────────

test('broker-runner personCount:2 - recordSuccess called with composite key', async () => {
  clearRecorded();
  classifyReturn = { outcome: 'success', snippet: 'You have been removed.' };
  configure({ dryRun: false, person: JANE, capsolver: null, personCount: 2 });

  await processBrokerWithPerson(makeContext(), DIRECT_BROKER, JANE);

  assert.ok(
    recorded.successKeys.length > 0,
    'recordSuccess must have been called'
  );
  assert.equal(
    recorded.successKeys[0],
    'BrokerName|Jane Doe',
    'personCount:2 must use composite key "BrokerName|Jane Doe"'
  );
});

// ── Test 6: shouldSkip is called with the composite key ───────────────────────

test('broker-runner personCount:2 - shouldSkip called with composite key', async () => {
  clearRecorded();
  configure({ dryRun: false, person: JANE, capsolver: null, personCount: 2 });

  await processBrokerWithPerson(makeContext(), DIRECT_BROKER, JANE);

  assert.ok(
    recorded.skipCheckedKeys.some(k => k === 'BrokerName|Jane Doe'),
    `shouldSkip must be called with composite key; got: ${JSON.stringify(recorded.skipCheckedKeys)}`
  );
});

// ── Test 7: saveCheckpoint uses composite key in multi-person mode ────────────

test('broker-runner personCount:2 - saveCheckpoint called with composite key', async () => {
  clearRecorded();
  configure({ dryRun: false, person: JANE, capsolver: null, personCount: 2 });

  await processBrokerWithPerson(makeContext(), DIRECT_BROKER, JANE);

  assert.ok(
    recorded.checkpointKeys.some(k => k === 'BrokerName|Jane Doe'),
    `saveCheckpoint must be called with composite key; got: ${JSON.stringify(recorded.checkpointKeys)}`
  );
});

// ── stateLabel: same-name household members must not collide ─────────────────
//
// config.json can carry two profiles with the same legal name (e.g. a personal
// and a work identity for one person). stateLabel is what keeps their state
// keys distinct; without it both collapse onto "Broker|First Last" and one
// profile's recorded opt-out suppresses the other's submission.

const { stateKey: stateKeyFn, personLabel } = require('../lib/config');

// Mirrors the three profiles in config.json: Martin personal, Martin work, Anna.
const MARTIN_PERSONAL = { firstName: 'Martin', lastName: 'Kessler', stateLabel: 'Martin Kessler (personal)' };
const MARTIN_WORK     = { firstName: 'Martin', lastName: 'Kessler', stateLabel: 'Martin Kessler (work)' };
const ANNA            = { firstName: 'Anna',   lastName: 'Kessler', stateLabel: 'Anna Kessler' };

test('stateKey: person.stateLabel is used as the composite label when set', () => {
  assert.equal(stateKeyFn('X', MARTIN_PERSONAL, 3), 'X|Martin Kessler (personal)');
});

test('stateKey: same-name persons with distinct stateLabels produce distinct keys', () => {
  const k1 = stateKeyFn('Spokeo', MARTIN_PERSONAL, 3);
  const k2 = stateKeyFn('Spokeo', MARTIN_WORK, 3);
  assert.notEqual(k1, k2, 'two same-name profiles must not share a state key');
  assert.equal(k1, 'Spokeo|Martin Kessler (personal)');
  assert.equal(k2, 'Spokeo|Martin Kessler (work)');
});

test('stateKey: third household member gets their own key', () => {
  assert.equal(stateKeyFn('Spokeo', ANNA, 3), 'Spokeo|Anna Kessler');
});

test('stateKey: without stateLabel, falls back to "First Last" (unchanged)', () => {
  const p = { firstName: 'Jane', lastName: 'Doe' };
  assert.equal(stateKeyFn('X', p, 3), 'X|Jane Doe');
});

test('stateKey: same-name persons WITHOUT stateLabel still collide (why the label exists)', () => {
  // Documents the failure mode the invariant prevents: two profiles named
  // "Martin Kessler" and no stateLabel map to the same key.
  const a = { firstName: 'Martin', lastName: 'Kessler' };
  const b = { firstName: 'Martin', lastName: 'Kessler' };
  assert.equal(stateKeyFn('X', a, 3), stateKeyFn('X', b, 3));
});

test('stateKey: blank/whitespace stateLabel falls back to "First Last"', () => {
  const p = { firstName: 'Jane', lastName: 'Doe', stateLabel: '   ' };
  assert.equal(stateKeyFn('X', p, 3), 'X|Jane Doe');
});

test('personLabel: prefers stateLabel, falls back to trimmed "First Last"', () => {
  assert.equal(personLabel(MARTIN_WORK), 'Martin Kessler (work)');
  assert.equal(personLabel({ firstName: 'Jane', lastName: 'Doe' }), 'Jane Doe');
  assert.equal(personLabel({ stateLabel: '  Solo  ' }), 'Solo');
  assert.equal(personLabel(null), '');
});

test('findResumeIndex: checkpoint under a stateLabel key resumes the right broker', () => {
  const { findResumeIndex } = require('../lib/config');
  const brokers = [{ name: 'Spokeo' }, { name: 'Pipl' }];
  const idx = findResumeIndex(brokers, 'Pipl|Martin Kessler (work)', MARTIN_WORK, 3);
  assert.equal(idx, 1, 'composite stateLabel checkpoint must match its broker');
});
