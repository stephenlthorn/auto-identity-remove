/**
 * test/forms-intl-postal.test.js
 *
 * WP6 — Non-US postal code handling.
 *
 * Verifies that applyRegionAliases():
 *   1. Does NOT strip spaces or letters from non-numeric postal codes.
 *   2. Adds a postcode/postal selector for AU, CA, GB, IE, NZ.
 *   3. Preserves the verbatim postal-code value from formFields.
 *
 * Also verifies that normalizePhone():
 *   - For US/CA, applies (xxx) xxx-xxxx formatting.
 *   - For non-US countries, passes the value through unchanged.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyRegionAliases } = require('../lib/forms');
const { normalizePhone }     = require('../lib/config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal formFields map for a person whose zip is `postalCode`.
 */
function fieldsForPostal(postalCode) {
  return {
    'input[name*="zip" i]': postalCode,
    'input[type="email"]':  'test@example.com',
  };
}

/**
 * Return the postcode/postal selector key added by applyRegionAliases, or null.
 */
function findPostcodeKey(result) {
  return Object.keys(result).find(k => k.includes('postal') || k.includes('postcode')) ?? null;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const POSTAL_CASES = [
  { country: 'CA', postal: 'K1A 0A6',  label: 'Canadian postal code with space' },
  { country: 'GB', postal: 'SW1A 1AA', label: 'UK postcode with space and letters' },
  { country: 'AU', postal: '2000',     label: 'Australian numeric postcode' },
  { country: 'IE', postal: 'D02 H1A0', label: 'Irish Eircode with space' },
  { country: 'NZ', postal: '6011',     label: 'New Zealand numeric postcode' },
];

// ── Tests — postcode selector is present for each country ─────────────────────

for (const { country, postal, label } of POSTAL_CASES) {
  test(`applyRegionAliases: ${label} — postcode selector added`, () => {
    const person = { country, zip: postal };
    const result = applyRegionAliases(fieldsForPostal(postal), person);
    const key = findPostcodeKey(result);
    assert.ok(key !== null, `expected a postal/postcode selector key for country ${country}`);
  });
}

// ── Tests — postal-code value preserved verbatim ──────────────────────────────

for (const { country, postal, label } of POSTAL_CASES) {
  test(`applyRegionAliases: ${label} — value preserved verbatim`, () => {
    const person = { country, zip: postal };
    const result = applyRegionAliases(fieldsForPostal(postal), person);
    const key = findPostcodeKey(result);
    assert.ok(key !== null, `postcode selector must be present for country ${country}`);
    assert.strictEqual(
      result[key],
      postal,
      `postal code "${postal}" must not be altered (no digit-stripping, no space removal)`,
    );
  });
}

// ── Tests — digit-preservation invariant ─────────────────────────────────────

test('applyRegionAliases: spaces in postal codes are NOT stripped', () => {
  const person = { country: 'CA', zip: 'K1A 0A6' };
  const result = applyRegionAliases(fieldsForPostal('K1A 0A6'), person);
  const key = findPostcodeKey(result);
  assert.ok(key, 'postcode key present');
  assert.ok(result[key].includes(' '), 'space must be preserved in CA postal code');
});

test('applyRegionAliases: letters in postal codes are NOT stripped', () => {
  const person = { country: 'GB', zip: 'SW1A 1AA' };
  const result = applyRegionAliases(fieldsForPostal('SW1A 1AA'), person);
  const key = findPostcodeKey(result);
  assert.ok(key, 'postcode key present');
  assert.match(result[key], /[A-Z]/i, 'letters must be preserved in GB postcode');
});

test('applyRegionAliases: numeric AU postcode preserved as string (no leading-zero strip)', () => {
  const person = { country: 'AU', zip: '0800' };
  const result = applyRegionAliases(fieldsForPostal('0800'), person);
  const key = findPostcodeKey(result);
  assert.ok(key, 'postcode key present');
  assert.strictEqual(result[key], '0800', 'leading zero must be preserved');
});

// ── Tests — US default behavior unchanged ─────────────────────────────────────

test('applyRegionAliases: US person is unaffected (same reference)', () => {
  const fields = fieldsForPostal('73301');
  const result = applyRegionAliases(fields, { country: 'US', zip: '73301' });
  assert.strictEqual(result, fields, 'US users must get the exact same object back');
});

test('applyRegionAliases: US zip value is preserved unchanged', () => {
  const fields = fieldsForPostal('10001');
  const result = applyRegionAliases(fields, { country: 'US', zip: '10001' });
  assert.strictEqual(result['input[name*="zip" i]'], '10001');
});

// ── Tests — normalizePhone ────────────────────────────────────────────────────

test('normalizePhone: US 10-digit number formatted as (xxx) xxx-xxxx', () => {
  const formatted = normalizePhone('6045551234', 'US');
  assert.strictEqual(formatted, '(604) 555-1234');
});

test('normalizePhone: US number already formatted is returned as-is', () => {
  const formatted = normalizePhone('(604) 555-1234', 'US');
  assert.strictEqual(formatted, '(604) 555-1234');
});

test('normalizePhone: CA 10-digit number formatted as (xxx) xxx-xxxx', () => {
  // Canada uses NANP — same format as US
  const formatted = normalizePhone('6135551234', 'CA');
  assert.strictEqual(formatted, '(613) 555-1234');
});

test('normalizePhone: GB number passes through unchanged (no US formatting applied)', () => {
  const raw = '+44 20 7946 0958';
  const formatted = normalizePhone(raw, 'GB');
  assert.strictEqual(formatted, raw, 'non-US phone must pass through verbatim');
});

test('normalizePhone: AU number passes through unchanged', () => {
  const raw = '+61 2 9876 5432';
  assert.strictEqual(normalizePhone(raw, 'AU'), raw);
});

test('normalizePhone: IE number passes through unchanged', () => {
  const raw = '+353 1 234 5678';
  assert.strictEqual(normalizePhone(raw, 'IE'), raw);
});

test('normalizePhone: NZ number passes through unchanged', () => {
  const raw = '+64 9 123 4567';
  assert.strictEqual(normalizePhone(raw, 'NZ'), raw);
});

test('normalizePhone: undefined country treated as US', () => {
  const formatted = normalizePhone('6045551234', undefined);
  assert.strictEqual(formatted, '(604) 555-1234');
});

test('normalizePhone: null/empty phone returns empty string for any country', () => {
  assert.strictEqual(normalizePhone('', 'GB'), '');
  assert.strictEqual(normalizePhone(null, 'US'), '');
});
