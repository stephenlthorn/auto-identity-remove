/**
 * test/broker-runner-usonly.test.js
 *
 * Tests the usOnly + non-US skip guard in processBroker().
 *
 * Uses a mock logResult to capture what was logged without touching disk or
 * Playwright. processBroker is exercised only far enough to reach the guard —
 * the RECHECK_DAYS check runs first so we make the broker appear "due" by
 * ensuring lastOptOutDaysAgo returns Infinity for the test broker name.
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── Minimal mock of config (avoid loading real state.json) ───────────────────

// Patch config module before requiring broker-runner
const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,  // always "due" — won't hit recheck skip
  shouldSkip: () => null,             // never skip via state in these tests
  isPendingConfirmation: () => false,
  recordSuccess: () => {},
  recordPendingConfirmation: () => {},
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

// Patch logger before require
const logged = [];
const loggerMock = {
  logResult: (name, status, detail) => logged.push({ name, status, detail }),
};

// We need to override require calls inside broker-runner.js. The cleanest
// approach without a mock framework: temporarily replace the modules in the
// cache, require broker-runner, then restore.

const Module = require('module');
const originalLoad = Module._load.bind(Module);

function patchedLoad(request, parent, isMain) {
  if (request === './config' && parent?.filename?.includes('broker-runner')) {
    return configMock;
  }
  if (request === './logger' && parent?.filename?.includes('broker-runner')) {
    return loggerMock;
  }
  // forms and captcha are required but never called in the usOnly path
  if (request === './forms' && parent?.filename?.includes('broker-runner')) {
    return { fillForm: async () => {}, findListingUrl: async () => null };
  }
  if (request === './captcha' && parent?.filename?.includes('broker-runner')) {
    return { detectAndSolveCaptcha: async () => true };
  }
  if (request === './confirm' && parent?.filename?.includes('broker-runner')) {
    return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  }
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;

// Clear any cached broker-runner before requiring so our mock is picked up
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBroker } = require('../lib/broker-runner');

// Restore
Module._load = originalLoad;

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearLog() { logged.length = 0; }

const US_ONLY_BROKER = {
  name: 'TestUSOnlyBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  formFields: {},
  usOnly: true,
  priority: 1,
};

const GLOBAL_BROKER = {
  name: 'TestGlobalBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  formFields: {},
  // no usOnly flag
  priority: 1,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test('usOnly broker is skipped for a Canadian user', async () => {
  clearLog();
  configure({ dryRun: false, person: { country: 'CA' }, capsolver: null });
  // processBroker needs a context object; it won't reach newPage() because
  // the guard fires before any page is created.
  await processBroker(null, US_ONLY_BROKER);

  const entry = logged.find(l => l.name === 'TestUSOnlyBroker');
  assert.ok(entry, 'logResult should have been called for the US-only broker');
  assert.equal(entry.status, 'skipped', 'status should be "skipped"');
  assert.ok(entry.detail?.toLowerCase().includes('us-only'),
    `detail should mention "US-only", got "${entry.detail}"`);
});

test('usOnly broker is skipped for a GB user', async () => {
  clearLog();
  configure({ dryRun: false, person: { country: 'GB' }, capsolver: null });
  await processBroker(null, US_ONLY_BROKER);

  const entry = logged.find(l => l.name === 'TestUSOnlyBroker');
  assert.ok(entry, 'logResult should have been called');
  assert.equal(entry.status, 'skipped');
});

test('usOnly broker is NOT skipped for a US user (falls through to normal flow)', async () => {
  clearLog();
  configure({ dryRun: false, person: { country: 'US' }, capsolver: null });
  // For a US user the guard does NOT fire.  processBroker will try to open a
  // page and fail (context is null) — that's expected, we just verify the guard
  // did not produce a skip log entry.
  try {
    await processBroker(null, US_ONLY_BROKER);
  } catch (_) { /* expected — null context */ }

  const skipEntry = logged.find(
    l => l.name === 'TestUSOnlyBroker' && l.status === 'skipped' && l.detail?.includes('US-only'),
  );
  assert.equal(skipEntry, undefined, 'US user must NOT be skipped by the usOnly guard');
});

test('usOnly broker is NOT skipped when person.country is absent (defaults to US)', async () => {
  clearLog();
  configure({ dryRun: false, person: { /* no country */ state: 'TX' }, capsolver: null });
  try {
    await processBroker(null, US_ONLY_BROKER);
  } catch (_) {}

  const skipEntry = logged.find(
    l => l.name === 'TestUSOnlyBroker' && l.status === 'skipped' && l.detail?.includes('US-only'),
  );
  assert.equal(skipEntry, undefined, 'missing country should default to US (no usOnly skip)');
});

test('broker without usOnly flag is NOT skipped for a non-US user', async () => {
  clearLog();
  configure({ dryRun: false, person: { country: 'CA' }, capsolver: null });
  try {
    await processBroker(null, GLOBAL_BROKER);
  } catch (_) {}

  const skipEntry = logged.find(
    l => l.name === 'TestGlobalBroker' && l.status === 'skipped' && l.detail?.includes('US-only'),
  );
  assert.equal(skipEntry, undefined, 'global broker must not be skipped by the usOnly guard');
});
