/**
 * test/captcha-coverage.test.js
 *
 * Unit tests for new CAPTCHA builder functions added in HIGH-3.
 * Pure unit tests - no Playwright required.
 *
 * Covers:
 *   - buildTurnstileScript(token)
 *   - buildRecaptchaV3Script(token)
 *   - buildAwsWafScript(token)
 *   - Quote-injection safety for all builders
 *   - Purity (same input -> same output)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTurnstileScript,
  buildRecaptchaV3Script,
  buildAwsWafScript,
} = require('../lib/captcha');

// ── buildTurnstileScript ───────────────────────────────────────────────────────

test('buildTurnstileScript: returns a string', () => {
  const script = buildTurnstileScript('TOK_123');
  assert.ok(typeof script === 'string' && script.length > 0);
});

test('buildTurnstileScript: contains the token value', () => {
  const script = buildTurnstileScript('TOK_TURNSTILE_ABC');
  assert.ok(script.includes('TOK_TURNSTILE_ABC'));
});

test('buildTurnstileScript: targets cf-turnstile-response field', () => {
  const script = buildTurnstileScript('X');
  assert.ok(script.includes('cf-turnstile-response'));
});

test('buildTurnstileScript: fires a change event', () => {
  const script = buildTurnstileScript('X');
  assert.ok(script.includes('change'));
});

test('buildTurnstileScript: is pure - same input produces same output', () => {
  assert.equal(buildTurnstileScript('ABC'), buildTurnstileScript('ABC'));
});

test('buildTurnstileScript: quote-injection safety - token double-quotes are escaped', () => {
  // JSON.stringify must escape the double-quote so it cannot break out of the JS string literal.
  // The IIFE call at the end of the script must contain \"tok\\\"en\" (escaped), NOT "tok"en" (raw).
  const withQuote = 'tok"en';
  const script = buildTurnstileScript(withQuote);
  // Unescaped form would be: ("tok"en") - a literal unescaped quote mid-token breaks the string
  assert.ok(!script.includes('("tok"en")'), 'unescaped token in call site must not appear');
  // The escaped form must be present: the backslash-escaped quote inside the JSON string
  assert.ok(script.includes('tok\\"en'), 'backslash-escaped quote must appear in call site');
});

// ── buildRecaptchaV3Script ─────────────────────────────────────────────────────

test('buildRecaptchaV3Script: returns a string', () => {
  const script = buildRecaptchaV3Script('TOK_V3_456');
  assert.ok(typeof script === 'string' && script.length > 0);
});

test('buildRecaptchaV3Script: contains the token value', () => {
  const script = buildRecaptchaV3Script('TOK_V3_456');
  assert.ok(script.includes('TOK_V3_456'));
});

test('buildRecaptchaV3Script: targets g-recaptcha-response field', () => {
  const script = buildRecaptchaV3Script('X');
  assert.ok(script.includes('g-recaptcha-response'));
});

test('buildRecaptchaV3Script: traverses ___grecaptcha_cfg callbacks', () => {
  const script = buildRecaptchaV3Script('X');
  assert.ok(script.includes('___grecaptcha_cfg'));
});

test('buildRecaptchaV3Script: is pure - same input produces same output', () => {
  assert.equal(buildRecaptchaV3Script('ZZZ'), buildRecaptchaV3Script('ZZZ'));
});

test('buildRecaptchaV3Script: quote-injection safety - token double-quotes are escaped', () => {
  const withQuote = 'tok"en';
  const script = buildRecaptchaV3Script(withQuote);
  assert.ok(!script.includes('("tok"en")'), 'unescaped token in call site must not appear');
  assert.ok(script.includes('tok\\"en'), 'backslash-escaped quote must appear in call site');
});

// ── buildAwsWafScript ──────────────────────────────────────────────────────────

test('buildAwsWafScript: returns a string', () => {
  const script = buildAwsWafScript('TOK_AWS_789');
  assert.ok(typeof script === 'string' && script.length > 0);
});

test('buildAwsWafScript: contains the token value', () => {
  const script = buildAwsWafScript('TOK_AWS_789');
  assert.ok(script.includes('TOK_AWS_789'));
});

test('buildAwsWafScript: is pure - same input produces same output', () => {
  assert.equal(buildAwsWafScript('QQQ'), buildAwsWafScript('QQQ'));
});

test('buildAwsWafScript: quote-injection safety - token double-quotes are escaped', () => {
  const withQuote = 'tok"en';
  const script = buildAwsWafScript(withQuote);
  assert.ok(!script.includes('("tok"en")'), 'unescaped token in call site must not appear');
  assert.ok(script.includes('tok\\"en'), 'backslash-escaped quote must appear in call site');
});
