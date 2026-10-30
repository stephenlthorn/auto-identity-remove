/**
 * test/generic-round2.test.js
 *
 * Round 2 of the generic-runner audit, against the form-aware fake page:
 *
 *   BRK2-3   a form submitted while the CAPTCHA wait was on (by the person, or by
 *            the solver's callback) is never clicked a second time, and a form that
 *            went away is classified, not reported "no submit control"
 *   BRK2-5   a CAPTCHA that went away because the page was replaced is not solved
 *   CLI2-5   a browser that dies mid-pass stops the pass cleanly instead of turning
 *            every remaining row into an error
 *   codex #8 broker response snippets never carry the person's own details
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

const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'test.user@home.example', state: 'CA', zip: '90001', phone: '5125550142' };
const BROKER = { name: 'CaptchaBroker', url: 'https://broker.example/opt-out', source: 'markup' };

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-r2-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const form = (afterSubmit = { body: 'Your request has been received.' }) => optOutForm({
  fields: ['email', 'firstName', 'lastName', gr.CAPTCHA_IN_FORM_SELECTOR],
  afterSubmit,
});

/** The fake page plus the in-page submit watch. */
function watchedPage(spec) {
  const page = makeFakePage(spec);
  page.watchCount = 0;
  const base = page.evaluate;
  page.evaluate = async (fn, arg) => {
    if (fn && fn.name === 'installSubmitWatch') return true;
    if (fn && fn.name === 'readSubmitWatch') return page.watchCount;
    return base(fn, arg);
  };
  return page;
}

const submitClicks = (page) => page.clicked.filter((c) => c.sel.includes('button[type="submit"]'));
const run = (page, opts = {}) => gr.processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });

// ── BRK2-3 ────────────────────────────────────────────────────────────────────

test('BRK2-3: the person pressed Send while the CAPTCHA wait was on: the tool does not click again', async () => {
  const page = watchedPage({ forms: [form()] });
  const result = await run(page, {
    handleCaptcha: async (p) => { p.watchCount = 1; p.body = 'Opt out\nRequest received #1'; return 'solved'; },
  });
  assert.equal(submitClicks(page).length, 0, 'a second click is a second request at the broker');
  assert.notEqual(result.status, 'error', JSON.stringify(result));
});

test('BRK2-3: the form was replaced by its confirmation: classified, never "no submit control"', async () => {
  const page = watchedPage({ forms: [form()] });
  const result = await run(page, {
    handleCaptcha: async (p) => { p.forms[0].hasSubmit = false; p.body = 'Your request has been received'; return 'solved'; },
  });
  assert.equal(submitClicks(page).length, 0);
  assert.equal(result.status, 'success', JSON.stringify(result));
});

test('BRK2-3: a plain solve is still followed by exactly one click', async () => {
  const page = watchedPage({ forms: [form()] });
  const result = await run(page, { handleCaptcha: async () => 'solved' });
  assert.equal(submitClicks(page).length, 1);
  assert.equal(result.status, 'success');
});

// ── BRK2-5 ────────────────────────────────────────────────────────────────────

test('BRK2-5: "navigated" with a result message that was not there before counts as the form having been sent', async () => {
  const page = watchedPage({ forms: [form()] });
  const result = await run(page, {
    handleCaptcha: async (p) => { p.body = 'Your opt-out request has been received.'; return 'navigated'; },
  });
  assert.equal(submitClicks(page).length, 0);
  assert.equal(result.status, 'success');
});

test('BRK2-5: "navigated" with nothing to show for it is captcha_failed', async () => {
  const page = watchedPage({ forms: [form()] });
  const result = await run(page, {
    handleCaptcha: async (p) => { p.body = '502 Bad Gateway'; return 'navigated'; },
  });
  assert.equal(result.status, 'captcha_failed');
  assert.deepEqual(submitClicks(page), []);
});

// ── CLI2-5 ────────────────────────────────────────────────────────────────────

function rows(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `Row ${i}`, url: `https://row${i}.example/opt-out` }));
}

/** A context whose first page comes back already closed and whose later newPage() calls throw. */
function dyingContext() {
  let opened = 0;
  return {
    pages: () => [],
    async newPage() {
      opened += 1;
      if (opened > 1) throw new Error('browserContext.newPage: Target page, context or browser has been closed');
      const page = makeFakePage({});
      page.isClosed = () => true;
      return page;
    },
  };
}

test('CLI2-5: getContext rebuilds the working page on the relaunched browser and the row that hit the dead page is tried again', async () => {
  const fresh = { pages: () => [], newPage: async () => makeFakePage({}) };
  const logged = [];
  let asked = 0;
  let calls = 0;
  const result = await gr.runGenericBrokers(dyingContext(), new Set(), { optOuts: {} }, (name, status) => logged.push({ name, status }), () => {}, {
    injectedBrokers: rows(4),
    injectedProcessFn: async () => { calls += 1; if (calls === 1) throw new Error('Target closed'); return { status: 'manual', detail: 'x' }; },
    getContext: async () => { asked += 1; return fresh; },
  });
  assert.equal(asked, 1);
  assert.equal(result.browserClosed, undefined);
  assert.deepEqual(logged.map((l) => l.status), ['manual', 'manual', 'manual', 'manual']);
  assert.equal(calls, 5, 'row 0 ran twice: once on the dead page, once on the new one');
});

