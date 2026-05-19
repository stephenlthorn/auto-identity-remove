/**
 * test/capsolver-optional.test.js
 *
 * Verifies that noCapsolver: true routes captchaLikely brokers straight to
 * 'manual' without invoking detectAndSolveCaptcha at all.
 *
 * Strategy: same Module._load interception used by broker-runner-timeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

let captchaCalls = 0;
let loggedResults = [];

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
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return { logResult: (name, status, detail) => { loggedResults.push({ name, status, detail }); } };
  if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => { captchaCalls++; return true; } };
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

function makeContext() {
  return {
    newPage: async () => ({
      goto: async () => {},
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

// ── Tests ──────────────────────────────────────────────────────────────────────

test('noCapsolver: captchaLikely broker is logged as manual, not captcha_failed', async () => {
  captchaCalls = 0;
  loggedResults = [];

  configure({ dryRun: true, noCapsolver: true, person: PERSON, capsolver: null });

  const broker = {
    name: 'CaptchaBroker',
    method: 'direct-form',
    optOutUrl: 'https://captcha.example.com/optout',
    formFields: {},
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  const result = loggedResults.find(r => r.name === 'CaptchaBroker');
  assert.ok(result, 'a result should be logged for CaptchaBroker');
  assert.equal(result.status, 'manual', 'captchaLikely broker with noCapsolver should be logged as manual');
  assert.equal(captchaCalls, 0, 'detectAndSolveCaptcha should not be called when noCapsolver is true');
});

test('noCapsolver: non-captcha broker still runs normally', async () => {
  captchaCalls = 0;
  loggedResults = [];

  configure({ dryRun: true, noCapsolver: true, person: PERSON, capsolver: null });

  const broker = {
    name: 'NormalBroker',
    method: 'direct-form',
    optOutUrl: 'https://normal.example.com/optout',
    formFields: {},
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  const result = loggedResults.find(r => r.name === 'NormalBroker');
  assert.ok(result, 'a result should be logged for NormalBroker');
  assert.equal(result.status, 'skipped', 'non-captcha broker with dryRun should be skipped (not manual)');
  assert.equal(captchaCalls, 0, 'detectAndSolveCaptcha should not be called for non-captcha broker');
});

test('noCapsolver: false still calls captcha path (existing behavior)', async () => {
  captchaCalls = 0;
  loggedResults = [];

  configure({ dryRun: false, noCapsolver: false, person: PERSON, capsolver: null });

  const broker = {
    name: 'CaptchaBroker2',
    method: 'direct-form',
    optOutUrl: 'https://captcha2.example.com/optout',
    formFields: {},
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  assert.equal(captchaCalls, 1, 'detectAndSolveCaptcha should be called when noCapsolver is false');
});
