/**
 * test/integration-wave2-leftovers.test.js
 *
 * The cross-package leftovers the wave-1 packages could not do themselves:
 *
 *   - lib/drift: 'form_error' and 'dead' are non-success kinds
 *   - lib/filter.extractFailedBrokers: the 'unverified' bucket counts as failed
 *   - lib/logger.logResult: an optional 4th argument stores the broker host
 *   - lib/broker-runner, lib/email, lib/verify-loop, generic-runner: state is
 *     read through the person-aware reader, so a 1 -> 2 person upgrade keeps
 *     person 1's history instead of re-submitting every broker
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isDrifted } = require('../lib/drift');
const { extractFailedBrokers } = require('../lib/filter');
const logger = require('../lib/logger');
const { loadRunner, makePage, makeContext, SUBMIT_BROKER } = require('./broker-runner-harness');
const { runVerify } = require('../lib/verify-loop');
const { processGenericUrl, runGenericBrokers } = require('../generic-runner');

const JOHN = { firstName: 'John', lastName: 'Smith', email: 'john@example.test' };
const JANE = { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.test' };

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

// ── drift ─────────────────────────────────────────────────────────────────────

test('drift: three form_error / dead outcomes in a row count as drifted', () => {
  assert.equal(isDrifted(['form_error', 'form_error', 'form_error']), true);
  assert.equal(isDrifted(['dead', 'dead', 'dead']), true);
  assert.equal(isDrifted(['error', 'form_error', 'dead']), true);
});

test('drift: a success inside the last three still clears it', () => {
  assert.equal(isDrifted(['dead', 'success', 'dead']), false);
});

// ── filter ────────────────────────────────────────────────────────────────────

test('extractFailedBrokers: brokers whose result could not be confirmed are retried', () => {
  const failed = extractFailedBrokers({
    errors: [{ broker: 'A' }],
    unverified: [{ broker: 'B' }],
    pendingConfirm: [{ broker: 'C' }],
    succeeded: [{ broker: 'D' }],
  });
  assert.deepEqual([...failed].sort(), ['A', 'B', 'C']);
});

// ── logger ────────────────────────────────────────────────────────────────────

test('logResult stores the broker host when given one (prune-dead reads it)', () => {
  logger.resetResults();
  logger.logResult('Some Company', 'dead', 'cached dead-url, skipped', { host: 'gone.example.com' });
  logger.logResult('No Host Co', 'error', 'x');
  const [withHost] = logger.results.dead;
  assert.equal(withHost.host, 'gone.example.com');
  assert.equal('host' in logger.results.errors[0], false);
  logger.resetResults();
});

// ── broker-runner ─────────────────────────────────────────────────────────────

test('broker-runner passes the person and personIndex to shouldSkip', async () => {
  const h = loadRunner();
  h.runner.configure({ dryRun: true, person: JANE, personCount: 2, personIndex: 1, capsolver: null });
  const page = makePage({ elements: [] });

  await h.runner.processBroker(makeContext(page), { ...SUBMIT_BROKER, method: 'manual' });

  assert.equal(h.recorded.skipOpts.length, 1);
  const [name, opts] = h.recorded.skipOpts[0];
  assert.equal(name, SUBMIT_BROKER.name);
  assert.equal(opts.person, JANE);
  assert.equal(opts.personCount, 2);
  assert.equal(opts.personIndex, 1);
});

// ── email ─────────────────────────────────────────────────────────────────────

test('email opt-outs: person 1 keeps their pre-upgrade (bare key) history, person 2 does not inherit it', async () => {
  const configMod = require('../lib/config');
  const loggerMod = require('../lib/logger');
  const { sendOptOutEmails } = require('../lib/email');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-wave2-'));
  configMod.setTestStatePath(path.join(dir, 'state.json'));
  configMod.setDryRun(true);
  configMod.resetState();
  const state = configMod.loadState();
  state.optOuts = { 'Email Broker': { lastSuccess: daysAgo(3), lastAttempt: daysAgo(3) } };
  loggerMod.resetResults();

  try {
    const cfg = { persons: [JOHN, JANE], email: { smtp: {} } };
    const brokers = [{ name: 'Email Broker', method: 'email', emailTo: 'privacy@broker.test' }];

    await sendOptOutEmails(brokers, cfg, undefined, { onlyPerson: JOHN, dryRun: true });
    await sendOptOutEmails(brokers, cfg, undefined, { onlyPerson: JANE, dryRun: true });

    const details = loggerMod.results.skipped.map(r => r.detail);
    assert.equal(details.length, 2);
    assert.match(details[0], /already sent recently/, 'John (persons[0]) was emailed 3 days ago under the bare key');
    assert.match(details[1], /dry-run - would email/, 'Jane has no history of her own');
  } finally {
    configMod.setDryRun(false);
    configMod.setTestStatePath(null);
    loggerMod.resetResults();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── verify-loop ───────────────────────────────────────────────────────────────

test('verify: person 1 is still verified from their bare-key history after a second person is added', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10) } } };
  const broker = { name: 'Spokeo', method: 'search-form', searchUrl: 'https://s.test/q', listingPattern: 'x' };
  const searched = [];
  const context = { newPage: async () => ({ close: async () => {} }) };

  const result = await runVerify(context, [broker], [JOHN, JANE], {
    state,
    brokersFor: () => [broker],
    findUrl: async (page, b, person) => { searched.push(person.firstName); return null; },
  });

  assert.deepEqual(searched, ['John'], 'only John has a recorded opt-out; Jane must not borrow his');
  assert.equal(result.verified_clear.length, 1);
  assert.ok(state.optOuts['Spokeo|John Smith'].verifiedDeletedAt, 'the result is written under the multi-person key');
  assert.equal(result.skipped.find(s => s.person === JANE).reason, 'no recorded opt-out submission');
});

// ── generic-runner ────────────────────────────────────────────────────────────

test('generic runner: a bare-key success of persons[0] still cools the broker down in a 2-person run', async () => {
  const state = { optOuts: { 'gen.example': { lastSuccess: daysAgo(5), lastAttempt: daysAgo(5) } } };
  const broker = { name: 'gen.example', url: 'https://gen.example/optout' };
  const opts = { person: JOHN, personCount: 2, personIndex: 0, stateKey: 'gen.example|John Smith' };

  const john = await processGenericUrl(null, broker, state, false, new Set(), opts);
  assert.equal(john.status, 'skipped');
  assert.match(john.detail, /5d ago/);

  const jane = await processGenericUrl(null, broker, state, false, new Set(['gen.example']),
    { person: JANE, personCount: 2, personIndex: 1, stateKey: 'gen.example|Jane Smith' });
  assert.equal(jane.status, 'dead', 'Jane has no history, so the run proceeds past the cooldown check');
});

test('generic runner: every result carries the host it was about, and the working page accepts dialogs', async () => {
  const logged = [];
  const events = [];
  const page = {
    on: (event) => events.push(event),
    setDefaultTimeout() {},
    waitForTimeout: async () => {},
    close: async () => {},
    isClosed: () => false,
  };
  const context = { newPage: async () => page, pages: () => [page] };

  await runGenericBrokers(context, new Set(), { optOuts: {} }, (...args) => logged.push(args), () => {}, {
    person: JOHN,
    personCount: 2,
    personIndex: 0,
    // 'skipped' writes no state, so this test never touches a state file
    injectedBrokers: [{ name: 'Acme Corp', url: 'https://www.acme-data.example/optout' }],
    injectedProcessFn: async (_page, _broker, _state, _dryRun, _dead, passed) => {
      assert.equal(passed.personIndex, 0);
      assert.equal(passed.personCount, 2);
      return { status: 'skipped', detail: 'test' };
    },
  });

  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0][3], { host: 'acme-data.example' });
  assert.ok(events.includes('dialog'), 'confirm() dialogs must be accepted, not auto-dismissed');
});
