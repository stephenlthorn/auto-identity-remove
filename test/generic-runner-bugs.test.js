/**
 * test/generic-runner-bugs.test.js
 *
 * Tests for confirmed correctness bugs in generic-runner.js:
 *   H3 - getFieldMap crashes when config uses persons[] array (not person)
 *   M1 - isDeadStatus marks 403/429/401 as permanently dead (should be error)
 *   M2 - pendingConfirmation (old boolean) vs pendingConfirm (new object)
 *   L2 - recordFailure never called for error/dead outcomes
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ─── freshRequire ─────────────────────────────────────────────────────────────

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

// ─── Bug M1: isDeadStatus boundaries ─────────────────────────────────────────

test('isDeadStatus: 200 is NOT dead', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(200), false);
});

test('isDeadStatus: 301 is NOT dead', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(301), false);
});

test('isDeadStatus: 401 is NOT dead (auth challenge, live site)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(401), false);
});

test('isDeadStatus: 403 is NOT dead (bot block, live site)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(403), false);
});

test('isDeadStatus: 429 is NOT dead (rate limit, live site)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(429), false);
});

test('isDeadStatus: 404 IS dead (page gone)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(404), true);
});

test('isDeadStatus: 410 IS dead (gone)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(410), true);
});

test('isDeadStatus: 500 IS dead (server error)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(500), true);
});

test('isDeadStatus: 503 IS dead (service unavailable)', () => {
  const { isDeadStatus } = freshRequire('../generic-runner');
  assert.equal(isDeadStatus(503), true);
});

// ─── Bug H3: activePerson / getFieldMap with persons[] array ─────────────────

test('getFieldMap does not crash when config has persons[] array instead of person', async () => {
  // Multi-person config - no "person" key, only "persons" array
  const cfg = {
    persons: [
      {
        firstName: 'Alice',
        lastName: 'Smith',
        fullName: 'Alice Smith',
        email: 'alice@example.com',
        state: 'CA',
        zip: '90210',
      },
    ],
    email: { address: 'alice@example.com' },
  };

  const CONFIG_REAL_PATH = path.join(__dirname, '..', 'config.json');
  const CONFIG_ENC_PATH  = path.join(__dirname, '..', 'config.json.enc');
  const origReadFileSync = fs.readFileSync;
  const origExistsSync   = fs.existsSync;

  // Reset module cache so _config is null and the patched config is read
  delete require.cache[require.resolve('../generic-runner')];

  // Intercept readFileSync for config.json only
  fs.readFileSync = function(p, enc) {
    if (p === CONFIG_REAL_PATH) return JSON.stringify(cfg);
    return origReadFileSync.call(fs, p, enc);
  };
  // loadConfig() calls existsSync before readFileSync; report config as present
  fs.existsSync = function(p) {
    if (p === CONFIG_ENC_PATH) return false; // no encrypted envelope
    if (p === CONFIG_REAL_PATH) return true;  // plaintext config present
    return origExistsSync.call(fs, p);
  };

  let error = null;
  let results = [];

  try {
    const gr = require('../generic-runner');

    // Fake page - simulates a page with a visible email input so fillGenericForm
    // actually calls getFieldMap() and tries to destructure getConfig().person
    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
      locator: (sel) => ({
        first: () => ({
          count: async () => (sel.includes('email') ? 1 : 0),
          isVisible: async () => (sel.includes('email')),
          evaluate: async () => 'input',
          fill: async () => {},
          click: async () => {},
          getAttribute: async () => null,
          selectOption: async () => {},
        }),
        all: async () => [],
      }),
      evaluate: async () => [],
      close: async () => {},
    };
    const fakeContext = { newPage: async () => fakePage };
    const state = { optOuts: {} };

    await gr.runGenericBrokers(
      fakeContext,
      [],
      state,
      (name, status, detail) => results.push({ name, status, detail }),
      () => {},
      {
        injectedBrokers: [{ name: 'testsite', url: 'https://testsite.example.com', source: 'test' }],
      }
    );
  } catch (e) {
    error = e;
  } finally {
    fs.readFileSync = origReadFileSync;
    fs.existsSync   = origExistsSync;
    delete require.cache[require.resolve('../generic-runner')];
  }

  assert.equal(error, null, `Expected no thrown error but got: ${error?.message}`);
  assert.equal(results.length, 1, 'Should have processed 1 broker');

  // The result should not be 'error' due to a TypeError about destructuring undefined.person
  // After the fix: persons[0] is used, so the form fills without crashing
  const status = results[0].status;
  assert.notEqual(status, 'error', `processGenericUrl should not error with persons[] config, got status='${status}' detail='${results[0].detail}'`);
});

// ─── Bug M2: pendingConfirm object vs pendingConfirmation boolean ─────────────

test('processGenericUrl skips broker with current pendingConfirm object (new schema)', async () => {
  const gr = freshRequire('../generic-runner');

  const now = new Date().toISOString();
  const state = {
    optOuts: {
      'pendingsite': {
        lastAttempt: now,
        pendingConfirm: { since: now, snippet: 'check your email' },
      },
    },
  };

  const fakePage = {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    locator: () => ({
      first: () => ({ count: async () => 0, isVisible: async () => false }),
      all: async () => [],
    }),
    evaluate: async () => [],
    close: async () => {},
  };
  const fakeContext = { newPage: async () => fakePage };

  const results = [];
  await gr.runGenericBrokers(
    fakeContext, [], state,
    (name, status, detail) => results.push({ name, status, detail }),
    () => {},
    {
      injectedBrokers: [{ name: 'pendingsite', url: 'https://pendingsite.example', source: 'test' }],
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'skipped', 'pendingConfirm entry within window should be skipped');
  assert.ok(
    results[0].detail.includes('pending confirm'),
    `detail should mention pending confirm, got: ${results[0].detail}`
  );
});

test('processGenericUrl does not use pendingConfirmation boolean (legacy dead field)', async () => {
  // After the fix, the old pendingConfirmation boolean is ignored.
  // With a 100-day-old lastAttempt (past RECHECK_DAYS=90), the entry should
  // NOT be skipped - it should be attempted (result will be manual/success/error
  // depending on what the fake page returns, but NOT 'skipped').
  const CONFIG_REAL_PATH = path.join(__dirname, '..', 'config.json');
  const CONFIG_ENC_PATH  = path.join(__dirname, '..', 'config.json.enc');
  const origReadFileSync = fs.readFileSync;
  const origExistsSync   = fs.existsSync;
  const cfg = {
    person: {
      firstName: 'A', lastName: 'B', fullName: 'A B',
      email: 'a@b.com', state: 'CA', zip: '90000',
    },
    email: { address: 'a@b.com' },
  };

  delete require.cache[require.resolve('../generic-runner')];
  fs.readFileSync = function(p, enc) {
    if (p === CONFIG_REAL_PATH) return JSON.stringify(cfg);
    return origReadFileSync.call(fs, p, enc);
  };
  fs.existsSync = function(p) {
    if (p === CONFIG_ENC_PATH) return false;
    if (p === CONFIG_REAL_PATH) return true;
    return origExistsSync.call(fs, p);
  };

  const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
  const state = {
    optOuts: {
      'legacysite': {
        lastAttempt: oldDate,
        pendingConfirmation: true, // OLD field - must be ignored after the fix
      },
    },
  };

  let statuses = [];
  try {
    const gr = require('../generic-runner');

    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
      locator: () => ({
        first: () => ({ count: async () => 0, isVisible: async () => false, getAttribute: async () => null }),
        all: async () => [],
      }),
      evaluate: async () => [],
      close: async () => {},
    };
    const fakeContext = { newPage: async () => fakePage };

    await gr.runGenericBrokers(
      fakeContext, [], state,
      (name, status, detail) => statuses.push({ name, status, detail }),
      () => {},
      {
        injectedBrokers: [{ name: 'legacysite', url: 'https://legacysite.example', source: 'test' }],
      }
    );
  } finally {
    fs.readFileSync = origReadFileSync;
    fs.existsSync   = origExistsSync;
    delete require.cache[require.resolve('../generic-runner')];
  }

  assert.equal(statuses.length, 1);
  assert.notEqual(
    statuses[0].status,
    'skipped',
    `old boolean pendingConfirmation should NOT cause skip after the fix, got: ${statuses[0].status}`
  );
});

// ─── Bug L2: recordFailure called for error/dead outcomes ─────────────────────

test('runGenericBrokers calls recordFailure for error outcome', async () => {
  const configPath = require.resolve('../lib/config');
  const origConfigExports = require(configPath);

  const failures = [];
  const spyConfig = Object.assign({}, origConfigExports, {
    recordFailure: (name, kind) => failures.push({ name, kind }),
    recordPendingConfirmation: () => {},
  });

  // Patch cache
  const origCacheEntry = require.cache[configPath];
  require.cache[configPath] = Object.assign({}, origCacheEntry, { exports: spyConfig });
  delete require.cache[require.resolve('../generic-runner')];
  const gr = require('../generic-runner');

  const brokers = [
    { name: 'errorsite', url: 'https://errorsite.example', source: 'test' },
    { name: 'deadsite',  url: 'https://deadsite.example',  source: 'test' },
  ];
  const outcomes = {
    errorsite: { status: 'error', detail: 'Timeout' },
    deadsite:  { status: 'dead',  detail: 'HTTP 404' },
  };
  const injectedProcessFn = async (_page, broker) => outcomes[broker.name];

  const fakePage = { close: async () => {}, waitForTimeout: async () => {} };
  const fakeContext = { newPage: async () => fakePage };

  try {
    await gr.runGenericBrokers(
      fakeContext, [], { optOuts: {} },
      () => {},
      () => {},
      { injectedBrokers: brokers, injectedProcessFn }
    );
  } finally {
    require.cache[configPath] = origCacheEntry;
    delete require.cache[require.resolve('../generic-runner')];
  }

  assert.ok(
    failures.some(f => f.name === 'errorsite'),
    `Expected recordFailure called for 'errorsite', got: ${JSON.stringify(failures)}`
  );
  assert.ok(
    failures.some(f => f.name === 'deadsite'),
    `Expected recordFailure called for 'deadsite', got: ${JSON.stringify(failures)}`
  );
});

test('runGenericBrokers calls recordFailure with kind "error" for both error and dead', async () => {
  const configPath = require.resolve('../lib/config');
  const origConfigExports = require(configPath);

  const failures = [];
  const spyConfig = Object.assign({}, origConfigExports, {
    recordFailure: (name, kind) => failures.push({ name, kind }),
    recordPendingConfirmation: () => {},
  });

  const origCacheEntry = require.cache[configPath];
  require.cache[configPath] = Object.assign({}, origCacheEntry, { exports: spyConfig });
  delete require.cache[require.resolve('../generic-runner')];
  const gr = require('../generic-runner');

  const brokers = [
    { name: 'errsite', url: 'https://errsite.example', source: 'test' },
    { name: 'dsite',   url: 'https://dsite.example',   source: 'test' },
  ];
  const outcomes = {
    errsite: { status: 'error', detail: 'net::ERR' },
    dsite:   { status: 'dead',  detail: 'HTTP 503' },
  };

  try {
    await gr.runGenericBrokers(
      { newPage: async () => ({ close: async () => {}, waitForTimeout: async () => {} }) },
      [],
      { optOuts: {} },
      () => {},
      () => {},
      {
        injectedBrokers: brokers,
        injectedProcessFn: async (_p, b) => outcomes[b.name],
      }
    );
  } finally {
    require.cache[configPath] = origCacheEntry;
    delete require.cache[require.resolve('../generic-runner')];
  }

  const errFailure = failures.find(f => f.name === 'errsite');
  const deadFailure = failures.find(f => f.name === 'dsite');
  assert.ok(errFailure, 'recordFailure should be called for error outcome');
  assert.ok(deadFailure, 'recordFailure should be called for dead outcome');
  assert.equal(errFailure.kind, 'error');
  assert.equal(deadFailure.kind, 'error');
});
