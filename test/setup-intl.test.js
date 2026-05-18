/**
 * test/setup-intl.test.js
 *
 * Unit tests for the pure helper functions exported from setup.js:
 *   regionPrompts(country)  — returns correct label strings per country
 *   formatPhone(phone, country) — US 10-digit → (xxx) xxx-xxxx; non-US → raw
 *
 * No readline/stdin interaction is exercised here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// setup.js exports helpers at module level without starting main()
const { regionPrompts, formatPhone } = require('../setup');

// ── regionPrompts ─────────────────────────────────────────────────────────────

test('regionPrompts: US returns "State (2-letter)" and "ZIP code"', () => {
  const { regionLabel, postalLabel } = regionPrompts('US');
  assert.equal(regionLabel, 'State (2-letter)');
  assert.equal(postalLabel, 'ZIP code');
});

test('regionPrompts: CA returns province/region and postal labels', () => {
  const { regionLabel, postalLabel } = regionPrompts('CA');
  assert.ok(regionLabel.toLowerCase().includes('province') || regionLabel.toLowerCase().includes('region'),
    `expected province/region label, got "${regionLabel}"`);
  assert.ok(postalLabel.toLowerCase().includes('postal'),
    `expected postal label, got "${postalLabel}"`);
});

test('regionPrompts: GB returns province/region and postal labels', () => {
  const { regionLabel, postalLabel } = regionPrompts('GB');
  assert.ok(regionLabel.toLowerCase().includes('province') || regionLabel.toLowerCase().includes('region'),
    `expected province/region label for GB, got "${regionLabel}"`);
  assert.ok(postalLabel.toLowerCase().includes('postal'),
    `expected postal label for GB, got "${postalLabel}"`);
});

test('regionPrompts: AU returns province/region and postal labels', () => {
  const { regionLabel } = regionPrompts('AU');
  assert.ok(regionLabel.toLowerCase().includes('province') || regionLabel.toLowerCase().includes('region'),
    `expected province/region label for AU, got "${regionLabel}"`);
});

test('regionPrompts: unknown country returns non-US labels', () => {
  const { regionLabel, postalLabel } = regionPrompts('ZZ');
  // Any non-US country must NOT return State/ZIP labels
  assert.notEqual(regionLabel, 'State (2-letter)', 'unknown country must not use US region label');
  assert.notEqual(postalLabel, 'ZIP code',          'unknown country must not use ZIP label');
});

// ── formatPhone ───────────────────────────────────────────────────────────────

test('formatPhone: US 10-digit → (xxx) xxx-xxxx format', () => {
  const result = formatPhone('5125550000', 'US');
  assert.equal(result, '(512) 555-0000');
});

test('formatPhone: US 10-digit, different number', () => {
  const result = formatPhone('2025551234', 'US');
  assert.equal(result, '(202) 555-1234');
});

test('formatPhone: US non-10-digit (e.g. with country code) returned verbatim', () => {
  const raw = '15125550000'; // 11 digits
  const result = formatPhone(raw, 'US');
  assert.equal(result, raw, 'non-10-digit US phone returned as-is');
});

test('formatPhone: CA phone returned verbatim regardless of length', () => {
  const raw = '6135550000';
  const result = formatPhone(raw, 'CA');
  assert.equal(result, raw, 'Canadian phone not reformatted');
});

test('formatPhone: GB phone with country code returned verbatim', () => {
  const raw = '+442071234567';
  const result = formatPhone(raw, 'GB');
  assert.equal(result, raw, 'UK phone returned as-is');
});

test('formatPhone: AU phone with spaces returned verbatim', () => {
  const raw = '0412 345 678';
  const result = formatPhone(raw, 'AU');
  assert.equal(result, raw, 'Australian phone with spaces preserved verbatim');
});

test('formatPhone: CA postal-style phone string (non-digit chars) returned verbatim', () => {
  // Edge case: someone enters a phone that looks like a postal code
  const raw = 'K1A-0A6';
  const result = formatPhone(raw, 'CA');
  assert.equal(result, raw, 'non-digit phone preserved verbatim for non-US');
});
