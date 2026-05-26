/**
 * test/broker-runner-submit-scope.test.js
 *
 * Verifies submit-button scoping behaviour (Bug HIGH-11).
 *
 * When a page has multiple `button[type="submit"]` elements, the broker runner
 * should prefer the one inside a `<form>` element (via `form <selector>`) over
 * any button that sits outside a form (e.g., a newsletter sign-up widget).
 *
 * Two scenarios:
 *   1. Form-scoped button exists: `form button[type="submit"]` matches (count > 0)
 *      -> that button is clicked, NOT the page-level first match.
 *   2. No form-scoped button: fallback to page-level `button[type="submit"]`.
 *
 * Uses Module._load interception, same pattern as the other broker-runner tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [] };

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
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'ok' }) };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
}

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

const BROKER = {
  name: 'SubmitScopeBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

// ── Scenario 1: form-scoped button is preferred ───────────────────────────────

test('form-scoped submit is clicked when form button exists', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });

  const clickedSelectors = [];

  // Simulate: `form button[type="submit"]` returns count=1 (form button exists)
  // The page-level `button[type="submit"]` also returns count=1 but should NOT be clicked.
  function makeFormScopedContext() {
    return {
      newPage: async () => ({
        goto: async () => {},
        locator: (sel) => {
          const isFormScoped = sel.startsWith('form ');
          return {
            first: () => ({
              fill: async () => {},
              count: async () => (isFormScoped ? 1 : 1), // both have count=1
              isVisible: async () => true,
              click: async () => {
                clickedSelectors.push(sel);
              },
            }),
          };
        },
        evaluate: async () => 'ok',
        close: async () => {},
      }),
    };
  }

  await processBrokerWithPerson(makeFormScopedContext(), BROKER, PERSON);

  assert.ok(
    clickedSelectors.some(s => s.startsWith('form ')),
    `expected a form-scoped selector to be clicked, got: [${clickedSelectors.join(', ')}]`
  );
});

// ── Scenario 2: fallback to page-level when no form-scoped button ─────────────

test('page-level submit is used as fallback when no form button exists', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });

  const clickedSelectors = [];

  function makeNoFormContext() {
    return {
      newPage: async () => ({
        goto: async () => {},
        locator: (sel) => {
          const isFormScoped = sel.startsWith('form ');
          return {
            first: () => ({
              fill: async () => {},
              // form-scoped returns count=0 (no button inside a form)
              // page-level returns count=1
              count: async () => (isFormScoped ? 0 : 1),
              isVisible: async () => true,
              click: async () => {
                clickedSelectors.push(sel);
              },
            }),
          };
        },
        evaluate: async () => 'ok',
        close: async () => {},
      }),
    };
  }

  await processBrokerWithPerson(makeNoFormContext(), BROKER, PERSON);

  assert.ok(
    clickedSelectors.length > 0,
    'a submit button should still be clicked via page-level fallback'
  );
  // The clicked selector should be the raw (non-form-scoped) one
  assert.ok(
    clickedSelectors.some(s => !s.startsWith('form ')),
    `expected a non-form-scoped selector to be clicked, got: [${clickedSelectors.join(', ')}]`
  );
});

// ── Scenario 3: form-scoped NOT clicked when form-scoped count is 0 ───────────

test('form-scoped button is NOT clicked when it has count=0', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });

  const clickedSelectors = [];

  function makeNoFormContext() {
    return {
      newPage: async () => ({
        goto: async () => {},
        locator: (sel) => {
          const isFormScoped = sel.startsWith('form ');
          return {
            first: () => ({
              fill: async () => {},
              count: async () => (isFormScoped ? 0 : 1),
              isVisible: async () => true,
              click: async () => {
                clickedSelectors.push(sel);
              },
            }),
          };
        },
        evaluate: async () => 'ok',
        close: async () => {},
      }),
    };
  }

  await processBrokerWithPerson(makeNoFormContext(), BROKER, PERSON);

  const formScopedClicks = clickedSelectors.filter(s => s.startsWith('form '));
  assert.equal(
    formScopedClicks.length,
    0,
    `form-scoped button must NOT be clicked when count=0, got: [${formScopedClicks.join(', ')}]`
  );
});
