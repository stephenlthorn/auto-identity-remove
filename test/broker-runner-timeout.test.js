/**
 * test/broker-runner-timeout.test.js
 *
 * Verifies per-broker timeoutMs override in processBrokerWithPerson.
 *
 * Strategy:
 *   - Intercept require() via Module._load so all deps use stubs
 *   - Provide a minimal page stub with capturable goto()
 *   - Inspect timeout option passed to page.goto()
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

// Capture goto calls across tests
let gotoCalls = [];

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: () => {},
  recordPendingConfirmation: () => {},
  recordFailure: () => {},
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return { logResult: () => {} };
  if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false }) };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

configure({ dryRun: false, person: PERSON, capsolver: null });

function makeContext() {
  return {
    newPage: async () => ({
      goto: async (url, opts) => { gotoCalls.push({ url, opts }); },
      locator: () => ({
        first: () => ({
          fill: async () => {},
          count: async () => 0,
          isVisible: async () => false,
          click: async () => {},
        }),
      }),
      evaluate: async () => [],
      close: async () => {},
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('broker with timeoutMs: 30000 → page.goto called with timeout 30000', async () => {
  gotoCalls = [];
  const broker = {
    name: 'SlowBroker',
    method: 'direct-form',
    optOutUrl: 'https://slow.example.com/optout',
    formFields: {},
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    timeoutMs: 30000,
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  assert.equal(gotoCalls.length, 1, 'goto should be called once');
  assert.equal(gotoCalls[0].opts.timeout, 30000, 'timeout should be broker.timeoutMs (30000)');
});

test('broker without timeoutMs → page.goto called with default timeout 15000', async () => {
  gotoCalls = [];
  const broker = {
    name: 'DefaultBroker',
    method: 'direct-form',
    optOutUrl: 'https://fast.example.com/optout',
    formFields: {},
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    // no timeoutMs
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  assert.equal(gotoCalls.length, 1, 'goto should be called once');
  assert.equal(gotoCalls[0].opts.timeout, 15000, 'timeout should be default 15000');
});

test('broker with timeoutMs: 0 (falsy) → page.goto called with default timeout 15000', async () => {
  gotoCalls = [];
  const broker = {
    name: 'ZeroBroker',
    method: 'direct-form',
    optOutUrl: 'https://zero.example.com/optout',
    formFields: {},
    captchaLikely: false,
    timeoutMs: 0, // falsy — should fall back to default
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  assert.equal(gotoCalls.length, 1, 'goto should be called once');
  assert.equal(gotoCalls[0].opts.timeout, 15000, 'falsy timeoutMs should fall back to 15000');
});
