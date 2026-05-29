/**
 * test/broker-runner-pending.test.js — WP4 integration
 *
 * Verifies that processBroker:
 *   - logs `pending_confirm` (not `success`) when the result page asks for
 *     email confirmation
 *   - calls `recordPendingConfirmation` instead of `recordSuccess`
 *
 * Uses module mocking so no real Playwright/config/state involvement.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [], pending: [] };
let confirmReturn = { pending: false, snippet: '' };
// Controllable classify outcome - default 'success' to preserve the test's original intent
let classifyReturn = { outcome: 'success', snippet: 'Your request was received.' };

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: (name, detail) => recorded.pending.push({ name, detail }),
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
  if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => confirmReturn };
  if (request === './success') return { classifyPostSubmit: () => classifyReturn };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBroker } = require('../lib/broker-runner');
Module._load = originalLoad;

// Minimal Playwright stub — supports newPage / page.goto / page.locator / page.close / page.evaluate.
function makeContext() {
  return {
    newPage: async () => ({
      goto: async () => ({}),
      evaluate: async () => 'Your request was received.',
      locator: () => ({
        first: () => ({
          fill: async () => {},
          count: async () => 1,
          isVisible: async () => true,
          click: async () => {},
        }),
      }),
      close: async () => {},
    }),
  };
}

const BROKER = {
  name: 'TestPendingBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button',
  formFields: {},
};

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
  recorded.pending.length = 0;
}

test('pending-confirm: logs pending_confirm and records pending, NOT success', async () => {
  clearAll();
  confirmReturn = { pending: true, snippet: 'Please check your email to confirm' };
  configure({ dryRun: false, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const entry = logged.find(l => l.name === BROKER.name);
  assert.ok(entry, 'logResult called');
  assert.equal(entry.status, 'pending_confirm');
  assert.match(entry.detail, /check your email/i);

  assert.equal(recorded.pending.length, 1, 'recordPendingConfirmation called once');
  assert.equal(recorded.pending[0].name, BROKER.name);
  assert.equal(recorded.success.length, 0, 'recordSuccess must NOT be called');
});

test('normal success: logs success and records success when page does not ask to confirm', async () => {
  clearAll();
  confirmReturn = { pending: false, snippet: '' };
  configure({ dryRun: false, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const entry = logged.find(l => l.name === BROKER.name);
  assert.equal(entry.status, 'success');
  assert.equal(recorded.success.length, 1);
  assert.equal(recorded.pending.length, 0);
});

test('dry-run: confirm-detection is skipped (still logged as skipped)', async () => {
  clearAll();
  confirmReturn = { pending: true, snippet: 'check your email' }; // would trigger pending if reached
  configure({ dryRun: true, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const entry = logged.find(l => l.name === BROKER.name);
  assert.equal(entry.status, 'skipped', 'dry-run short-circuits before submit');
  assert.equal(recorded.pending.length, 0);
  assert.equal(recorded.success.length, 0);
});
