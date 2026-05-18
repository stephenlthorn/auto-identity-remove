/**
 * test/forms-intl.test.js
 *
 * Unit tests for applyRegionAliases() — pure map transform, no Playwright.
 *
 * Covers:
 *   - US person: map returned unchanged (same reference)
 *   - non-US person: province/postal/postcode/country selectors added
 *   - missing country defaults to US behaviour
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyRegionAliases } = require('../lib/forms');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const US_PERSON  = { country: 'US',  state: 'TX',  zip: '73301' };
const CA_PERSON  = { country: 'CA',  state: 'ON',  zip: 'K1A 0A6' };
const GB_PERSON  = { country: 'GB',  state: 'ENG', zip: 'SW1A 1AA' };

const SAMPLE_FIELDS = {
  'input[name*="first" i]': 'Jane',
  'input[name*="last" i]':  'Doe',
  'input[name*="state" i]': 'TX',
  'input[name*="zip" i]':   '73301',
  'input[type="email"]':    'jane@example.com',
};

// ── Tests — US (fast path) ────────────────────────────────────────────────────

test('applyRegionAliases: US person returns the same object reference', () => {
  const result = applyRegionAliases(SAMPLE_FIELDS, US_PERSON);
  assert.strictEqual(result, SAMPLE_FIELDS, 'should return the identical object for US users');
});

test('applyRegionAliases: US person leaves no province/postal/country keys added', () => {
  const result = applyRegionAliases(SAMPLE_FIELDS, US_PERSON);
  const keys = Object.keys(result).join(' ');
  assert.ok(!keys.includes('province'), 'no province selector for US');
  assert.ok(!keys.includes('postcode'), 'no postcode selector for US');
  assert.ok(!keys.includes('country'),  'no country selector for US');
});

// ── Tests — missing/undefined country defaults to US ─────────────────────────

test('applyRegionAliases: undefined country treated as US (no augmentation)', () => {
  const result = applyRegionAliases(SAMPLE_FIELDS, { state: 'TX', zip: '73301' });
  assert.strictEqual(result, SAMPLE_FIELDS, 'no augmentation when country is absent');
});

// ── Tests — non-US: province aliases added ────────────────────────────────────

test('applyRegionAliases: CA person gets province selector for state value', () => {
  const fields = { 'input[name*="state" i]': 'ON', 'input[type="email"]': 'x@x.com' };
  const result = applyRegionAliases(fields, CA_PERSON);
  assert.notStrictEqual(result, fields, 'new object returned for non-US');
  const keys = Object.keys(result);
  const provinceKey = keys.find(k => k.includes('province'));
  assert.ok(provinceKey, 'province selector should be present');
  assert.equal(result[provinceKey], 'ON', 'province value matches state value');
});

test('applyRegionAliases: CA person gets postal/postcode selector for zip value', () => {
  const fields = { 'input[name*="zip" i]': 'K1A 0A6', 'input[type="email"]': 'x@x.com' };
  const result = applyRegionAliases(fields, CA_PERSON);
  const keys = Object.keys(result);
  const postalKey = keys.find(k => k.includes('postal') || k.includes('postcode'));
  assert.ok(postalKey, 'postal/postcode selector should be present');
  assert.equal(result[postalKey], 'K1A 0A6', 'postal value matches zip value');
});

test('applyRegionAliases: non-US person gets country select filled with country code', () => {
  const result = applyRegionAliases(SAMPLE_FIELDS, CA_PERSON);
  const countryKey = Object.keys(result).find(k => k.includes('country'));
  assert.ok(countryKey, 'country selector should be present');
  assert.equal(result[countryKey], 'CA', 'country value is the 2-letter code');
});

test('applyRegionAliases: GB person postal value is preserved verbatim (no formatting)', () => {
  const fields = { 'input[name*="zip" i]': 'SW1A 1AA', 'input[type="email"]': 'x@x.com' };
  const result = applyRegionAliases(fields, GB_PERSON);
  const keys = Object.keys(result);
  const postalKey = keys.find(k => k.includes('postal') || k.includes('postcode'));
  assert.ok(postalKey, 'postal selector should be present for GB');
  assert.equal(result[postalKey], 'SW1A 1AA', 'UK postcode preserved verbatim');
});

test('applyRegionAliases: existing keys in formFields are preserved unchanged', () => {
  const result = applyRegionAliases(SAMPLE_FIELDS, CA_PERSON);
  assert.equal(result['input[name*="first" i]'], 'Jane');
  assert.equal(result['input[name*="last" i]'],  'Doe');
  assert.equal(result['input[type="email"]'],    'jane@example.com');
});

test('applyRegionAliases: lower-case country is normalised to upper-case', () => {
  const fields = { 'input[name*="state" i]': 'ON' };
  const result = applyRegionAliases(fields, { country: 'ca', state: 'ON', zip: 'K1A 0A6' });
  const countryKey = Object.keys(result).find(k => k.includes('country'));
  assert.ok(countryKey, 'country selector present');
  assert.equal(result[countryKey], 'CA', 'country code should be upper-cased');
});
