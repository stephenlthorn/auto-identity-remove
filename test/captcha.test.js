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

// ── Fix 5: pollCapSolver + isPlaceholderKey ───────────────────────────────────

test('Fix5: isPlaceholderKey returns true for CAP-YOUR_ prefix', () => {
  const { isPlaceholderKey } = require('../lib/captcha');
  assert.equal(isPlaceholderKey('CAP-YOUR_KEY_HERE'), true);
  assert.equal(isPlaceholderKey('CAP-YOUR_anything'), true);
  assert.equal(isPlaceholderKey('CAP-REAL_KEY_123'), false);
  assert.equal(isPlaceholderKey(''), false);
  assert.equal(isPlaceholderKey(null), false);
  assert.equal(isPlaceholderKey(undefined), false);
});

test('Fix5: isPlaceholderKey returns true when key starts with CAP-YOUR', () => {
  const { isPlaceholderKey } = require('../lib/captcha');
  assert.equal(isPlaceholderKey('CAP-YOUR'), true);
});

test('Fix5: pollCapSolver resolves with solution when status becomes ready', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  let callCount = 0;
  const fakeAxios = {
    post: async (url, body) => {
      callCount++;
      // First call: still processing; second call: ready
      if (callCount === 1) return { data: { status: 'processing' } };
      return { data: { status: 'ready', solution: { gRecaptchaResponse: 'tok123' } } };
    },
  };

  const result = await pollCapSolver('task-abc', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 10,
    axios: fakeAxios,
  });

  assert.ok(result !== null, 'should return solution');
  assert.equal(result.gRecaptchaResponse, 'tok123');
});

test('Fix5: pollCapSolver returns null when status is failed', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  const fakeAxios = {
    post: async () => ({ data: { status: 'failed' } }),
  };

  const result = await pollCapSolver('task-fail', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 5,
    axios: fakeAxios,
  });

  assert.equal(result, null, 'failed task should return null');
});

test('Fix5: pollCapSolver returns null after maxTries without ready', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  const fakeAxios = {
    post: async () => ({ data: { status: 'processing' } }),
  };

  const result = await pollCapSolver('task-timeout', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 3,
    axios: fakeAxios,
  });

  assert.equal(result, null, 'should timeout and return null after maxTries');
});

// ── end Fix 5 ─────────────────────────────────────────────────────────────────