test('CLI2-5: when getContext throws (the browser cannot be relaunched) every remaining row is recorded as an error that says so', async () => {
  const logged = [];
  const failures = [];
  const config = require('../lib/config');
  const origFailure = config.recordFailure;
  config.recordFailure = (key, kind) => failures.push({ key, kind });
  let ran = 0;
  try {
    const result = await gr.runGenericBrokers(dyingContext(), new Set(), { optOuts: {} }, (name, status, detail) => logged.push({ name, status, detail }), () => {}, {
      injectedBrokers: rows(6),
      injectedProcessFn: async () => { ran += 1; throw new Error('Target page, context or browser has been closed'); },
      getContext: async () => { throw new Error('launch failed 3 times'); },
    });
    assert.equal(result.browserClosed, true);
    assert.equal(logged.length, 6, 'no row disappears from the log');
    assert.ok(logged.every((l) => l.status === 'error' && /browser could not be relaunched/i.test(l.detail)), JSON.stringify(logged));
    assert.equal(ran, 1, 'nothing more is run on a browser that is gone');
    assert.equal(result.genericStats.error, 6);
    assert.deepEqual(failures, [], 'a dead browser is not evidence against the brokers: nothing counts toward defunct');
  } finally {
    config.recordFailure = origFailure;
  }
});

test('CLI2-5: with no getContext the pass behaves the same way on a browser that cannot open a page', async () => {
  const logged = [];
  const result = await gr.runGenericBrokers(dyingContext(), new Set(), { optOuts: {} }, (name, status, detail) => logged.push({ name, status, detail }), () => {}, {
    injectedBrokers: rows(4),
    injectedProcessFn: async () => { throw new Error('Target closed'); },
  });
  assert.equal(result.browserClosed, true);
  assert.equal(logged.length, 4);
  assert.ok(logged.every((l) => l.status === 'error' && /browser closed/i.test(l.detail)), JSON.stringify(logged));
});

test('CLI2-5: the checkpoint stays on the first row the browser could not run, so --resume starts there', async () => {
  const checkpoints = [];
  await gr.runGenericBrokers(dyingContext(), new Set(), { optOuts: {} }, () => {}, () => {}, {
    injectedBrokers: rows(5),
    injectedProcessFn: async () => { throw new Error('Target closed'); },
    getContext: async () => { throw new Error('gone'); },
    saveCheckpoint: (record) => checkpoints.push(record),
    now: () => 0,
  });
  assert.equal(checkpoints.at(-1).index, 0);
});

test('CLI2-5: a browser that is already unusable when the pass starts fails every row the same way, without a throw', async () => {
  const logged = [];
  const context = { pages: () => [], async newPage() { throw new Error('closed'); } };
  const result = await gr.runGenericBrokers(context, new Set(), { optOuts: {} }, (name, status, detail) => logged.push({ name, status, detail }), () => {}, {
    injectedBrokers: rows(3),
    injectedProcessFn: async () => { throw new Error('unreachable'); },
    getContext: async () => { throw new Error('gone'); },
  });
  assert.equal(result.browserClosed, true);
  assert.equal(logged.length, 3);
});

// ── codex #8 ──────────────────────────────────────────────────────────────────

test('codex #8: a success snippet that echoes the person\'s email or name is redacted before it is logged or recorded', async () => {
  const echo = 'Thanks Test User! Your opt-out request has been received for test.user@home.example, zip 90001, phone 512-555-0142.';
  const page = watchedPage({ forms: [optOutForm({ fields: ['email', 'firstName', 'lastName'], afterSubmit: { body: echo } })] });
  const result = await run(page);
  assert.equal(result.status, 'success');
  for (const secret of ['test.user@home.example', 'Test User', '90001', '512-555-0142', '5125550142']) {
    assert.ok(!result.detail.includes(secret), `detail leaked ${secret}: ${result.detail}`);
  }
  assert.match(result.detail, /request has been received/i, 'the evidence itself is kept');
});

test('codex #8: the relay alias and the real email are both redacted', async () => {
  const alias = 'hide.abc123@relay.example';
  const echo = `Your opt-out request has been received. Confirmation sent to ${alias}.`;
  const page = watchedPage({ forms: [optOutForm({ fields: ['email'], afterSubmit: { body: echo } })] });
  const result = await run(page, { submissionEmail: alias });
  assert.ok(!result.detail.includes(alias), result.detail);
});
