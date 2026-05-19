/**
 * test/drift.test.js
 *
 * Tests for lib/drift.js — selector drift detection.
 * isDrifted(history) flags when last 3 entries are all non-success.
 * findDrifted(state) returns all drifted brokers with metadata.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isDrifted, findDrifted } = require('../lib/drift');

// ── isDrifted ─────────────────────────────────────────────────────────────────

test('isDrifted: last 3 non-success entries → true', () => {
  assert.equal(isDrifted(['success', 'error', 'error', 'error']), true);
});

test('isDrifted: last entry is success → false', () => {
  assert.equal(isDrifted(['error', 'error', 'success']), false);
});

test('isDrifted: empty history → false', () => {
  assert.equal(isDrifted([]), false);
});

test('isDrifted: exactly 3 consecutive non-success at end → true', () => {
  assert.equal(isDrifted(['captcha_failed', 'error', 'pending_confirm']), true);
});

test('isDrifted: fewer than 3 entries, all non-success → false', () => {
  assert.equal(isDrifted(['error', 'error']), false);
});

test('isDrifted: 3 non-success but separated by success → false', () => {
  assert.equal(isDrifted(['error', 'success', 'error', 'error']), false);
});

test('isDrifted: all 5 non-success → true', () => {
  assert.equal(isDrifted(['error', 'error', 'error', 'error', 'error']), true);
});

test('isDrifted: pending_confirm counts as non-success → true when 3 at end', () => {
  assert.equal(isDrifted(['success', 'pending_confirm', 'pending_confirm', 'pending_confirm']), true);
});

// ── findDrifted ───────────────────────────────────────────────────────────────

test('findDrifted: returns drifted broker with name', () => {
  const state = {
    optOuts: {
      A: { history: ['error', 'error', 'error'] },
      B: { history: ['success'] },
    },
  };
  const drifted = findDrifted(state);
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].name, 'A');
});

test('findDrifted: lastSuccess is null when no success in state entry', () => {
  const state = {
    optOuts: {
      MyLife: { history: ['error', 'error', 'error'] },
    },
  };
  const drifted = findDrifted(state);
  assert.equal(drifted[0].lastSuccess, null);
});

test('findDrifted: lastSuccess comes from entry.lastSuccess timestamp', () => {
  const ts = '2026-02-14T00:00:00.000Z';
  const state = {
    optOuts: {
      Spokeo: { history: ['error', 'error', 'error'], lastSuccess: ts },
    },
  };
  const drifted = findDrifted(state);
  assert.equal(drifted[0].lastSuccess, ts);
});

test('findDrifted: returns history array on each result', () => {
  const state = {
    optOuts: {
      A: { history: ['error', 'error', 'error'] },
    },
  };
  const drifted = findDrifted(state);
  assert.deepEqual(drifted[0].history, ['error', 'error', 'error']);
});

test('findDrifted: empty state → empty array', () => {
  assert.deepEqual(findDrifted({ optOuts: {} }), []);
});

test('findDrifted: broker without history → not drifted', () => {
  const state = {
    optOuts: {
      A: { lastSuccess: '2026-01-01T00:00:00.000Z' },
    },
  };
  assert.deepEqual(findDrifted(state), []);
});

test('findDrifted: multiple drifted brokers returned', () => {
  const state = {
    optOuts: {
      A: { history: ['error', 'error', 'error'] },
      B: { history: ['success', 'success'] },
      C: { history: ['captcha_failed', 'captcha_failed', 'captcha_failed'] },
    },
  };
  const drifted = findDrifted(state);
  assert.equal(drifted.length, 2);
  const names = drifted.map(d => d.name).sort();
  assert.deepEqual(names, ['A', 'C']);
});
