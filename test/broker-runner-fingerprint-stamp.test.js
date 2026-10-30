/**
 * test/broker-runner-fingerprint-stamp.test.js
 *
 * R5: a state entry is stamped with a fingerprint of the person it was written
 * for (name, zip, email, phone), and an entry whose stamp differs from the current
 * person counts as never run. The stamp is only written when the caller hands the
 * writer `{ person }`; the broker runner did not, so entries from a run that
 * changed nothing but the zip carried no stamp and a corrected address never
 * invalidated them. Every state write on the explicit path now passes the person
 * it submitted for.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON, SUBMIT_BROKER } = require('./broker-runner-harness');

const stampOf = (h, writer) => h.recorded.stamps.find(s => s.writer === writer);

const SUBMIT_BTN = { id: 'optout', matches: ['button[type="submit"]'], inForm: true, submits: true };

function setup(pageSpec, broker = SUBMIT_BROKER, stubs = {}) {
  const h = loadRunner(stubs);
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage(pageSpec);
  return { ...h, page, run: () => h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON) };
}

test('a success is stamped with the person it was submitted for', async () => {
  const h = setup({ elements: [SUBMIT_BTN], before: 'Opt out of this site', after: 'Your request has been received and will be processed.' });
  await h.run();
  assert.equal(h.recorded.success.length, 1, h.logged.map(l => `${l.status}: ${l.detail}`).join('\n'));
  assert.equal(stampOf(h, 'success').opts.person, PERSON);
});

test('a failure after a click is stamped too', async () => {
  const h = setup({ elements: [SUBMIT_BTN], before: 'Opt out of this site', after: 'Error: please enter a valid email address.' });
  await h.run();
  assert.equal(h.recorded.failure.length, 1, h.logged.map(l => `${l.status}: ${l.detail}`).join('\n'));
  assert.equal(stampOf(h, 'failure').opts.person, PERSON);
});

test('an unreachable opt-out URL records its failure with the person', async () => {
  const h = setup({ elements: [SUBMIT_BTN], status: 503 });
  await h.run();
  assert.equal(h.recorded.failure.length, 1);
  assert.equal(h.recorded.failure[0].kind, 'error');
  assert.equal(stampOf(h, 'failure').opts.person, PERSON);
});

test('a confirmation-pending submission is stamped', async () => {
  const h = setup(
    { elements: [SUBMIT_BTN], before: 'Opt out of this site', after: 'Check your email and click the confirmation link to finish.' },
    SUBMIT_BROKER,
  );
  await h.run();
  assert.equal(h.recorded.pending.length, 1, h.logged.map(l => `${l.status}: ${l.detail}`).join('\n'));
  assert.equal(stampOf(h, 'pending').opts.person, PERSON);
});

test('a CAPTCHA that nobody solved records its failure with the person', async () => {
  const h = setup(
    { elements: [SUBMIT_BTN] },
    { ...SUBMIT_BROKER, captchaLikely: true },
    { './captcha': { detectAndSolveCaptcha: async () => false } },
  );
  await h.run();
  const captcha = h.recorded.stamps.find(s => s.writer === 'failure' && s.kind === 'captcha_failed');
  assert.ok(captcha, `a captcha_failed result must record a failure: ${h.logged.map(l => l.status).join(',')}`);
  assert.equal(captcha.opts.person, PERSON);
});

test('fake-person noise submissions record nothing, so there is nothing to stamp', async () => {
  const h = loadRunner();
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage({ elements: [SUBMIT_BTN], before: 'Opt out of this site', after: 'Your request has been received.' });
  const noiseBroker = { ...SUBMIT_BROKER, acceptsBogus: true };
  await h.runner.processBrokerWithPerson(makeContext(page), noiseBroker, { ...PERSON, isBogus: true }, { noState: true });
  assert.equal(h.recorded.success.length + h.recorded.pending.length + h.recorded.failure.length, 0);
});
