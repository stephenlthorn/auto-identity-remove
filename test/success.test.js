const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeSuccess, looksLikeFailure, classifyPostSubmit } = require('../lib/success');

test('looksLikeSuccess: true for "request received"', () => {
  assert.ok(looksLikeSuccess('Your opt-out request has been received.'));
});
test('looksLikeSuccess: true for "successfully submitted"', () => {
  assert.ok(looksLikeSuccess('Your request was successfully submitted.'));
});
test('looksLikeSuccess: true for "you have been removed"', () => {
  assert.ok(looksLikeSuccess('You have been removed from our database.'));
});
test('looksLikeSuccess: true for "removal complete"', () => {
  assert.ok(looksLikeSuccess('Removal complete. Allow 7 days for processing.'));
});
test('looksLikeSuccess: true for "opt-out complete"', () => {
  assert.ok(looksLikeSuccess('Your opt-out is complete.'));
});
test('looksLikeSuccess: true for "we have received your request"', () => {
  assert.ok(looksLikeSuccess('We have received your deletion request.'));
});
test('looksLikeSuccess: false for generic page text', () => {
  assert.ok(!looksLikeSuccess('Welcome. Please fill out the form below.'));
});
test('looksLikeSuccess: false for empty string', () => {
  assert.ok(!looksLikeSuccess(''));
});
test('looksLikeFailure: true for "required field"', () => {
  assert.ok(looksLikeFailure('This field is required. Please correct the errors below.'));
});
test('looksLikeFailure: true for "invalid email"', () => {
  assert.ok(looksLikeFailure('Please enter a valid email address.'));
});
test('looksLikeFailure: true for "something went wrong"', () => {
  assert.ok(looksLikeFailure('Something went wrong. Please try again later.'));
});
test('looksLikeFailure: false for success text', () => {
  assert.ok(!looksLikeFailure('Your request was successfully submitted.'));
});
test('classifyPostSubmit: success when success phrase present', () => {
  const r = classifyPostSubmit('Your opt-out request has been received.');
  assert.equal(r.outcome, 'success');
  assert.ok(r.snippet.length > 0);
});
test('classifyPostSubmit: failure when error phrase present', () => {
  const r = classifyPostSubmit('This field is required.');
  assert.equal(r.outcome, 'failure');
});
test('classifyPostSubmit: unknown when neither phrase present', () => {
  const r = classifyPostSubmit('Please fill in the form.');
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.snippet, '');
});
test('classifyPostSubmit: handles null gracefully', () => {
  assert.equal(classifyPostSubmit(null).outcome, 'unknown');
});
