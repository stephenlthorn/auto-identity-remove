const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findRecaptchaCallback, buildHcaptchaScript } = require('../lib/captcha');

test('findRecaptchaCallback: returns a string containing the token', () => {
  const script = findRecaptchaCallback('TEST_TOKEN_123');
  assert.ok(typeof script === 'string' && script.length > 0);
  assert.ok(script.includes('TEST_TOKEN_123'));
});
test('findRecaptchaCallback: includes ___grecaptcha_cfg traversal', () => {
  assert.ok(findRecaptchaCallback('X').includes('___grecaptcha_cfg'));
});
test('findRecaptchaCallback: includes g-recaptcha-response input injection', () => {
  assert.ok(findRecaptchaCallback('X').includes('g-recaptcha-response'));
});
test('buildHcaptchaScript: returns a string containing the token', () => {
  const script = buildHcaptchaScript('HTOKEN_ABC');
  assert.ok(typeof script === 'string');
  assert.ok(script.includes('HTOKEN_ABC'));
});
test('buildHcaptchaScript: includes h-captcha-response', () => {
  assert.ok(buildHcaptchaScript('X').includes('h-captcha-response'));
});

// ── M5: sitekey extraction + hCaptcha no-execute ──────────────────────────────

test('M5: buildHcaptchaScript does NOT call hcaptcha.execute()', () => {
  const script = buildHcaptchaScript('HTOKEN');
  assert.ok(
    !script.includes('.execute('),
    'buildHcaptchaScript must not call hcaptcha.execute() - it can re-trigger interactive challenge'
  );
});

test('M5: solveRecaptcha page.evaluate script prefers form [data-sitekey] over page-level', async () => {
  // We test the sitekey extraction by verifying the source of solveRecaptcha
  // uses 'form [data-sitekey]' preference logic. Since we cannot run real Playwright,
  // we check that the evaluated string passed to page.evaluate contains the preference.
  const { solveRecaptcha } = require('../lib/captcha');
  let capturedEval = null;
  const fakePage = {
    url: () => 'https://example.com',
    evaluate: async (fnOrStr) => {
      capturedEval = fnOrStr.toString();
      return null; // no sitekey -> bail out early
    },
  };
  const fakeCapsolver = { apiKey: 'CAP-TESTKEY12345678' };
  await solveRecaptcha(fakePage, fakeCapsolver);
  assert.ok(capturedEval !== null, 'evaluate should have been called');
  assert.ok(
    capturedEval.includes('form') && capturedEval.includes('data-sitekey'),
    `evaluate script should prefer form [data-sitekey], got: ${capturedEval}`
  );
});

test('M5: solveHcaptcha page.evaluate script prefers form [data-sitekey] over page-level', async () => {
  const { solveHcaptcha } = require('../lib/captcha');
  let capturedEval = null;
  const fakePage = {
    url: () => 'https://example.com',
    evaluate: async (fnOrStr) => {
      capturedEval = fnOrStr.toString();
      return null;
    },
  };
  const fakeCapsolver = { apiKey: 'CAP-TESTKEY12345678' };
  await solveHcaptcha(fakePage, fakeCapsolver);
  assert.ok(capturedEval !== null, 'evaluate should have been called');
  assert.ok(
    capturedEval.includes('form') && capturedEval.includes('data-sitekey'),
    `evaluate script should prefer form [data-sitekey], got: ${capturedEval}`
  );
});

// ── end M5 ────────────────────────────────────────────────────────────────────
