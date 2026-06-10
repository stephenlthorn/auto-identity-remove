/**
 * test/right-to-know-config.test.js
 *
 * Covers the right-to-know state helpers in lib/config.js:
 *   - recordKnowRequest writes knowRequestedAt and persists to a temp state file
 *   - getPendingKnowRequests lists requests older than N days, sorted oldest-first
 *   - recent requests (< threshold) are excluded
 *   - brokers without a knowRequestedAt are excluded
 *
 * Hermetic: uses setTestStatePath to redirect writes to a temp file. Restores
 * the live shared state object afterward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-know-'));
  const statePath = path.join(dir, 'state.json');
  cfg.setTestStatePath(statePath);
  // Reset the in-memory state to an empty optOuts so the temp file is the
  // single source of truth for this test.
  const state = cfg.loadState();
  const saved = {};
  for (const k of Object.keys(state)) { saved[k] = state[k]; delete state[k]; }
  state.optOuts = {};
  try {
    return fn({ state, statePath });
  } finally {
    cfg.setDryRun(false);
    cfg.setTestStatePath(null);
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('recordKnowRequest: writes knowRequestedAt and persists to disk', () => {
  withTempState(({ statePath }) => {
    cfg.setDryRun(false);
    cfg.recordKnowRequest('Pipl');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entry = onDisk.optOuts.Pipl;
    assert.ok(entry, 'expected Pipl entry on disk');
    assert.ok(entry.knowRequestedAt, 'expected knowRequestedAt timestamp');
    const ageMs = Date.now() - new Date(entry.knowRequestedAt).getTime();
    assert.ok(ageMs >= 0 && ageMs < 5000, `timestamp should be ~now, age=${ageMs}ms`);
  });
});

test('recordKnowRequest: preserves existing fields on the entry', () => {
  withTempState(({ state }) => {
    cfg.setDryRun(false);
    state.optOuts.Pipl = { history: ['success'], totalRuns: 2 };
    cfg.recordKnowRequest('Pipl');
    assert.deepEqual(state.optOuts.Pipl.history, ['success']);
    assert.equal(state.optOuts.Pipl.totalRuns, 2);
    assert.ok(state.optOuts.Pipl.knowRequestedAt);
  });
});

test('getPendingKnowRequests: lists requests older than threshold, oldest first', () => {
  withTempState(({ state }) => {
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    state.optOuts = {
      Pipl:   { knowRequestedAt: daysAgo(60) },
      Spokeo: { knowRequestedAt: daysAgo(90) },
      Radaris:{ knowRequestedAt: daysAgo(10) }, // too recent
      Intelius:{ history: ['success'] },         // no know request
    };
    const brokers = [
      { name: 'Pipl', expectedSender: 'privacy@pipl.com' },
      { name: 'Spokeo' },
    ];
    const pending = cfg.getPendingKnowRequests(brokers, { olderThanDays: 45 });
    assert.equal(pending.length, 2, `expected 2 pending, got ${JSON.stringify(pending)}`);
    assert.equal(pending[0].name, 'Spokeo'); // oldest first (90d)
    assert.equal(pending[1].name, 'Pipl');   // 60d
    assert.ok(pending[1].daysAgo >= 59 && pending[1].daysAgo <= 61);
    assert.equal(pending[0].expectedSender, undefined);
    assert.equal(pending[1].expectedSender, 'privacy@pipl.com');
  });
});

test('getPendingKnowRequests: default threshold is 45 days', () => {
  withTempState(({ state }) => {
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    state.optOuts = {
      Old:   { knowRequestedAt: daysAgo(50) },
      Fresh: { knowRequestedAt: daysAgo(40) },
    };
    const pending = cfg.getPendingKnowRequests([]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'Old');
  });
});
