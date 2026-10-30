/**
 * test/retention-parse-age.test.js
 *
 * R6: `aidr purge --older-than <age>` and `retention.days` both go through
 * parseAge. It is the one gate between a typo and deleting recent audit
 * evidence, so it refuses anything it cannot read exactly and anything under a
 * week unless the caller says `force`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAge, MIN_RETENTION_DAYS } = require('../lib/retention');

test('a bare number is a count of days', () => {
  assert.equal(parseAge('30'), 30);
  assert.equal(parseAge(30), 30);
});

test('d, m and y suffixes mean days, 30-day months and 365-day years', () => {
  assert.equal(parseAge('180d'), 180);
  assert.equal(parseAge('6m'), 180);
  assert.equal(parseAge('1y'), 365);
  assert.equal(parseAge('2y'), 730);
});

test('case and surrounding whitespace do not matter', () => {
  assert.equal(parseAge(' 180D '), 180);
  assert.equal(parseAge('6M'), 180);
});

test('the minimum is a week, exported so callers can print it', () => {
  assert.equal(MIN_RETENTION_DAYS, 7);
  assert.equal(parseAge('7d'), 7);
  assert.equal(parseAge('1m'), 30);
});

test('anything under 7 days is refused and the error names the way out', () => {
  for (const input of ['6d', '1', '1d', 3]) {
    assert.throws(() => parseAge(input), /at least 7 days.*force/i, `input ${input}`);
  }
});

test('force lets a short age through, so a test or an operator can purge aggressively', () => {
  assert.equal(parseAge('1d', { force: true }), 1);
  assert.equal(parseAge('3', { force: true }), 3);
});

test('force never lets zero, negative or fractional ages through', () => {
  for (const input of ['0', '0d', '-5', '-5d', '1.5d', 0, -1, 2.5]) {
    assert.throws(() => parseAge(input, { force: true }), /whole number|positive/i, `input ${input}`);
  }
});

test('unreadable input names the accepted forms instead of guessing', () => {
  for (const input of ['', '   ', 'abc', '10x', 'd', '1 y', '3weeks', '1e3', '0x10', 'Infinity', 'NaN']) {
    assert.throws(() => parseAge(input), /180d.*6m.*1y|expected/i, `input ${JSON.stringify(input)}`);
  }
});

test('non-string, non-number input is refused', () => {
  for (const input of [undefined, null, true, false, {}, [], NaN, Infinity]) {
    assert.throws(() => parseAge(input), /age|days/i, `input ${String(input)}`);
  }
});

test('an age too large to be a real number of days is refused', () => {
  assert.throws(() => parseAge('99999999999999999999d'), /too large|whole number/i);
});
