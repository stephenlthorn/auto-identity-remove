/**
 * test/manual-captcha-solver-compat.test.js
 *
 * R1 split lib/captcha.js's detect-and-solve into reusable pieces (detectCaptchaType,
 * detectUnsupportedChallenge, solveCaptchaType) so lib/manual-captcha.js shares one
 * detection with the paid solver. detectAndSolveCaptcha must still behave exactly as
 * it did for every caller that has no use for a person at the keyboard.
 *
 * No key is ever set here, so no solver call can reach the network.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const captcha = require('../lib/captcha');
const { handleCaptcha } = require('../lib/manual-captcha');
const { makeCaptchaPage } = require('./manual-captcha-harness');

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

test('detectAndSolveCaptcha: a page with no CAPTCHA is true, as before', async () => {
  assert.equal(await quiet(() => captcha.detectAndSolveCaptcha(makeCaptchaPage({ type: null }), null)), true);
});

test('detectAndSolveCaptcha: a supported CAPTCHA with no key is false, as before', async () => {
  for (const type of ['recaptcha', 'recaptcha-v3', 'hcaptcha', 'turnstile', 'aws-waf']) {
    assert.equal(await quiet(() => captcha.detectAndSolveCaptcha(makeCaptchaPage({ type }), null)), false, type);
  }
});

test('detectAndSolveCaptcha: a detect-only challenge is false, as before', async () => {
  for (const unsupported of ['datadome', 'arkose', 'perimeterx', 'akamai']) {
    assert.equal(await quiet(() => captcha.detectAndSolveCaptcha(makeCaptchaPage({ unsupported }), null)), false, unsupported);
  }
});

test('detectAndSolveCaptcha: a solver-supported CAPTCHA wins over a detect-only script on the same page', async () => {
  const page = makeCaptchaPage({ type: 'turnstile', unsupported: 'akamai' });
  assert.equal(await quiet(() => captcha.detectAndSolveCaptcha(page, null)), false);
  assert.ok(!page.model.evaluations.includes('pageHasAkamai'), 'the detect-only probes only run when no solver type is found');
});

test('detectCaptchaType: a probe answer that is not a type name is no CAPTCHA', async () => {
  for (const junk of ['', [], {}, 0, undefined]) {
    assert.equal(await captcha.detectCaptchaType({ evaluate: async () => junk }), null);
  }
  assert.equal(await captcha.detectCaptchaType({ evaluate: async () => 'hcaptcha' }), 'hcaptcha');
});

test('detectUnsupportedChallenge: the first hit in DataDome, Arkose, PerimeterX, Akamai order, else null', async () => {
  assert.equal(await captcha.detectUnsupportedChallenge(makeCaptchaPage({ unsupported: 'arkose' })), 'arkose');
  assert.equal(await captcha.detectUnsupportedChallenge(makeCaptchaPage({})), null);
});

test('solveCaptchaType: a type the solver does not know is false and never touches the page', async () => {
  const page = makeCaptchaPage({});
  assert.equal(await captcha.solveCaptchaType(page, 'challenge-text', { apiKey: 'CAP-TESTKEY12345678' }), false);
  assert.equal(page.model.evaluations.length, 0);
});

test('SOLVER_TYPES is exactly what solveCaptchaType can dispatch', () => {
  assert.deepEqual([...captcha.SOLVER_TYPES].sort(), ['aws-waf', 'hcaptcha', 'recaptcha', 'recaptcha-v3', 'turnstile']);
});

test('handleCaptcha with nothing configured: a clean page is none, a CAPTCHA page is skipped, nobody is waited on', async () => {
  assert.equal(await handleCaptcha(makeCaptchaPage({ type: null })), 'none');
  assert.equal(await handleCaptcha(makeCaptchaPage({ type: 'recaptcha' })), 'skipped');
});
