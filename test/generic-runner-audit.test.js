/**
 * test/generic-runner-audit.test.js
 *
 * WP5: per-site outcome tracking in runGenericBrokers.
 *
 * Stubs processGenericUrl via broker name convention, mocks context/logResult,
 * and asserts the returned genericStats object reflects the correct counts.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// We need to mock fs reads and the browser context so no real I/O happens.
// Strategy: require the module with carefully-crafted stubs injected by
// monkey-patching fs before the module loads fresh each time.

// Re-require helper that busts the module cache.
function freshRequire(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

// ─── Helper to build a fake Playwright-like context ──────────────────────────

function makeFakePage(outcomesByName) {
  // Returns a fake page whose goto() result depends on the broker URL keyword
  // embedded in the URL.  We do this by overriding processGenericUrl via the
  // opts.injectedProcessFn hook we will add in WP5.
  return {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    locator: () => ({
      first: () => ({
        count: async () => 0,
        isVisible: async () => false,
        click: async () => {},
        getAttribute: async () => null,
        evaluate: async () => 'button',
      }),
      all: async () => [],
    }),
    evaluate: async () => [],
    close: async () => {},
  };
}

function makeFakeContext(page) {
  return {
    newPage: async () => page,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('runGenericBrokers returns genericStats with zero counts when no brokers', async () => {
  const { runGenericBrokers } = freshRequire('../generic-runner');

  const context = makeFakeContext(makeFakePage({}));
  const state = { optOuts: {} };
  const logged = [];
  const logResult = (name, status, detail) => logged.push({ name, status, detail });
  const recordSuccess = () => {};

  // Pass empty broker lists by monkey-patching data files to not exist.
  // Use the injected brokers option (new opt in WP5).
  const result = await runGenericBrokers(context, [], state, logResult, recordSuccess, {
    dryRun: false,
    injectedBrokers: [],
  });

  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(typeof result.genericStats, 'object', 'has genericStats');
  assert.equal(result.genericStats.attempted, 0);
  assert.equal(result.genericStats.submitted, 0);
  assert.equal(result.genericStats.no_form_found, 0);
  assert.equal(result.genericStats.error, 0);
});

test('runGenericBrokers aggregates outcomes from injected process function', async () => {
  const { runGenericBrokers } = freshRequire('../generic-runner');

  // 4 brokers with distinct outcomes we'll control via injectedProcessFn
  const brokers = [
    { name: 'alpha', url: 'https://alpha.example', source: 'test' },
    { name: 'beta',  url: 'https://beta.example',  source: 'test' },
    { name: 'gamma', url: 'https://gamma.example', source: 'test' },
    { name: 'delta', url: 'https://delta.example', source: 'test' },
  ];

  const outcomes = {
    alpha: { status: 'success',  detail: 'Form submitted' },
    beta:  { status: 'success',  detail: 'Do Not Sell clicked' },
    gamma: { status: 'manual',   detail: 'https://gamma.example' },
    delta: { status: 'error',    detail: 'Timeout' },
  };

  const injectedProcessFn = async (_page, broker, _state, _dryRun) => outcomes[broker.name];

  const context = makeFakeContext(makeFakePage({}));
  const state = { optOuts: {} };
  const logged = [];
  const logResult = (name, status, detail) => logged.push({ name, status, detail });
  const recordSuccess = () => {};

  const result = await runGenericBrokers(context, [], state, logResult, recordSuccess, {
    dryRun: false,
    injectedBrokers: brokers,
    injectedProcessFn,
  });

  const stats = result.genericStats;
  assert.equal(stats.attempted, 4, 'attempted = total brokers');
  assert.equal(stats.submitted, 2, 'submitted = success count');
  // manual falls into no_form_found bucket (no form automated)
  assert.equal(stats.no_form_found, 1, 'no_form_found = manual count');
  assert.equal(stats.error, 1, 'error = error count');
});

test('runGenericBrokers counts dry-run-skipped outcome separately', async () => {
  const { runGenericBrokers } = freshRequire('../generic-runner');

  const brokers = [
    { name: 'site1', url: 'https://site1.example', source: 'test' },
    { name: 'site2', url: 'https://site2.example', source: 'test' },
    { name: 'site3', url: 'https://site3.example', source: 'test' },
  ];

  const injectedProcessFn = async (_page, broker, _state, dryRun) => {
    if (dryRun) return { status: 'skipped', detail: 'dry-run — generic opt-out not submitted' };
    return { status: 'success', detail: 'Form submitted' };
  };

  const context = makeFakeContext(makeFakePage({}));
  const state = { optOuts: {} };
  const logResult = () => {};
  const recordSuccess = () => {};

  const result = await runGenericBrokers(context, [], state, logResult, recordSuccess, {
    dryRun: true,
    injectedBrokers: brokers,
    injectedProcessFn,
  });

  const stats = result.genericStats;
  assert.equal(stats.attempted, 3);
  assert.equal(stats['dry-run-skipped'], 3, 'all 3 are dry-run-skipped');
  assert.equal(stats.submitted, 0);
});

test('runGenericBrokers counts skipped-recent outcome', async () => {
  const { runGenericBrokers } = freshRequire('../generic-runner');

  const brokers = [
    { name: 'fresh1', url: 'https://fresh1.example', source: 'test' },
    { name: 'fresh2', url: 'https://fresh2.example', source: 'test' },
  ];

  // Both are recently-visited so they come back as skipped (not dry-run)
  const injectedProcessFn = async () => ({ status: 'skipped', detail: '5d ago' });

  const context = makeFakeContext(makeFakePage({}));
  const state = { optOuts: {} };
  const logResult = () => {};
  const recordSuccess = () => {};

  const result = await runGenericBrokers(context, [], state, logResult, recordSuccess, {
    dryRun: false,
    injectedBrokers: brokers,
    injectedProcessFn,
  });

  const stats = result.genericStats;
  assert.equal(stats.attempted, 2);
  assert.equal(stats['skipped-recent'], 2, 'recently-visited sites counted as skipped-recent');
  assert.equal(stats.submitted, 0);
});

test('runGenericBrokers count: total = submitted + no_form_found + error + dry-run-skipped + skipped-recent + dead', async () => {
  const { runGenericBrokers } = freshRequire('../generic-runner');

  const outcomes = [
    { status: 'success', detail: 'ok' },
    { status: 'success', detail: 'ok' },
    { status: 'manual', detail: 'link' },
    { status: 'error', detail: 'Timeout' },
    { status: 'skipped', detail: 'dry-run — generic opt-out not submitted' },
    { status: 'skipped', detail: '12d ago' },
    { status: 'dead', detail: 'HTTP 404' },
  ];

  const brokers = outcomes.map((o, i) => ({ name: `site${i}`, url: `https://site${i}.example`, source: 'test' }));

  let i = 0;
  const injectedProcessFn = async () => outcomes[i++];

  const context = makeFakeContext(makeFakePage({}));
  const state = { optOuts: {} };
  const logResult = () => {};
  const recordSuccess = () => {};

  const result = await runGenericBrokers(context, [], state, logResult, recordSuccess, {
    dryRun: false,
    injectedBrokers: brokers,
    injectedProcessFn,
  });

  const s = result.genericStats;
  assert.equal(s.attempted, 7);
  assert.equal(s.submitted, 2);
  assert.equal(s.no_form_found, 1);
  assert.equal(s.error, 1);
  assert.equal(s['dry-run-skipped'], 1);
  assert.equal(s['skipped-recent'], 1);
  assert.equal(s.dead, 1);
  const sum = s.submitted + s.no_form_found + s.error + s['dry-run-skipped'] + s['skipped-recent'] + s.dead;
  assert.equal(sum, s.attempted, 'sum of outcomes equals attempted');
});
