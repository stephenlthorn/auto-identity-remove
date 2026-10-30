/**
 * test/generic-runner-roadmap-wiring.test.js
 *
 * Two small contracts the watcher relies on for the generic pass:
 *
 *   R5  every state write carries `{ person }`, so the entry is stamped with that
 *       person's identity fingerprint. The generic runner wrote success, pending
 *       and failure entries with no stamp, so a corrected zip or email never
 *       invalidated a 90-day "done" for the ~490 generic brokers.
 *
 *   R1  a form behind a CAPTCHA nobody solved is reported with the SAME detail the
 *       explicit runner gives (opt-out URL first, why, and `aidr captchas`), through
 *       opts.captchaFailureDetail. The URL first matters: the watcher opens manual
 *       URLs from the start of a detail at the end of the run.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext, optOutForm } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001', phone: '5125550101',
};

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-generic-wiring-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  cfg.setDryRun(false);
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const silent = async (fn) => {
  const log = console.log;
  const write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = () => true;
  try { return await fn(); } finally { console.log = log; process.stdout.write = write; }
};

async function runOne(status, detail = 'x', extra = {}) {
  const state = cfg.loadState();
  await silent(() => gr.runGenericBrokers(
    { newPage: async () => makeFakePage({}), pages: () => [] },
    new Set(),
    state,
    () => {},
    cfg.recordSuccess,
    {
      dryRun: false,
      person: PERSON,
      personCount: 1,
      injectedBrokers: [{ name: `Stamp-${status}`, url: 'https://broker.example/opt-out', source: 'test' }],
      injectedProcessFn: async () => ({ status, detail }),
      injectedDeadSet: new Set(),
      ...extra,
    },
  ));
  return cfg.loadState().optOuts[`Stamp-${status}`];
}

for (const status of ['success', 'pending_confirm', 'error', 'captcha_failed']) {
  test(`a ${status} generic result is stamped with the person's fingerprint`, async () => {
    const entry = await runOne(status);
    assert.ok(entry, `an entry should have been written for ${status}`);
    assert.equal(entry.fp, cfg.personFingerprint(PERSON));
  });
}

test('a dead-host result is stamped like any other failure', async () => {
  const entry = await runOne('dead');
  assert.ok(!entry || entry.fp === cfg.personFingerprint(PERSON));
});

// ── CAPTCHA detail ───────────────────────────────────────────────────────────

const BROKER = { name: 'CaptchaBroker', url: 'https://broker.example/opt-out', source: 'markup' };
const captchaForm = () => optOutForm({
  fields: ['email', 'firstName', 'lastName', gr.CAPTCHA_IN_FORM_SELECTOR],
  afterSubmit: { body: 'Your request has been received.' },
});
const run = (page, opts) => gr.processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });

test('captchaFailureDetail builds the detail of an unsolved CAPTCHA, given the outcome and the broker row', async () => {
  const page = makeFakePage({ forms: [captchaForm()] });
  const seen = [];
  const result = await run(page, {
    handleCaptcha: async () => 'timeout',
    captchaFailureDetail: (info) => { seen.push(info); return `${info.broker.url} - CAPTCHA not solved within 3 min; retry with: aidr captchas`; },
  });
  assert.equal(result.status, 'captcha_failed');
  assert.equal(result.detail, 'https://broker.example/opt-out - CAPTCHA not solved within 3 min; retry with: aidr captchas');
  assert.deepEqual(seen, [{ outcome: 'timeout', broker: BROKER }]);
  assert.deepEqual(page.clicked, []);
});

test('without captchaFailureDetail the detail is the one R2 always gave', async () => {
  const page = makeFakePage({ forms: [captchaForm()] });
  const result = await run(page, { handleCaptcha: async () => 'failed' });
  assert.match(result.detail, /CAPTCHA not solved \(failed\)/);
});

test('a captchaFailureDetail that throws never loses the failure', async () => {
  const page = makeFakePage({ forms: [captchaForm()] });
  const result = await run(page, {
    handleCaptcha: async () => 'skipped',
    captchaFailureDetail: () => { throw new Error('boom'); },
  });
  assert.equal(result.status, 'captcha_failed');
  assert.match(result.detail, /CAPTCHA/);
});

test('runGenericBrokers passes captchaFailureDetail and handleCaptcha through to each broker', async () => {
  const seen = [];
  const hook = () => 'detail';
  const handler = async () => 'none';
  await silent(() => gr.runGenericBrokers(
    { newPage: async () => makeFakePage({}), pages: () => [] },
    new Set(),
    { optOuts: {} },
    () => {},
    () => {},
    {
      dryRun: true,
      person: PERSON,
      injectedBrokers: [{ name: 'Passthrough', url: 'https://broker.example/opt-out', source: 'test' }],
      injectedProcessFn: async (page, broker, state, dry, dead, passed) => { seen.push(passed); return { status: 'skipped', detail: 'dry-run' }; },
      injectedDeadSet: new Set(),
      captchaFailureDetail: hook,
      handleCaptcha: handler,
    },
  ));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].captchaFailureDetail, hook);
  assert.equal(seen[0].handleCaptcha, handler);
});
