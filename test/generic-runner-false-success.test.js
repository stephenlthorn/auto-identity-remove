/**
 * test/generic-runner-false-success.test.js
 *
 * processGenericUrl() used to return status 'success' when it filled a generic
 * opt-out form but could not find any submit control:
 *
 *     if (filled) {
 *       const submitted = await submitForm(page);
 *       if (submitted) return finalize('Form submitted');
 *       return { status: 'success', detail: 'Form filled (no submit button found)' };
 *     }
 *
 * runGenericBrokers() maps 'success' to recordSuccess(), which stamps
 * lastSuccess and puts the broker into the RECHECK_DAYS (90 day) cooldown. So a
 * form that was typed into but never submitted was reported to the user as a
 * completed opt-out and then not retried for three months. For a tool whose
 * entire output is "here is what was removed", claiming a removal that never
 * happened is the worst failure mode available.
 *
 * Correct classification is "not a success". It was 'manual' (a human has to
 * finish it); under the cross-package outcome vocabulary a click that never
 * happened is 'error'. runGenericBrokers calls recordSuccess for neither, so the
 * entry stays due.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  processGenericUrl,
  classifyOutcome,
  _setConfig,
} = require('../generic-runner');
const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

// Update (BRK-1 / codex #4): the generic runner now fills and clicks inside ONE
// <form> and judges the click from the text that appeared afterwards. The old
// expectations in this file that treated "a submit was clicked" as success, or
// that reported "filled but no submit control" as 'manual', changed on purpose:
//   - a click with no success wording is 'unverified' (see generic-evidence.test.js)
//   - a form whose submit never got clicked is 'error' (the cross-package contract:
//     "a click that never happened is 'error'"); either way it is not a success
//     and never reaches recordSuccess().

const SUCCESS_TEXT = 'Your request has been received.';

/**
 * @param {{ hasSubmit: boolean, afterSubmit?: object }} opts
 */
function makeStubPage({ hasSubmit, afterSubmit = { body: SUCCESS_TEXT } }) {
  return makeFakePage({
    body: 'Opt out',
    forms: [optOutForm({ hasSubmit, afterSubmit })],
  });
}

const BROKER = { name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'markup' };

function freshState() {
  return { optOuts: {} };
}

test.before(() => {
  // No allowlist, a single person: enough for getFieldMap() and isAllowlisted().
  _setConfig({
    person: {
      firstName: 'Test', lastName: 'User', fullName: 'Test User',
      email: 'test@example.com', state: 'CA', zip: '90001',
    },
  });
});

test('filled form with no submit control is NOT reported as success', async () => {
  const page = makeStubPage({ hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.ok(page.filled.length > 0, 'precondition: the stub must let the form be filled');
  assert.notEqual(
    result.status,
    'success',
    'nothing was submitted, so this must not be recorded as a successful opt-out',
  );
});

test('filled form with no submit control is an error that says why', async () => {
  const page = makeStubPage({ hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.equal(result.status, 'error');
  assert.match(result.detail, /submit/i, 'detail should say why it needs a human');
});

test('error and manual never land in the submitted bucket', () => {
  assert.equal(classifyOutcome('manual', ''), 'no_form_found');
  assert.notEqual(classifyOutcome('manual', ''), 'submitted');
  assert.equal(classifyOutcome('error', ''), 'error');
});

test('a form that IS submitted and shows success wording still reports success', async () => {
  const page = makeStubPage({ hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.equal(result.status, 'success', 'the happy path must not regress');
  assert.ok(page.clicked.some(c => c.sel.includes('button[type="submit"]')), 'submit must have been clicked');
});

test('a form that IS submitted but shows nothing conclusive is unverified, not success', async () => {
  const page = makeStubPage({ hasSubmit: true, afterSubmit: {} });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.ok(page.clicked.length > 0, 'precondition: it was clicked');
  assert.equal(result.status, 'unverified');
});

test('dry-run still short-circuits before any mutation', async () => {
  const page = makeStubPage({ hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), true, new Set());

  assert.equal(result.status, 'skipped');
  assert.equal(page.filled.length, 0, 'dry-run must not type PII into the form');
  assert.equal(page.clicked.length, 0, 'dry-run must not click anything');
});

// ── Second false-success path, found by the cross-model review of this diff ───
//
// Strategy 1 clicks a "Do Not Sell" link, then fires fillGenericForm() and
// submitForm() but ignores both return values and unconditionally reports
// success:
//
//     const clicked = await clickDoNotSell(page);
//     if (clicked) {
//       await fillGenericForm(page);
//       await submitForm(page);
//       return finalize('Do Not Sell clicked');
//     }
//
// Very often that link only opens a modal or a follow-up page. Clicking a link
// is not an opt-out, but it earned a recordSuccess() and a 90-day cooldown all
// the same. Same defect class as the "filled but no submit control" case above,
// which is exactly why one fix should not have been made without checking for
// the other.

/** A page where the Do Not Sell link exists and, optionally, so does an opt-out form. */
function makeDoNotSellPage({ hasForm, hasSubmit, afterSubmit = { body: SUCCESS_TEXT } }) {
  return makeFakePage({
    body: 'preferences',
    url: 'https://broker.example/privacy',
    pageScope: false,
    pageSelectors: (sel) => ['Do Not Sell', 'Do Not Share', 'Opt Out of Sale', 'donotsell', 'do-not-sell', 'optanon'].some(t => sel.includes(t)),
    forms: hasForm ? [optOutForm({ hasSubmit, afterSubmit })] : [],
  });
}

test('clicking Do Not Sell with no submittable form is not a success', async () => {
  const page = makeDoNotSellPage({ hasForm: false, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.ok(page.clicked.length > 0, 'precondition: the Do Not Sell control must have been clicked');
  assert.notEqual(
    result.status,
    'success',
    'a click that submitted nothing must not be recorded as a completed opt-out',
  );
  assert.equal(result.status, 'manual');
});

test('clicking Do Not Sell then filling a form with no submit control is not a success', async () => {
  const page = makeDoNotSellPage({ hasForm: true, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.notEqual(result.status, 'success');
  assert.equal(result.status, 'error');
});

test('clicking Do Not Sell and actually submitting the follow-up form IS a success', async () => {
  const page = makeDoNotSellPage({ hasForm: true, hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.equal(result.status, 'success', 'the genuine happy path must not regress');
  assert.ok(page.clicked.some(c => c.sel.includes('button[type="submit"]')));
});

test('the Do Not Sell detail says what actually happened', async () => {
  const page = makeDoNotSellPage({ hasForm: false, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.match(result.detail, /Do Not Sell/i, 'keep the diagnostic breadcrumb');
  assert.match(result.detail, /not|no /i, 'and say that nothing was submitted');
});
