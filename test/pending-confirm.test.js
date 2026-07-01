/**
 * test/pending-confirm.test.js — WP4 state-layer tests
 *
 * Covers:
 *   - recordPendingConfirmation stores { pendingConfirmation: true, lastAttempt }
 *   - isPendingConfirmation correctly reflects state
 *   - shouldSkip: pending entry younger than CONFIRM_RECHECK_DAYS → skip with reason
 *   - shouldSkip: pending entry older than CONFIRM_RECHECK_DAYS → null (re-attempt)
 *   - shouldSkip: non-pending entry uses the original 90-day window
 *   - setDryRun: pending-confirm record does NOT write state.json
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const cfg = require('../lib/config');

const N = '__test_pending_broker__';

function withCleanState(fn) {
  const state = cfg.loadState();
  const prev = state.optOuts[N];
  try {
    delete state.optOuts[N];
    fn(state);
  } finally {
    if (prev === undefined) delete state.optOuts[N];
    else state.optOuts[N] = prev;
  }
}

test('CONFIRM_RECHECK_DAYS is exported and equals 14', () => {
  assert.equal(cfg.CONFIRM_RECHECK_DAYS, 14);
});

test('recordPendingConfirmation stores pendingConfirm object + lastAttempt', () => {
  withCleanState((state) => {
    cfg.setDryRun(true); // do not pollute state.json on disk
    cfg.recordPendingConfirmation(N, 'check your email to confirm');
    cfg.setDryRun(false);
    const e = state.optOuts[N];
    assert.ok(e.pendingConfirm, 'pendingConfirm object should be set');
    assert.equal(typeof e.pendingConfirm.since, 'string', 'pendingConfirm.since must be a string');
    assert.equal(e.pendingConfirm.snippet, 'check your email to confirm');
    assert.equal(typeof e.lastAttempt, 'string');
    assert.equal(e.lastDetail, 'check your email to confirm');
    assert.equal(e.totalRuns, 1);
  });
});

test('recordPendingConfirmation increments totalRuns on repeat', () => {
  withCleanState((state) => {
    cfg.setDryRun(true);
    cfg.recordPendingConfirmation(N, 'a');
    cfg.recordPendingConfirmation(N, 'b');
    cfg.setDryRun(false);
    assert.equal(state.optOuts[N].totalRuns, 2);
  });
});

test('isPendingConfirmation: true for pending entries, false otherwise', () => {
  withCleanState((state) => {
    state.optOuts[N] = { pendingConfirm: { since: new Date().toISOString(), snippet: '' }, lastAttempt: new Date().toISOString() };
    assert.equal(cfg.isPendingConfirmation(N), true);
    state.optOuts[N] = { lastSuccess: new Date().toISOString() };
    assert.equal(cfg.isPendingConfirmation(N), false);
    delete state.optOuts[N];
    assert.equal(cfg.isPendingConfirmation(N), false);
  });
});

test('shouldSkip: pending entry within 14d window → skip with reason', () => {
  withCleanState((state) => {
    state.optOuts[N] = {
      pendingConfirm: { since: new Date(Date.now() - 3 * 86400000).toISOString(), snippet: '' },
      lastAttempt: new Date(Date.now() - 3 * 86400000).toISOString(), // 3 days ago
    };
    const out = cfg.shouldSkip(N);
    assert.ok(out, 'expected to skip');
    assert.match(out.reason, /Pending email confirmation/);
    assert.match(out.reason, /retry in \d+d/);
  });
});

test('shouldSkip: pending entry older than 14d → null (re-attempt)', () => {
  withCleanState((state) => {
    state.optOuts[N] = {
      pendingConfirm: { since: new Date(Date.now() - 20 * 86400000).toISOString(), snippet: '' },
      lastAttempt: new Date(Date.now() - 20 * 86400000).toISOString(), // 20d ago
    };
    assert.equal(cfg.shouldSkip(N), null);
  });
});

test('shouldSkip: non-pending fresh success → skip via 90-day window', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastSuccess: new Date(Date.now() - 10 * 86400000).toISOString() };
    const out = cfg.shouldSkip(N);
    assert.ok(out);
    assert.match(out.reason, /Last removed/);
  });
});

test('shouldSkip: non-pending old success → null (re-attempt)', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastSuccess: new Date(Date.now() - 100 * 86400000).toISOString() };
    assert.equal(cfg.shouldSkip(N), null);
  });
});

test('shouldSkip: no entry at all → null', () => {
  withCleanState(() => {
    assert.equal(cfg.shouldSkip(N), null);
  });
});

test('recordPendingConfirmation honors dry-run (no disk write)', () => {
  const before = fs.existsSync(cfg.STATE_PATH) ? fs.readFileSync(cfg.STATE_PATH, 'utf8') : null;
  withCleanState(() => {
    cfg.setDryRun(true);
    cfg.recordPendingConfirmation(N, 'should not persist');
    cfg.setDryRun(false);
  });
  const after = fs.existsSync(cfg.STATE_PATH) ? fs.readFileSync(cfg.STATE_PATH, 'utf8') : null;
  assert.equal(after, before, 'state.json must be unchanged under dry-run');
});

test('lastAttemptDaysAgo: falls back to lastSuccess if no lastAttempt', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastSuccess: new Date(Date.now() - 5 * 86400000).toISOString() };
    const d = cfg.lastAttemptDaysAgo(N);
    assert.ok(d > 4 && d < 6, `expected ~5 days, got ${d}`);
  });
});
