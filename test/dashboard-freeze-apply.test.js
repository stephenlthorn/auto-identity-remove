/**
 * test/dashboard-freeze-apply.test.js
 *
 * applyFreeze is the pure state transition the dashboard's POST /api/freeze
 * persists under the state lock (DASH-7 / codex #7).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyFreeze, getFreezeStatus } = require('../lib/freeze');

const NOW = new Date('2026-10-29T12:00:00.000Z');

test('applyFreeze done records doneAt and leaves optOuts untouched', () => {
  const state = { optOuts: { Spokeo: { history: ['success'] } } };
  const next = applyFreeze(state, 'equifax', 'done', NOW);
  assert.deepEqual(next.freezes, { equifax: { doneAt: '2026-10-29T12:00:00.000Z' } });
  assert.deepEqual(next.optOuts, state.optOuts);
  assert.equal(getFreezeStatus(next).find(t => t.key === 'equifax').done, true);
});

test('applyFreeze does not mutate its input', () => {
  const state = { optOuts: {}, freezes: { experian: { doneAt: '2026-01-01T00:00:00.000Z' } } };
  const before = JSON.stringify(state);
  applyFreeze(state, 'equifax', 'done', NOW);
  applyFreeze(state, 'experian', 'clear', NOW);
  assert.equal(JSON.stringify(state), before);
});

test('applyFreeze clear removes only that target', () => {
  const state = { optOuts: {}, freezes: { equifax: { doneAt: 'x' }, innovis: { doneAt: 'y' } } };
  const next = applyFreeze(state, 'equifax', 'clear');
  assert.deepEqual(next.freezes, { innovis: { doneAt: 'y' } });
});

test('applyFreeze clear on an absent target is a no-op', () => {
  assert.deepEqual(applyFreeze({ optOuts: {} }, 'equifax', 'clear').freezes, {});
});

test('applyFreeze keeps unrelated top-level keys of the state', () => {
  const next = applyFreeze({ optOuts: {}, lastRun: 'x' }, 'nctue', 'done', NOW);
  assert.equal(next.lastRun, 'x');
});

test('applyFreeze rejects an unknown target and an unknown action', () => {
  assert.throws(() => applyFreeze({}, 'bogus', 'done'), /unknown freeze target/);
  assert.throws(() => applyFreeze({}, 'equifax', 'nope'), /bad freeze action/);
});

test('applyFreeze tolerates a missing or non-object state', () => {
  for (const bad of [undefined, null]) {
    assert.deepEqual(applyFreeze(bad, 'equifax', 'done', NOW).freezes.equifax, { doneAt: NOW.toISOString() });
  }
});
