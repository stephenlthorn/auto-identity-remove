const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAmbiguousKeyword, extractKeyword } = require('../lib/forms');

test('extractKeyword: extracts from *="..." selector', () => {
  assert.equal(extractKeyword('input[name*="first" i]'), 'first');
});
test('extractKeyword: extracts from id*="..." selector', () => {
  assert.equal(extractKeyword('input[id*="email" i]'), 'email');
});
test('extractKeyword: returns null when no *="..." pattern', () => {
  assert.equal(extractKeyword('input[type="text"]'), null);
});
test('extractKeyword: returns null for submit button', () => {
  assert.equal(extractKeyword('button[type="submit"]'), null);
});
test('isAmbiguousKeyword: "first" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('first'));
});
test('isAmbiguousKeyword: "last" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('last'));
});
test('isAmbiguousKeyword: "name" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('name'));
});
test('isAmbiguousKeyword: "address" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('address'));
});
test('isAmbiguousKeyword: "email" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('email'));
});
test('isAmbiguousKeyword: "zip" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('zip'));
});
test('isAmbiguousKeyword: "phone" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('phone'));
});
test('isAmbiguousKeyword: case-insensitive - "First" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('First'));
});
test('isAmbiguousKeyword: case-insensitive - "LAST" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('LAST'));
});
