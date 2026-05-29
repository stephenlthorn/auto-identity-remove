/**
 * test/snapshot.test.js
 *
 * Covers lib/snapshot.js (snapshotPath, captureSubmitSnapshot) and the
 * broker-runner hook that calls captureSubmitSnapshot between fill and submit.
 *
 * Uses the Module._load interception pattern from the other broker-runner tests
 * so we can spy on page.screenshot without touching the real filesystem or
 * requiring an actual Playwright browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Unit tests for lib/snapshot.js ──────────────────────────────────────────

const { snapshotPath, captureSubmitSnapshot, SNAPSHOT_DIR } = require('../lib/snapshot');

test('snapshotPath: returns expected path for simple broker name', () => {
  const ts = new Date('2026-05-26T10:00:00.000Z');
  const result = snapshotPath('Spokeo.com', ts);
  const expected = path.join(SNAPSHOT_DIR, 'Spokeo_com-2026-05-26T10-00-00-000Z.png');
  assert.equal(result, expected);
});

test('snapshotPath: sanitizes broker name containing spaces and slashes', () => {
  const ts = new Date('2026-05-26T10:00:00.000Z');
  const result = snapshotPath('Has Spaces/Slashes', ts);
  // spaces and slashes must be replaced with underscores
  assert.match(path.basename(result), /^Has_Spaces_Slashes-/);
});

test('snapshotPath: returns .png extension', () => {
  const result = snapshotPath('TestBroker', new Date());
  assert.ok(result.endsWith('.png'), 'must end with .png');
});

test('captureSubmitSnapshot: calls page.screenshot with correct path and returns it', async () => {
  const screenshotPaths = [];
  const fakePage = {
    screenshot: async ({ path: p }) => { screenshotPaths.push(p); },
  };
  const fakeFs = {
    mkdirSync: () => {},
  };
  const ts = new Date('2026-05-26T12:00:00.000Z');
  const dir = '/tmp/test-snapshots';

  const result = await captureSubmitSnapshot(fakePage, 'TestBroker', { dir, timestamp: ts, _fs: fakeFs });

  assert.equal(screenshotPaths.length, 1, 'screenshot must be called exactly once');
  assert.ok(screenshotPaths[0].includes('TestBroker'), 'path must include broker name');
  assert.ok(screenshotPaths[0].endsWith('.png'), 'path must end with .png');
  assert.equal(result, screenshotPaths[0], 'must return the screenshot file path');
});

test('captureSubmitSnapshot: returns null when screenshot throws (no rethrow)', async () => {
  const fakePage = {
    screenshot: async () => { throw new Error('Screenshot failed'); },
  };
  const fakeFs = {
    mkdirSync: () => {},
  };

  const result = await captureSubmitSnapshot(fakePage, 'BrokenBroker', {
    dir: '/tmp/test',
    timestamp: new Date(),
    _fs: fakeFs,
  });

  assert.equal(result, null, 'must return null on screenshot failure, not throw');
});

test('captureSubmitSnapshot: calls mkdirSync with recursive: true', async () => {
  let mkdirCalled = false;
  let mkdirOpts = null;
  const fakePage = {
    screenshot: async () => {},
  };
  const fakeFs = {
    mkdirSync: (dir, opts) => { mkdirCalled = true; mkdirOpts = opts; },
  };

  await captureSubmitSnapshot(fakePage, 'BrokerDir', {
    dir: '/tmp/testdir',
    timestamp: new Date(),
    _fs: fakeFs,
  });

  assert.ok(mkdirCalled, 'mkdirSync must be called');
  assert.deepEqual(mkdirOpts, { recursive: true });
});

// ── broker-runner integration tests ──────────────────────────────────────────
// Use Module._load interception so we can spy on captureSubmitSnapshot without
// touching the real filesystem.

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
  stateKey: (brokerName) => brokerName,
};

// Track calls to captureSubmitSnapshot via a spy
let snapshotCalls = [];
const snapshotMock = {
  captureSubmitSnapshot: async (page, brokerName, opts) => {
    snapshotCalls.push({ brokerName, opts });
    return `/fake/snapshots/${brokerName}-snapshot.png`;
  },
  snapshotPath: snapshotPath,
  SNAPSHOT_DIR,
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
  if (request === './snapshot') return snapshotMock;
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBroker } = require('../lib/broker-runner');
Module._load = originalLoad;

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
  snapshotCalls.length = 0;
}

const PERSON = { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', country: 'US' };

const BROKER = {
  name: 'SnapshotTestBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: { first: 'Jane', email: 'jane@test.com' },
};

function makeContext({ screenshotSpy } = {}) {
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
      screenshot: screenshotSpy || (async () => {}),
      evaluate: async () => '',
      close: async () => {},
    }),
  };
}

test('broker-runner: captureSubmitSnapshot is called when snapshot: true', async () => {
  clearAll();
  configure({ dryRun: false, snapshot: true, person: PERSON, capsolver: null });

  await processBroker(makeContext(), BROKER);

  assert.equal(snapshotCalls.length, 1, 'captureSubmitSnapshot must be called once');
  assert.equal(snapshotCalls[0].brokerName, BROKER.name);
});

test('broker-runner: captureSubmitSnapshot is NOT called when snapshot is false (default)', async () => {
  clearAll();
  configure({ dryRun: false, snapshot: false, person: PERSON, capsolver: null });

  await processBroker(makeContext(), BROKER);

  assert.equal(snapshotCalls.length, 0, 'captureSubmitSnapshot must NOT be called when snapshot is false');
});

test('broker-runner: captureSubmitSnapshot is NOT called when snapshot option is not set', async () => {
  clearAll();
  // configure without snapshot key at all
  configure({ dryRun: false, person: PERSON, capsolver: null });

  await processBroker(makeContext(), BROKER);

  assert.equal(snapshotCalls.length, 0, 'captureSubmitSnapshot must NOT be called by default');
});

test('broker-runner: captureSubmitSnapshot is NOT called in dryRun mode', async () => {
  clearAll();
  configure({ dryRun: true, snapshot: true, person: PERSON, capsolver: null });

  await processBroker(makeContext(), BROKER);

  assert.equal(snapshotCalls.length, 0, 'captureSubmitSnapshot must NOT be called in dry-run (no submit)');
});

test('broker-runner: snapshot path is included in audit detail on success', async () => {
  clearAll();
  configure({ dryRun: false, snapshot: true, person: PERSON, capsolver: null });

  await processBroker(makeContext(), BROKER);

  const successEntry = logged.find(l => l.name === BROKER.name && l.status === 'success');
  assert.ok(successEntry, 'broker must log success');
  assert.ok(
    successEntry.detail && successEntry.detail.includes('snapshot.png'),
    `success detail should mention the snapshot path, got: "${successEntry.detail}"`
  );
});
