/**
 * test/allowlist-broker-runner.test.js
 *
 * Verifies processBrokerWithPerson short-circuits an allowlisted broker:
 *   - logResult is called with status 'allowlisted'
 *   - fillForm is NEVER called (no form interaction)
 *   - recordSuccess is NEVER called (no 90-day cooldown started)
 *
 * A non-allowlisted broker must still proceed to fillForm + recordSuccess,
 * proving the guard is scoped to the allowlist and not a blanket skip.
 *
 * Uses the Module._load interception pattern from the other broker-runner tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [] };
const calls = { fillForm: 0 };

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: () => {},
  recordFailure: () => {},
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

const filterMock = {
  isAllowlisted: (name, config) =>
    !!(config && Array.isArray(config.allowlist) &&
       config.allowlist.some(e => String(e).trim().toLowerCase() === String(name).trim().toLowerCase())),
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './filter') return filterMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => { calls.fillForm++; },
    findListingUrl: async () => 'https://example.com/listing/123',
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
  calls.fillForm = 0;
}

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

function makeContext() {
  // Result text appears only after the submit click: the runner classifies text
  // that is new since the click (BRK-4).
  let clicked = false;
  return {
    newPage: async () => ({
      goto: async () => {},
      locator: () => ({ first: () => ({ fill: async () => {}, count: async () => 1, isVisible: async () => true, click: async () => { clicked = true; } }) }),
      evaluate: async () => (clicked ? 'page body text' : 'page before submit'),
      close: async () => {},
    }),
  };
}

const SEARCH_BROKER = {
  name: 'AllowedBroker',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: { 'input[name="x"]': 'y' },
};

test('allowlisted broker: logResult called with status allowlisted', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  const entry = logged.find(l => l.name === SEARCH_BROKER.name);
  assert.ok(entry, 'logResult should have been called');
  assert.equal(entry.status, 'allowlisted', `expected "allowlisted" but got "${entry.status}"`);
});

test('allowlisted broker: fillForm is NEVER called', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(calls.fillForm, 0, 'fillForm must NOT be called for an allowlisted broker');
});

test('allowlisted broker: recordSuccess is NEVER called', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(recorded.success.length, 0, 'recordSuccess must NOT be called for an allowlisted broker');
});

test('non-allowlisted broker still proceeds to fillForm + recordSuccess', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['SomeOtherBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(calls.fillForm, 1, 'fillForm should run for a non-allowlisted broker');
  assert.equal(recorded.success.length, 1, 'recordSuccess should run for a non-allowlisted broker');
  const entry = logged.find(l => l.name === SEARCH_BROKER.name);
  assert.equal(entry.status, 'success');
});
