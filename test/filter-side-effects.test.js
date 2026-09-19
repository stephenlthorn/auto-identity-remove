/**
 * test/filter-side-effects.test.js
 *
 * Item: a broker excluded by the run filter (--only / --skip / --retry-failed)
 * must perform ZERO side effects - no navigation, no email, no log line, no
 * state mutation. Filtering happens before any broker's first side effect,
 * not after.
 *
 * Three layers are exercised with spies/stubs:
 *   1. email    - sendOptOutEmails on a filtered list: excluded broker gets no
 *                 sendMail, no logResult, no recordSuccess.
 *   2. generic  - runGenericBrokers with the filtered injected list: the
 *                 excluded broker's process function is never invoked and its
 *                 name never reaches the logger.
 *   3. wiring   - static assertions on watcher.js that every side-effectful
 *                 dispatch (email, verify, explicit loop, generic, know)
 *                 receives an applyFilter-ed list, resolved before first use.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const { applyFilter } = require('../lib/filter');
const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const EMAIL_BROKER_A = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };
const EMAIL_BROKER_B = { name: 'Spokeo (email)', method: 'email', emailTo: 'privacy@spokeo.com' };

const PERSON = { firstName: 'Test', lastName: 'User', email: 't@example.com', country: 'US' };

// ── Layer 1: email ────────────────────────────────────────────────────────────

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function loadFreshEmailWithSmtpSpy(nmCalls) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return { messageId: 'spy' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const freshEmail = require('../lib/email');
  return {
    freshEmail,
    restore() {
      Module._load = origLoad;
      delete require.cache[require.resolve('../lib/email')];
      require('../lib/email');
    },
  };
}

test('--only: an email broker outside the filter sends nothing, logs nothing, records nothing', async () => {
  const nmCalls = [];
  const logCalls = [];
  const successCalls = [];

  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = (key, detail) => successCalls.push({ key, detail });
  loggerMod.logResult = (name, status, detail) => logCalls.push({ name, status, detail });

  const { freshEmail, restore } = loadFreshEmailWithSmtpSpy(nmCalls);
  try {
    // Exactly what watcher.js now does: applyFilter BEFORE sendOptOutEmails.
    const filtered = applyFilter([EMAIL_BROKER_A, EMAIL_BROKER_B], { only: 'Pipl' });
    await freshEmail.sendOptOutEmails(filtered, { person: PERSON, email: { smtp: { host: 'h', user: 'u', pass: 'p' } } }, 'linux', {});
  } finally {
    restore();
    configMod.lastOptOutDaysAgo = origLastOptOut;
    configMod.recordSuccess = origRecordSuccess;
    loggerMod.logResult = origLogResult;
  }

  assert.equal(nmCalls.length, 1, 'only the included broker may be emailed');
  assert.equal(nmCalls[0].to, 'privacy@pipl.com');
  assert.ok(
    !logCalls.some(l => l.name === 'Spokeo (email)'),
    `excluded broker produced a log line: ${JSON.stringify(logCalls)}`
  );
  assert.ok(
    !successCalls.some(c => String(c.key).includes('Spokeo')),
    `excluded broker mutated state: ${JSON.stringify(successCalls)}`
  );
});

test('--skip: the skipped email broker produces zero side effects', async () => {
  const nmCalls = [];
  const logCalls = [];
  const successCalls = [];

  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = (key, detail) => successCalls.push({ key, detail });
  loggerMod.logResult = (name, status, detail) => logCalls.push({ name, status, detail });

  const { freshEmail, restore } = loadFreshEmailWithSmtpSpy(nmCalls);
  try {
    const filtered = applyFilter([EMAIL_BROKER_A, EMAIL_BROKER_B], { skip: 'Pipl' });
    await freshEmail.sendOptOutEmails(filtered, { person: PERSON, email: { smtp: { host: 'h', user: 'u', pass: 'p' } } }, 'linux', {});
  } finally {
    restore();
    configMod.lastOptOutDaysAgo = origLastOptOut;
    configMod.recordSuccess = origRecordSuccess;
    loggerMod.logResult = origLogResult;
  }

  assert.equal(nmCalls.length, 1);
  assert.equal(nmCalls[0].to, 'privacy@spokeo.com');
  assert.ok(!logCalls.some(l => l.name === 'Pipl'), 'skipped broker must not be logged');
  assert.ok(!successCalls.some(c => String(c.key).includes('Pipl')), 'skipped broker must not touch state');
});

// ── Layer 2: generic runner ───────────────────────────────────────────────────

test('generic pass: a filtered-out generic broker is never processed, navigated, or logged', async () => {
  const { runGenericBrokers } = require('../generic-runner');

  const allGeneric = [
    { name: 'wanted.example.com', url: 'https://wanted.example.com/optout' },
    { name: 'excluded.example.com', url: 'https://excluded.example.com/optout' },
  ];
  const filtered = applyFilter(allGeneric, { only: 'wanted.example.com' });

  const processed = [];
  const logged = [];
  const stateWrites = [];
  const page = {
    goto: async (url) => { throw new Error(`navigation attempted to ${url}`); },
    waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ count: async () => 0 }), all: async () => [] }),
    isClosed: () => false,
    close: async () => {},
  };
  const context = { newPage: async () => page, pages: () => [page] };

  const spyProcess = async (pg, broker) => {
    processed.push(broker.name);
    return { status: 'manual', detail: broker.url };
  };

  await runGenericBrokers(context, new Set(), { optOuts: {} },
    (name, status, detail) => logged.push(name),
    (key) => stateWrites.push(key),
    { injectedBrokers: filtered, injectedProcessFn: spyProcess, person: PERSON, personCount: 1 });

  assert.deepEqual(processed, ['wanted.example.com'], 'only the included broker may be processed');
  assert.ok(!logged.includes('excluded.example.com'), 'excluded broker must never reach the logger');
  assert.ok(!stateWrites.some(k => String(k).includes('excluded')), 'excluded broker must not touch state');
});

// ── Layer 3: watcher.js wiring (static) ──────────────────────────────────────
// watcher.js is a script, not an importable module, so the dispatch order is
// locked by asserting the filtered list is what reaches each side-effectful
// call site. Same static-analysis convention as docs-commands.test.js.

const WATCHER_SRC = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');

test('watcher: the run filter is resolved once, before any dispatch', () => {
  const filterDecl = WATCHER_SRC.indexOf('const filterOpts = { only: ONLY_ARG, skip: SKIP_ARG, retryFailedFromLog };');
  assert.ok(filterDecl !== -1, 'filterOpts must be resolved in _mainBody');

  const firstDispatch = Math.min(
    ...[
      WATCHER_SRC.indexOf('await sendOptOutEmails('),
      WATCHER_SRC.indexOf('await runVerify('),
      WATCHER_SRC.indexOf('await brokerRunner.processBroker('),
      WATCHER_SRC.indexOf('await runGenericBrokers('),
    ].filter(i => i !== -1)
  );
  assert.ok(filterDecl < firstDispatch, 'filter must be resolved before the first broker dispatch');
});

test('watcher: every side-effectful dispatch receives a filtered broker list', () => {
  // Email opt-outs get the filtered list, not the raw brokers array.
  assert.match(WATCHER_SRC, /sendOptOutEmails\(filteredBrokers,/,
    'sendOptOutEmails must receive filteredBrokers');
  assert.ok(!WATCHER_SRC.includes('sendOptOutEmails(brokers,'),
    'sendOptOutEmails must NOT receive the unfiltered brokers array');

  // The verify loop gets the filtered list.
  assert.match(WATCHER_SRC, /runVerify\(context, filteredBrokers,/,
    'runVerify must receive filteredBrokers');

  // The per-person explicit list is filtered before the processBroker loop.
  assert.match(WATCHER_SRC, /applyFilter\(brokers\.forPerson\(person\), filterOpts\)/,
    'person broker list must be filtered before dispatch');

  // The generic pass is filtered, and skipped entirely when nothing matches.
  assert.match(WATCHER_SRC, /applyFilter\(loadGenericBrokers\(explicitHosts\), filterOpts\)/,
    'generic broker list must be filtered');
  assert.match(WATCHER_SRC, /injectedBrokers: genericBrokers/,
    'filtered generic list must be injected into runGenericBrokers');

  // --know mode filters its email-broker list too.
  assert.match(WATCHER_SRC, /sendKnowRequests\(knowBrokers,/,
    'sendKnowRequests must receive a filtered list');

  // Noise mode uses the filtered per-person list, not the raw module array.
  assert.match(WATCHER_SRC, /personBrokers\.filter\(b => b\.acceptsBogus === true\)/,
    'pollute must draw from the filtered broker list');
});

test('watcher: filtered-out brokers never reach processBroker (the loop runs the filtered list)', () => {
  // The explicit opt-out dispatch must sit inside the `for (const broker of
  // sorted)` loop, where `sorted` derives from the filtered personBrokers.
  assert.match(
    WATCHER_SRC,
    /for \(const broker of sorted\)\s*\{[\s\S]{0,400}?await brokerRunner\.processBroker\(context, broker\)/,
    'processBroker must be dispatched from the filtered+sorted loop'
  );
  // And the noise-mode dispatch must draw from the filtered bogBrokers list.
  assert.match(
    WATCHER_SRC,
    /for \(const broker of bogBrokers\)\s*\{[\s\S]{0,400}?await brokerRunner\.processBrokerWithPerson\(context, broker, fakePerson\)/,
    'noise dispatch must use the filtered bogus-broker list'
  );
});
