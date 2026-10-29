/**
 * test/broker-runner-submit-click.test.js
 *
 * BRK-4: the post-submit classifier used to run whether or not anything was
 * clicked, and over the whole page body. A page that merely SAID "once your
 * request has been processed we will remove your listing" was logged `success`
 * and started the 90-day cooldown, so the user's data stayed online.
 *
 * BRK-5: `form ${submitSelector}` only scoped the first comma alternative, so a
 * header "Subscribe" input[type=submit] could be clicked instead of the opt-out
 * button.
 *
 * Both use the real lib/success.js and lib/confirm.js classifiers.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON, SUBMIT_BROKER } = require('./broker-runner-harness');

const SUBMIT_BTN = { id: 'optout', matches: ['button[type="submit"]'], inForm: true, submits: true };

function setup(pageSpec, broker = SUBMIT_BROKER) {
  const h = loadRunner();
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage(pageSpec);
  const run = () => h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON);
  return { ...h, page, run };
}

const statusOf = (h) => h.logged.map(l => l.status);

// ── BRK-4: nothing clicked ────────────────────────────────────────────────────

test('BRK-4: promise text on the page with no matching button is not logged success', async () => {
  const h = setup({
    elements: [],
    before: 'Once your request has been processed, we will remove your listing.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['error']);
  assert.match(h.logged[0].detail, /nothing was submitted/i);
  assert.equal(h.recorded.success.length, 0, 'must not start the 90-day cooldown');
  assert.equal(h.recorded.pending.length, 0);
  assert.equal(h.recorded.failure.length, 0, 'a click that never happened records no state at all');
});

test('BRK-4: "confirmation email" copy with no matching button is not pending_confirm', async () => {
  const h = setup({
    elements: [],
    before: 'We will send you a confirmation email after you submit this form.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['error']);
  assert.equal(h.recorded.pending.length, 0);
});

test('BRK-4: a matching but hidden button is not clicked and not success', async () => {
  const h = setup({
    elements: [{ ...SUBMIT_BTN, visible: false }],
    before: 'Your request has been received.',
  });
  await h.run();

  assert.equal(h.page.clicks.length, 0);
  assert.deepEqual(statusOf(h), ['error']);
  assert.equal(h.recorded.success.length, 0);
});

test('BRK-4: a broker with no submitSelector is unverified, never success', async () => {
  const { submitSelector, ...noSubmit } = SUBMIT_BROKER;
  const h = setup({ before: 'Your request has been received.' }, noSubmit);
  await h.run();

  assert.deepEqual(statusOf(h), ['unverified']);
  assert.equal(h.recorded.success.length, 0);
  assert.equal(h.recorded.pending.length, 0);
});

// ── BRK-4: clicked, classify only new text ────────────────────────────────────

test('BRK-4: a click that changes nothing is unverified even if the page promises removal', async () => {
  const same = 'Once your request has been received, we will remove your listing.';
  const h = setup({ elements: [SUBMIT_BTN], before: same, after: same });
  await h.run();

  assert.equal(h.page.clicks.length, 1);
  assert.deepEqual(statusOf(h), ['unverified']);
  assert.equal(h.recorded.success.length, 0);
});

test('BRK-4: success wording that appears AFTER the click is success', async () => {
  const h = setup({
    elements: [SUBMIT_BTN],
    before: 'Opt out of this site\nEnter your email',
    after: 'Opt out of this site\nEnter your email\nYour request has been received.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['success']);
  assert.equal(h.recorded.success.length, 1);
});

test('BRK-4: success wording that was already on the page before the click is not new evidence', async () => {
  const h = setup({
    elements: [SUBMIT_BTN],
    before: 'Your request has been received.\nEnter your email',
    after: 'Your request has been received.\nEnter your email\nPlease try again.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['error']);
  assert.equal(h.recorded.success.length, 0);
});

test('BRK-4: a validation error after the click is error and is not a network failure', async () => {
  const h = setup({
    elements: [SUBMIT_BTN],
    before: 'Opt out of this site',
    after: 'Opt out of this site\nThis field is required.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['error']);
  assert.equal(h.recorded.success.length, 0);
  assert.deepEqual(h.recorded.failure, [{ name: 'ClickTestBroker', kind: 'form_error' }]);
});

test('BRK-4: confirmation wording after the click is pending_confirm', async () => {
  const h = setup({
    elements: [SUBMIT_BTN],
    before: 'Opt out of this site',
    after: 'Opt out of this site\nPlease check your email to confirm your request.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['pending_confirm']);
  assert.equal(h.recorded.pending.length, 1);
  assert.equal(h.recorded.success.length, 0);
});

test('BRK-4: confirmation instructions that were already on the form do not make a success pending', async () => {
  const h = setup({
    elements: [SUBMIT_BTN],
    before: 'We will send you a confirmation email.\nEnter your email',
    after: 'We will send you a confirmation email.\nEnter your email\nYour request has been received.',
  });
  await h.run();

  assert.deepEqual(statusOf(h), ['success']);
  assert.equal(h.recorded.pending.length, 0);
});

// ── BRK-5: comma-separated submit selectors ───────────────────────────────────

const LIST = 'button[type="submit"],input[type="submit"]';

test('BRK-5: an out-of-form newsletter input does not win over the opt-out button', async () => {
  const h = setup(
    {
      elements: [
        { id: 'newsletter', matches: ['input[type="submit"]'], inForm: false, submits: false },
        { id: 'optout', matches: ['button[type="submit"]'], inForm: true, submits: true },
      ],
      before: 'Subscribe\nOpt out',
      after: 'Subscribe\nOpt out\nYour request has been received.',
    },
    { ...SUBMIT_BROKER, submitSelector: LIST },
  );
  await h.run();

  assert.deepEqual(h.page.clicks.map(c => c.id), ['optout']);
  assert.deepEqual(statusOf(h), ['success']);
});

test('BRK-5: the second alternative is also scoped to the form', async () => {
  const h = setup(
    {
      elements: [
        { id: 'header-subscribe', matches: ['button[type="submit"]'], inForm: false, submits: false },
        { id: 'optout', matches: ['input[type="submit"]'], inForm: true, submits: true },
      ],
      before: 'Subscribe\nOpt out',
      after: 'Subscribe\nOpt out\nYour request has been received.',
    },
    { ...SUBMIT_BROKER, submitSelector: LIST },
  );
  await h.run();

  assert.deepEqual(h.page.clicks.map(c => c.id), ['optout']);
});

test('BRK-5: falls back to the page-level selector when no form holds a match', async () => {
  const h = setup(
    {
      elements: [{ id: 'bare', matches: ['input[type="submit"]'], inForm: false, submits: true }],
      before: 'Opt out',
      after: 'Opt out\nYour request has been received.',
    },
    { ...SUBMIT_BROKER, submitSelector: LIST },
  );
  await h.run();

  assert.deepEqual(h.page.clicks.map(c => c.id), ['bare']);
});

test('BRK-5: scopeSelectorToForm only splits on top-level commas', () => {
  const { runner } = loadRunner();
  const { scopeSelectorToForm } = runner;

  assert.equal(scopeSelectorToForm('button'), 'form button');
  assert.equal(
    scopeSelectorToForm('button[type="submit"],input[type="submit"]'),
    'form button[type="submit"], form input[type="submit"]',
  );
  assert.equal(
    scopeSelectorToForm('button:is(.a, .b), input[value="Opt out, now"]'),
    'form button:is(.a, .b), form input[value="Opt out, now"]',
  );
  assert.equal(
    scopeSelectorToForm("a[title='x,y'] , #go"),
    "form a[title='x,y'], form #go",
  );
});
