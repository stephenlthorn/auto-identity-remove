/**
 * test/broker-runner-nav-failure.test.js
 *
 * Locks in: a navigation failure while searching for a listing is reported as
 * an error/unknown state, never as a "not listed" verdict.
 *
 * Previously `findListingUrl(page, broker).catch(() => null)` collapsed every
 * failure of the search-page navigation (DNS, timeout, bot-block, renderer
 * crash) into `listingUrl === null`, which then logged 'notFound' - telling
 * the user "you are not on this site" for a listing that was never searched.
 *
 * These tests stub findListingUrl to throw and assert the broker lands in the
 * error bucket with a recorded failure, while a *completed* search that
 * returns null still reports notFound.
 *
 * Uses the Module._load interception pattern from the other broker-runner tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [], failure: [] };

// Controllable findListingUrl behaviour per test.
//   'null'   -> completed search, no listing found (legitimate notFound)
//   'found'  -> returns a listing URL
//   <Error>  -> throws that error (simulated navigation failure)
let findListingBehavior = 'null';

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: () => {},
  recordFailure: (name, kind) => recorded.failure.push({ name, kind }),
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => {},
    findListingUrl: async () => {
      if (findListingBehavior instanceof Error) throw findListingBehavior;
      if (findListingBehavior === 'found') return 'https://example.com/listing/123';
      return null;
    },
  };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'Removed.' }) };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
  recorded.failure.length = 0;
  findListingBehavior = 'null';
}

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

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
      evaluate: async () => '',
      close: async () => {},
    }),
  };
}

const SEARCH_BROKER = {
  name: 'NavFailBroker',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/optout',
  listingPattern: /listing/,
  formFields: {},
};

// ── tests ─────────────────────────────────────────────────────────────────────

test('navigation failure during listing search -> error, never notFound', async () => {
  clearAll();
  findListingBehavior = new Error('net::ERR_CONNECTION_REFUSED at https://example.com/search');

  configure({ person: PERSON, personCount: 1, dryRun: false });
  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  const notFound = logged.find(l => l.status === 'notFound');
  assert.equal(notFound, undefined, 'a failed search must never report notFound');

  const err = logged.find(l => l.status === 'error');
  assert.ok(err, 'expected an error log for the failed navigation');
  assert.match(err.detail, /ERR_CONNECTION_REFUSED/);
});

test('navigation failure records a failure in state (does not hide the outcome)', async () => {
  clearAll();
  findListingBehavior = new Error('net::ERR_NAME_NOT_RESOLVED');

  configure({ person: PERSON, personCount: 1, dryRun: false });
  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(recorded.success.length, 0, 'no success may be recorded for a failed search');
  assert.equal(recorded.failure.length, 1, 'expected recordFailure for the failed search');
  assert.equal(recorded.failure[0].name, 'NavFailBroker');
  assert.equal(recorded.failure[0].kind, 'error');
});

test('timeout during listing search -> error with Timeout detail, not notFound', async () => {
  clearAll();
  findListingBehavior = new Error('page.goto: Timeout 20000ms exceeded');

  configure({ person: PERSON, personCount: 1, dryRun: false });
  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(logged.find(l => l.status === 'notFound'), undefined);
  const err = logged.find(l => l.status === 'error');
  assert.ok(err);
  assert.match(err.detail, /Timeout/);
});

test('completed search returning null -> notFound (legitimate not-listed preserved)', async () => {
  clearAll();
  findListingBehavior = 'null';

  configure({ person: PERSON, personCount: 1, dryRun: false });
  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  const nf = logged.find(l => l.status === 'notFound');
  assert.ok(nf, 'a completed search with no match should still report notFound');
  assert.equal(recorded.failure.length, 0, 'a genuine notFound is not a failure');
});

test('found listing proceeds to opt-out (search success unaffected)', async () => {
  clearAll();
  findListingBehavior = 'found';

  configure({ person: PERSON, personCount: 1, dryRun: false });
  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(logged.find(l => l.status === 'notFound'), undefined);
  assert.equal(logged.find(l => l.status === 'error'), undefined);
  assert.equal(recorded.success.length, 1, 'successful flow should record success');
});
