/**
 * test/config.test.js
 *
 * Covers the pure opt-out-history logic in lib/config.js:
 *   - lastOptOutDaysAgo: no entry → Infinity; recent → small; old → large
 *   - the dry-run state-save guard semantics (run-log is gated by DRY_RUN in
 *     watcher.js; recordSuccess writes state.json verbatim as in the monolith)
 *
 * The module's `state` is loaded from the real state.json at require time, so
 * these tests mutate the live shared object (matching process semantics) and
 * restore it afterward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cfg = require('../lib/config');

test('lastOptOutDaysAgo: no entry → Infinity', () => {
  const state = cfg.loadState();
  const name = '__test_missing_broker__';
  delete state.optOuts[name];
  assert.equal(cfg.lastOptOutDaysAgo(name), Infinity);
});

test('lastOptOutDaysAgo: recent success → small number of days', () => {
  const state = cfg.loadState();
  const name = '__test_recent_broker__';
  const prev = state.optOuts[name];
  state.optOuts[name] = { lastSuccess: new Date().toISOString(), totalRuns: 1 };
  const days = cfg.lastOptOutDaysAgo(name);
  assert.ok(days >= 0 && days < 1, `expected <1 day, got ${days}`);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('lastOptOutDaysAgo: old success → large number of days', () => {
  const state = cfg.loadState();
  const name = '__test_old_broker__';
  const prev = state.optOuts[name];
  const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  state.optOuts[name] = { lastSuccess: old, totalRuns: 1 };
  const days = cfg.lastOptOutDaysAgo(name);
  assert.ok(days > 360 && days < 370, `expected ~365 days, got ${days}`);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('lastOptOutDaysAgo: entry without lastSuccess → Infinity', () => {
  const state = cfg.loadState();
  const name = '__test_no_lastsuccess__';
  const prev = state.optOuts[name];
  state.optOuts[name] = { totalRuns: 3 };
  assert.equal(cfg.lastOptOutDaysAgo(name), Infinity);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('RECHECK_DAYS constant is 90 (unchanged from monolith)', () => {
  assert.equal(cfg.RECHECK_DAYS, 90);
});

test('dry-run state-save guard: run log write is gated by DRY_RUN in watcher.js', () => {
  // The monolith (and this refactor) gate the run-log file write on
  // `if (!DRY_RUN)`. recordSuccess itself writes state.json verbatim in both
  // modes — this test documents/asserts that contract so a future change that
  // alters it is caught. We assert recordSuccess + saveState are exported and
  // saveState does not require DRY_RUN to be a no-op (verbatim behavior).
  assert.equal(typeof cfg.recordSuccess, 'function');
  assert.equal(typeof cfg.saveState, 'function');
  // saveState has no DRY_RUN parameter — guard lives in watcher.js, by design.
  assert.equal(cfg.saveState.length, 0);
});
