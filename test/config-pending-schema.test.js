/**
 * test/config-pending-schema.test.js
 *
 * CRIT-3 / HIGH-8: canonical pendingConfirm schema and clearance on success.
 *
 * Uses setTestStatePath so no real state.json is touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function makeTmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-pending-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  return { dir, stateFile };
}

test('recordPendingConfirmation - getPendingConfirmations integration: returns the broker', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);

  // Reset in-memory state to match the temp file
  const state = cfg.loadState();
  const prev = state.optOuts['BrokerX'];
  delete state.optOuts['BrokerX'];

  cfg.setDryRun(false);
  cfg.recordPendingConfirmation('BrokerX', 'Please click the link in your inbox');

  const results = cfg.getPendingConfirmations();
  const names = results.map(r => r.name);
  assert.ok(names.includes('BrokerX'), `expected BrokerX in ${JSON.stringify(names)}`);

  // cleanup
  if (prev === undefined) delete state.optOuts['BrokerX'];
  else state.optOuts['BrokerX'] = prev;
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordPendingConfirmation - getPendingConfirmations includes snippet and since', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);

  const state = cfg.loadState();
  delete state.optOuts['BrokerY'];

  cfg.recordPendingConfirmation('BrokerY', 'Confirm your request at broker-y.com');

  const results = cfg.getPendingConfirmations();
  const entry = results.find(r => r.name === 'BrokerY');
  assert.ok(entry, 'BrokerY should appear in pending list');
  assert.equal(entry.snippet, 'Confirm your request at broker-y.com');
  assert.ok(typeof entry.since === 'string' && entry.since.length > 0, 'since should be a non-empty ISO string');

  delete state.optOuts['BrokerY'];
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isPendingConfirmation returns true after recordPendingConfirmation', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);

  const state = cfg.loadState();
  delete state.optOuts['BrokerZ'];
  cfg.setDryRun(false);

  cfg.recordPendingConfirmation('BrokerZ', 'check inbox');

  assert.equal(cfg.isPendingConfirmation('BrokerZ'), true);

  delete state.optOuts['BrokerZ'];
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shouldSkip returns pending-confirmation reason after recordPendingConfirmation', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);

  const state = cfg.loadState();
  delete state.optOuts['BrokerW'];
  cfg.setDryRun(false);

  cfg.recordPendingConfirmation('BrokerW', 'confirm link sent');

  const skip = cfg.shouldSkip('BrokerW');
  assert.ok(skip, 'should skip a freshly pending broker');
  assert.match(skip.reason, /Pending email confirmation/);

  delete state.optOuts['BrokerW'];
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSuccess clears isPendingConfirmation', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);

  const state = cfg.loadState();
  delete state.optOuts['BrokerV'];
  cfg.setDryRun(false);

  cfg.recordPendingConfirmation('BrokerV', 'waiting for confirm');
  assert.equal(cfg.isPendingConfirmation('BrokerV'), true, 'should be pending before success');

  cfg.recordSuccess('BrokerV', 'opt-out confirmed');
  assert.equal(cfg.isPendingConfirmation('BrokerV'), false, 'should NOT be pending after success');

  delete state.optOuts['BrokerV'];
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSuccess removes pendingConfirm and pendingConfirmation keys from entry', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);

  const state = cfg.loadState();
  // Seed old-style boolean shape (back-compat)
  state.optOuts['BrokerU'] = {
    pendingConfirmation: true,
    pendingConfirm: { since: new Date().toISOString(), snippet: 'old' },
    lastAttempt: new Date().toISOString(),
  };
  cfg.setDryRun(false);

  cfg.recordSuccess('BrokerU', 'done');

  const entry = state.optOuts['BrokerU'];
  assert.ok(entry, 'entry should still exist');
  assert.ok(!('pendingConfirm' in entry), 'pendingConfirm should be deleted');
  assert.ok(!('pendingConfirmation' in entry), 'pendingConfirmation should be deleted');
  assert.ok(entry.lastSuccess, 'lastSuccess should be set');

  delete state.optOuts['BrokerU'];
  cfg.setTestStatePath(null);
  cfg.setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
});
