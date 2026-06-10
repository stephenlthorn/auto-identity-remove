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
const { addToAllowlist, removeFromAllowlist } = require('../lib/allowlist-edit');

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

test('addToAllowlist: adds a name to an absent allowlist', () => {
  const out = addToAllowlist({ person: {} }, 'Spokeo');
  assert.deepEqual(out.allowlist, ['Spokeo']);
  assert.deepEqual(out.person, {}, 'other config keys are preserved');
});

test('addToAllowlist: does not mutate the input config', () => {
  const input = { allowlist: ['BeenVerified'] };
  const out = addToAllowlist(input, 'Spokeo');
  assert.deepEqual(input.allowlist, ['BeenVerified'], 'input must be untouched');
  assert.deepEqual(out.allowlist, ['BeenVerified', 'Spokeo']);
});

test('addToAllowlist: is idempotent and case-insensitive (no duplicates)', () => {
  const out = addToAllowlist({ allowlist: ['Spokeo'] }, 'spokeo');
  assert.deepEqual(out.allowlist, ['Spokeo'], 'existing entry casing is preserved, no duplicate added');
});

test('addToAllowlist: trims the incoming name', () => {
  const out = addToAllowlist({ allowlist: [] }, '  Radaris  ');
  assert.deepEqual(out.allowlist, ['Radaris']);
});

test('addToAllowlist: throws on empty name', () => {
  assert.throws(() => addToAllowlist({ allowlist: [] }, '   '), /name/i);
});

test('removeFromAllowlist: removes case-insensitively', () => {
  const out = removeFromAllowlist({ allowlist: ['Spokeo', 'BeenVerified'] }, 'spokeo');
  assert.deepEqual(out.allowlist, ['BeenVerified']);
});

test('removeFromAllowlist: no-op when name absent or list missing', () => {
  assert.deepEqual(removeFromAllowlist({ allowlist: ['Spokeo'] }, 'Radaris').allowlist, ['Spokeo']);
  assert.deepEqual(removeFromAllowlist({ person: {} }, 'Radaris').allowlist, []);
});

test('removeFromAllowlist: does not mutate the input config', () => {
  const input = { allowlist: ['Spokeo'] };
  const out = removeFromAllowlist(input, 'Spokeo');
  assert.deepEqual(input.allowlist, ['Spokeo'], 'input must be untouched');
  assert.deepEqual(out.allowlist, []);
});
