/**
 * test/broker-runner-filled-form.test.js
 *
 * BRK-5 ("better still"): a page can hold several forms - a newsletter box, a
 * site search, the opt-out form. Scoping the submit selector to "any form" still
 * clicks the FIRST form's button. The runner therefore finds the <form> that
 * holds a field it filled and looks for the submit control inside it, and only
 * then falls back to the scoped selector list.
 *
 * Models Playwright's locator chaining (locator.locator(...)) over two forms.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makeContext, PERSON } = require('./broker-runner-harness');

const BROKER = {
  name: 'TwoFormSite',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"],input[type="submit"]',
  formFields: { 'input[name="email"]': 'x@example.com' },
};

/**
 * Two forms in document order: a newsletter form first, the opt-out form second.
 * Both have a visible submit button; only the opt-out form's field is "filled"
 * (the field selector is unique to it).
 */
function makeTwoFormPage() {
  const page = { clicks: [], submitted: false };
  const submitIn = (formId) => ({
    first: () => ({
      async count() { return 1; },
      async isVisible() { return true; },
      async click() { page.clicks.push(formId); if (formId === 'optout-form') page.submitted = true; },
    }),
  });
  const formLocator = (formId) => ({
    first: () => ({
      async count() { return 1; },
      locator: () => submitIn(formId),
    }),
  });
  page.goto = async () => ({});
  page.locator = (selector) => {
    if (selector === 'input[name="email"]') {
      return { first: () => ({
        async count() { return 1; },
        async isVisible() { return true; },
        locator: (rel) => {
          assert.match(rel, /ancestor::form/, 'the field is walked up to its <form>');
          return formLocator('optout-form');
        },
      }) };
    }
    // any page-level or "form ..." selector resolves to the FIRST form's button
    return submitIn('newsletter-form');
  };
  page.evaluate = async (fn) => (String(fn).includes('innerText')
    ? (page.submitted ? 'Opt out\nYour request has been received.' : 'Opt out')
    : '');
  page.close = async () => {};
  return page;
}

test('BRK-5: the submit control is searched inside the form that holds the filled field', async () => {
  const h = loadRunner();
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makeTwoFormPage();

  await h.runner.processBrokerWithPerson(makeContext(page), BROKER, PERSON);

  assert.deepEqual(page.clicks, ['optout-form'], 'must not click the newsletter form');
  assert.deepEqual(h.logged.map(l => l.status), ['success']);
});

test('BRK-5: without a usable filled field it falls back to the scoped selector list', async () => {
  const h = loadRunner();
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makeTwoFormPage();
  const noFields = { ...BROKER, formFields: {} };

  await h.runner.processBrokerWithPerson(makeContext(page), noFields, PERSON);

  assert.deepEqual(page.clicks, ['newsletter-form'], 'the fallback is the documented first-form behaviour');
});
