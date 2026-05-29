/**
 * test/broker-runner-preview.test.js — WP4 --preview flag
 *
 * Verifies that processBroker, when configured with preview: true:
 *   - calls page.evaluate to extract field values
 *   - calls logResult with status 'preview' and detail containing field/value pairs
 *   - does NOT submit the form (preview implies dry-run)
 *   - does NOT call logResult with 'skipped' (preview log replaces it)
 *
 * Uses Module._load interception pattern from broker-runner-pending.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [], pending: [] };

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
    STATUS_BUCKET: { preview: 'skipped' }, // exposed for runner to check
  };
  if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBroker } = require('../lib/broker-runner');
Module._load = originalLoad;

const FIXTURE_FIELDS = [
  { name: 'first', value: 'Jane', type: 'text' },
  { name: 'email', value: 'jane@example.com', type: 'email' },
  { name: 'last', value: 'Doe', type: 'text' },
];

// Playwright stub with evaluate support
function makeContext({ evaluateResult = FIXTURE_FIELDS } = {}) {
  return {
    newPage: async () => ({
      goto: async () => ({}),
      evaluate: async () => evaluateResult,
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
  name: 'TestPreviewBroker',
  method: 'direct-form',
  optOutUrl: 'https://radaris.com/optout',
  submitSelector: 'button',
  formFields: { first: 'Jane', email: 'jane@example.com' },
};

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
  recorded.pending.length = 0;
}

test('preview: logResult called with status "preview" containing field values', async () => {
  clearAll();
  configure({ dryRun: true, preview: true, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const entry = logged.find(l => l.name === BROKER.name && l.status === 'preview');
  assert.ok(entry, 'logResult must be called with status "preview"');
  assert.match(entry.detail, /Jane/, 'detail should include field value "Jane"');
  assert.match(entry.detail, /jane@example\.com/, 'detail should include email value');
});

test('preview: detail includes target URL', async () => {
  clearAll();
  configure({ dryRun: true, preview: true, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const entry = logged.find(l => l.name === BROKER.name && l.status === 'preview');
  assert.ok(entry, 'logResult must be called with status "preview"');
  assert.match(entry.detail, /radaris\.com\/optout/, 'detail should include target URL');
});

test('preview: form is NOT submitted (no success or pending_confirm logged)', async () => {
  clearAll();
  configure({ dryRun: true, preview: true, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const successEntry = logged.find(l => l.name === BROKER.name && l.status === 'success');
  const pendingEntry = logged.find(l => l.name === BROKER.name && l.status === 'pending_confirm');
  assert.equal(successEntry, undefined, 'must NOT log success in preview mode');
  assert.equal(pendingEntry, undefined, 'must NOT log pending_confirm in preview mode');
  assert.equal(recorded.success.length, 0, 'recordSuccess must NOT be called');
});

test('preview: page.evaluate is called to extract field values', async () => {
  clearAll();
  let evaluateCalled = false;
  const ctx = {
    newPage: async () => ({
      goto: async () => ({}),
      evaluate: async () => {
        evaluateCalled = true;
        return FIXTURE_FIELDS;
      },
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

  configure({ dryRun: true, preview: true, person: { country: 'US' }, capsolver: null });
  await processBroker(ctx, BROKER);

  assert.ok(evaluateCalled, 'page.evaluate must be called in preview mode');
});

test('preview with empty fields: still logs preview status with URL', async () => {
  clearAll();
  configure({ dryRun: true, preview: true, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext({ evaluateResult: [] }), BROKER);

  const entry = logged.find(l => l.name === BROKER.name && l.status === 'preview');
  assert.ok(entry, 'logResult must be called with status "preview" even with no fields');
  assert.match(entry.detail, /radaris\.com\/optout/, 'detail should still include URL');
});

test('non-preview dry-run: still logs "skipped" (not "preview")', async () => {
  clearAll();
  configure({ dryRun: true, preview: false, person: { country: 'US' }, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const skippedEntry = logged.find(l => l.name === BROKER.name && l.status === 'skipped');
  const previewEntry = logged.find(l => l.name === BROKER.name && l.status === 'preview');
  assert.ok(skippedEntry, 'dry-run without preview should still log "skipped"');
  assert.equal(previewEntry, undefined, 'must NOT log "preview" when preview is false');
});
