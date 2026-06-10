/**
 * test/allowlist.test.js
 *
 * Pure-helper coverage for the broker allowlist feature:
 *   - isAllowlisted(name, config)  - case-insensitive, trimmed membership test
 *   - addToAllowlist / removeFromAllowlist - immutable config edits (Task 6)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowlisted } = require('../lib/filter');

test('isAllowlisted: returns false when config has no allowlist', () => {
  assert.equal(isAllowlisted('Spokeo', {}), false);
  assert.equal(isAllowlisted('Spokeo', { allowlist: [] }), false);
});

test('isAllowlisted: exact match returns true', () => {
  assert.equal(isAllowlisted('Spokeo', { allowlist: ['Spokeo'] }), true);
});

test('isAllowlisted: match is case-insensitive', () => {
  assert.equal(isAllowlisted('Spokeo', { allowlist: ['spokeo'] }), true);
  assert.equal(isAllowlisted('SPOKEO', { allowlist: ['Spokeo'] }), true);
});

test('isAllowlisted: surrounding whitespace in the list is ignored', () => {
  assert.equal(isAllowlisted('BeenVerified', { allowlist: ['  BeenVerified  '] }), true);
});

test('isAllowlisted: non-member returns false', () => {
  assert.equal(isAllowlisted('Radaris', { allowlist: ['Spokeo', 'BeenVerified'] }), false);
});

test('isAllowlisted: tolerates missing/blank name and non-array allowlist', () => {
  assert.equal(isAllowlisted('', { allowlist: ['Spokeo'] }), false);
  assert.equal(isAllowlisted(undefined, { allowlist: ['Spokeo'] }), false);
  assert.equal(isAllowlisted('Spokeo', null), false);
  assert.equal(isAllowlisted('Spokeo', { allowlist: 'Spokeo' }), false);
});
