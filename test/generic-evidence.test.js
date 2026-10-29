/**
 * test/generic-evidence.test.js
 *
 * BRK-1 / codex #4: a generic click was recorded `success` with no evidence.
 * finalize() only asked "does the page want an email confirmation?" and otherwise
 * reported success, so a form that said "This field is required", a reCAPTCHA
 * wall, or an unrelated footer newsletter all earned recordSuccess() and a 90-day
 * cooldown while the user's data stayed online.
 *
 * Contract now:
 *   - fill and click happen inside ONE <form> (the footer newsletter next to the
 *     real form is never touched)
 *   - body text is read before and after the click; only the NEW text is judged
 *   - success evidence       -> 'success'
 *   - failure / validation   -> 'error'
 *   - confirmation-email text -> 'pending_confirm'
 *   - nothing conclusive     -> 'unverified' (no recordSuccess, no cooldown)
 *   - a form whose submit never got clicked -> 'error'
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext, optOutForm, newsletterForm } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001',
};
const BROKER = { name: 'EvidenceBroker', url: 'https://broker.example/opt-out', source: 'markup' };

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-evidence-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (page, opts = {}) =>
  gr.processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });

// ── newTextSince ─────────────────────────────────────────────────────────────

test('newTextSince returns only lines that were not on the page before', () => {
  const before = 'Header\nOpt out of the sale of your data\nEmail\nFooter';
  const after = 'Header\nOpt out of the sale of your data\nEmail\nThis field is required\nFooter';
  assert.equal(gr.newTextSince(before, after), 'This field is required');
});

test('newTextSince returns empty when nothing changed, ignoring whitespace noise', () => {
  assert.equal(gr.newTextSince('a\n  b  \n\n\nc', 'a\nb\nc'), '');
  assert.equal(gr.newTextSince('', ''), '');
  assert.equal(gr.newTextSince(undefined, undefined), '');
});

test('newTextSince treats a wholly replaced page as all new', () => {
  assert.equal(gr.newTextSince('old one\nold two', 'Your request has been received\nThanks'), 'Your request has been received\nThanks');
});

test('newTextSince is a multiset diff: a line that appears once more is new', () => {
  assert.equal(gr.newTextSince('same\nsame', 'same\nsame\nsame'), 'same');
});

// ── judged on the NEW text only ──────────────────────────────────────────────

test('BRK-1: post-click "This field is required" is an error, not a success', async () => {
  const page = makeFakePage({
    body: 'Opt out\nEmail',
    forms: [optOutForm({ afterSubmit: { appendBody: 'Invalid email. This field is required.' } })],
  });
  const result = await run(page);
  assert.ok(page.clicked.length > 0, 'precondition: the submit was clicked');
  assert.equal(result.status, 'error');
  assert.match(result.detail, /required|invalid/i, 'detail says why');
});

test('BRK-1: a click that leaves the page unchanged is unverified, never success', async () => {
  const page = makeFakePage({
    body: 'Opt out of the sale of your personal information\nEmail',
    forms: [optOutForm({ afterSubmit: {} })],
  });
  const result = await run(page);
  assert.ok(page.clicked.length > 0);
  assert.equal(result.status, 'unverified');
  assert.match(result.detail, /no explicit confirmation/i);
});

test('BRK-1: explicit success wording after the click is a success', async () => {
  const page = makeFakePage({
    body: 'Opt out\nEmail',
    forms: [optOutForm({ afterSubmit: { body: 'Thank you.\nYour opt-out request has been received.' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'success');
  assert.match(result.detail, /received/i, 'the evidence snippet is kept as the detail');
});

test('BRK-1: success wording that was ALREADY on the page does not count (new text only)', async () => {
  const page = makeFakePage({
    body: 'How it works: once we have received your request, we will process it.\nWe have received your request',
    forms: [optOutForm({ afterSubmit: {} })],
  });
  const result = await run(page);
  assert.notEqual(result.status, 'success', 'static copy that matches the success pattern is not evidence');
  assert.equal(result.status, 'unverified');
});

test('BRK-1: failure wording that was already on the page does not turn a real success into an error', async () => {
  const page = makeFakePage({
    body: 'Having trouble? Please try again later or contact support.',
    forms: [optOutForm({ afterSubmit: { appendBody: 'Your request has been submitted' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'success');
});

test('BRK-1: confirmation-email wording after the click is pending_confirm (existing path)', async () => {
  const page = makeFakePage({
    body: 'Opt out\nEmail',
    forms: [optOutForm({ afterSubmit: { appendBody: 'Check your email to confirm your request.' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'pending_confirm');
  assert.match(result.detail, /check your email/i);
});

test('BRK-1: a Spanish success page is recognised through the page language', async () => {
  const page = makeFakePage({
    lang: 'es-ES',
    body: 'Darse de baja\nCorreo',
    forms: [optOutForm({ afterSubmit: { appendBody: 'Hemos recibido su solicitud.' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'success');
});

// ── fill and click inside ONE form ───────────────────────────────────────────

test('BRK-1: with a footer newsletter form before the real form, only the real form is touched', async () => {
  const page = makeFakePage({
    body: 'Opt out\nEmail',
    forms: [
      newsletterForm(),
      optOutForm({ afterSubmit: { body: 'Your request has been received.' } }),
    ],
  });
  const result = await run(page);
  assert.equal(result.status, 'success');
  assert.ok(page.filled.length > 0);
  assert.ok(page.filled.every(f => f.form === 1), `every field must be filled inside the opt-out form, got forms ${[...new Set(page.filled.map(f => f.form))]}`);
  assert.ok(page.clicked.length > 0 && page.clicked.every(c => c.form === 1), 'and that same form\'s own submit control is what gets clicked');
  assert.equal(page.forms[0].submitted, false, 'the newsletter form is never submitted');
});

test('BRK-1: a form with no submit control in it is an error (the click never happened)', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ hasSubmit: false })],
  });
  const result = await run(page);
  assert.ok(page.filled.length > 0, 'precondition: the form was filled');
  assert.deepEqual(page.clicked, []);
  assert.equal(result.status, 'error');
  assert.match(result.detail, /submit/i);
});

test('BRK-1: a submit click that throws is an error, not a success', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ clickThrows: 'Timeout 5000ms exceeded' })],
  });
  const result = await run(page);
  assert.equal(result.status, 'error');
  assert.match(result.detail, /submit|click|timeout/i);
});

test('BRK-1: dry-run still stops before anything is typed or clicked', async () => {
  const page = makeFakePage({ forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })] });
  const result = await gr.processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON });
  assert.equal(result.status, 'skipped');
  assert.deepEqual(page.filled, []);
  assert.deepEqual(page.clicked, []);
});

// ── Strategy 1 (Do Not Sell) and Strategy 2 (privacy manager) ────────────────

function dnsPage({ forms = [], clickBody, body = 'Welcome\nPrivacy' } = {}) {
  return makeFakePage({
    body,
    forms,
    pageScope: false,
    pageSelectors: (sel) => sel.includes('Do Not Sell'),
    onPageClick: (sel, page) => { if (clickBody) page.body = clickBody; },
  });
}

test('BRK-1: Do Not Sell that opens a form which is submitted with success text is a success', async () => {
  const page = dnsPage({
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'success');
  assert.ok(page.clicked.some(c => c.sel.includes('Do Not Sell')));
});

test('BRK-1: Do Not Sell then a submitted form with no evidence is unverified, not success', async () => {
  const page = dnsPage({ forms: [optOutForm({ afterSubmit: {} })] });
  const result = await run(page);
  assert.equal(result.status, 'unverified');
});

test('BRK-1: Do Not Sell with no form to submit stays manual (nothing was sent)', async () => {
  const page = dnsPage({ forms: [] });
  const result = await run(page);
  assert.equal(result.status, 'manual');
  assert.match(result.detail, /Do Not Sell/i);
});

test('BRK-1: Do Not Sell that reveals a confirmation-email message is pending_confirm', async () => {
  const page = dnsPage({ forms: [], clickBody: 'Welcome\nPrivacy\nWe have sent you an email to confirm your request' });
  const result = await run(page);
  assert.equal(result.status, 'pending_confirm');
});

test('BRK-1: a privacy manager click with no evidence is unverified, not success', async () => {
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '.save-preference-btn-handler',
  });
  const result = await run(page);
  assert.ok(page.clicked.some(c => c.sel === '.save-preference-btn-handler'), 'precondition: it was saved');
  assert.equal(result.status, 'unverified');
});

// ── runGenericBrokers: bookkeeping for the new outcome ───────────────────────

function runWith(outcome) {
  const calls = { success: [], pending: [], failure: [] };
  const logged = [];
  const config = require('../lib/config');
  const origFailure = config.recordFailure;
  const origPending = config.recordPendingConfirmation;
  config.recordFailure = (key, kind) => calls.failure.push({ key, kind });
  config.recordPendingConfirmation = (key) => calls.pending.push(key);
  return gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} },
    (name, status, detail) => logged.push({ name, status, detail }),
    (key) => calls.success.push(key),
    {
      injectedBrokers: [{ name: 'B', url: 'https://b.example/x', source: 'test' }],
      injectedProcessFn: async () => outcome,
    },
  ).then((result) => {
    config.recordFailure = origFailure;
    config.recordPendingConfirmation = origPending;
    return { result, calls, logged };
  });
}

test('unverified: never calls recordSuccess, is logged as unverified, and is not counted as submitted', async () => {
  const { result, calls, logged } = await runWith({ status: 'unverified', detail: 'no explicit confirmation - re-check next run' });
  assert.deepEqual(calls.success, [], 'no recordSuccess means no 90-day cooldown');
  assert.deepEqual(calls.failure, [], 'and it is not a failure either');
  assert.equal(logged[0].status, 'unverified');
  assert.equal(result.genericStats.submitted, 0, 'not a submitted success in the summary');
  assert.equal(result.genericStats.unverified, 1, 'it has its own bucket');
  assert.equal(result.genericStats.attempted, 1);
});

test('classifyOutcome maps unverified to its own bucket, never to submitted', () => {
  assert.equal(gr.classifyOutcome('unverified', ''), 'unverified');
  assert.notEqual(gr.classifyOutcome('unverified', ''), 'submitted');
});

test('success still records and counts as submitted (happy path unchanged)', async () => {
  const { result, calls } = await runWith({ status: 'success', detail: 'received' });
  assert.equal(calls.success.length, 1);
  assert.equal(result.genericStats.submitted, 1);
});
