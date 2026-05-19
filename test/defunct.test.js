/**
 * test/defunct.test.js
 *
 * Tests for lib/defunct.js — defunct broker detection.
 * isUnreachable(kind)  — returns true for network-level error kinds.
 * isDefunct(history)   — returns true when the last DEFUNCT_THRESHOLD entries are all unreachable.
 * findDefunct(state)   — scans state.optOuts and returns names of defunct brokers.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isUnreachable, isDefunct, findDefunct, DEFUNCT_THRESHOLD } = require('../lib/defunct');

// ── isUnreachable ──────────────────────────────────────────────────────────────

test('isUnreachable: returns false for empty string', () => {
  assert.equal(isUnreachable(''), false);
});

test('isUnreachable: returns true for "error" (the kind stored for network failures)', () => {
  assert.equal(isUnreachable('error'), true);
});

test('isUnreachable: returns false for "captcha_failed"', () => {
  assert.equal(isUnreachable('captcha_failed'), false);
});

test('isUnreachable: returns false for "success"', () => {
  assert.equal(isUnreachable('success'), false);
});

test('isUnreachable: returns false for "pending_confirm"', () => {
  assert.equal(isUnreachable('pending_confirm'), false);
});

test('isUnreachable: returns false for null', () => {
  assert.equal(isUnreachable(null), false);
});

test('isUnreachable: returns false for undefined', () => {
  assert.equal(isUnreachable(undefined), false);
});

// ── isDefunct ─────────────────────────────────────────────────────────────────

test('isDefunct: returns false when history is not an array', () => {
  assert.equal(isDefunct(null), false);
  assert.equal(isDefunct(undefined), false);
  assert.equal(isDefunct('error'), false);
});

test('isDefunct: returns false when history has fewer than DEFUNCT_THRESHOLD entries', () => {
  const short = Array(DEFUNCT_THRESHOLD - 1).fill('error');
  assert.equal(isDefunct(short), false);
});

test('isDefunct: returns false when tail has a success', () => {
  const history = [...Array(DEFUNCT_THRESHOLD - 1).fill('error'), 'success'];
  assert.equal(isDefunct(history), false);
});

test('isDefunct: returns false when tail has a captcha_failed', () => {
  const history = [...Array(DEFUNCT_THRESHOLD - 1).fill('error'), 'captcha_failed'];
  assert.equal(isDefunct(history), false);
});

test('isDefunct: returns true when last DEFUNCT_THRESHOLD entries are all "error"', () => {
  const history = Array(DEFUNCT_THRESHOLD).fill('error');
  assert.equal(isDefunct(history), true);
});

test('isDefunct: returns true when exactly DEFUNCT_THRESHOLD errors at end regardless of earlier entries', () => {
  const history = ['success', 'captcha_failed', ...Array(DEFUNCT_THRESHOLD).fill('error')];
  assert.equal(isDefunct(history), true);
});

test('isDefunct: returns false when one entry within the tail is captcha_failed', () => {
  const tail = Array(DEFUNCT_THRESHOLD).fill('error');
  tail[2] = 'captcha_failed';
  assert.equal(isDefunct(tail), false);
});

test('isDefunct: returns false when one entry within the tail is pending_confirm', () => {
  const tail = Array(DEFUNCT_THRESHOLD).fill('error');
  tail[0] = 'pending_confirm';
  assert.equal(isDefunct(tail), false);
});

// ── findDefunct ───────────────────────────────────────────────────────────────

test('findDefunct: returns empty array for empty state', () => {
  assert.deepEqual(findDefunct({}), []);
});

test('findDefunct: returns empty array for null/undefined state', () => {
  assert.deepEqual(findDefunct(null), []);
  assert.deepEqual(findDefunct(undefined), []);
});

test('findDefunct: returns names of defunct brokers sorted', () => {
  const errors = Array(DEFUNCT_THRESHOLD).fill('error');
  const stateOptOuts = {
    Zebra: { history: errors },
    Alpha: { history: errors },
    Beta:  { history: ['success'] },
  };
  const result = findDefunct(stateOptOuts);
  assert.deepEqual(result, ['Alpha', 'Zebra']);
});

test('findDefunct: excludes brokers with fewer than DEFUNCT_THRESHOLD errors', () => {
  const short = Array(DEFUNCT_THRESHOLD - 1).fill('error');
  const stateOptOuts = {
    A: { history: short },
  };
  assert.deepEqual(findDefunct(stateOptOuts), []);
});

test('findDefunct: excludes brokers whose tail contains a non-error kind', () => {
  const history = [...Array(DEFUNCT_THRESHOLD - 1).fill('error'), 'captcha_failed'];
  const stateOptOuts = {
    A: { history },
  };
  assert.deepEqual(findDefunct(stateOptOuts), []);
});

test('findDefunct: excludes brokers with no history', () => {
  const stateOptOuts = {
    A: { lastSuccess: '2026-01-01T00:00:00.000Z' },
  };
  assert.deepEqual(findDefunct(stateOptOuts), []);
});

test('findDefunct: handles entries with null history', () => {
  const stateOptOuts = {
    A: { history: null },
  };
  assert.deepEqual(findDefunct(stateOptOuts), []);
});
