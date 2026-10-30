/**
 * test/broker-runner-captcha-gating.test.js
 *
 * BRK-13 (runner part): --dry-run and --preview called the paid CapSolver before
 * returning, and detectAndSolveCaptcha was called without the broker so
 * broker.recaptchaV3Action never reached the solver.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');

const CAPTCHA_BROKER = {
  name: 'CaptchaSite',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
  captchaLikely: true,
  recaptchaV3Action: 'optout',
};

async function run(config) {
  const h = loadRunner();
  h.runner.configure({ person: PERSON, personCount: 1, capsolver: { apiKey: 'CAP-TESTKEY' }, ...config });
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });
  await h.runner.processBrokerWithPerson(makeContext(page), CAPTCHA_BROKER, PERSON);
  return h;
}

test('BRK-13: --dry-run does not spend CapSolver credit', async () => {
  const h = await run({ dryRun: true });
  assert.equal(h.calls.captcha.length, 0);
  assert.equal(h.logged.at(-1).status, 'skipped');
});

test('BRK-13: --preview does not spend CapSolver credit', async () => {
  const h = await run({ dryRun: true, preview: true });
  assert.equal(h.calls.captcha.length, 0);
  assert.equal(h.logged.at(-1).status, 'preview');
});

test('BRK-13: preview without dryRun set is also free', async () => {
  const h = await run({ dryRun: false, preview: true });
  assert.equal(h.calls.captcha.length, 0);
});

test('BRK-13: a real run solves with the broker so recaptchaV3Action reaches the solver', async () => {
  const h = await run({ dryRun: false });
  assert.equal(h.calls.captcha.length, 1);
  assert.equal(h.calls.captcha[0].broker.recaptchaV3Action, 'optout');
  assert.deepEqual(h.calls.captcha[0].capsolver, { apiKey: 'CAP-TESTKEY' });
});
