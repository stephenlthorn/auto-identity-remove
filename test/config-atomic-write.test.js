/**
 * test/config-atomic-write.test.js
 *
 * CRIT-5: atomic state.json save and backup-recovery in loadState.
 *
 * Exercises saveState() and the loadState() / resetState() recovery path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function makeTmpState(initialData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-atomic-'));
  const stateFile = path.join(dir, 'state.json');
  const data = initialData || { optOuts: {} };
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  return { dir, stateFile };
}

test('saveState writes state.json with current in-memory state', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);

  const state = cfg.loadState();
  state.optOuts['__atomic_test__'] = { lastSuccess: '2026-01-01T00:00:00.000Z' };

  cfg.saveState();

  assert.ok(fs.existsSync(stateFile), 'state.json must exist after saveState');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.optOuts['__atomic_test__'], 'written entry should be present');
  assert.equal(persisted.optOuts['__atomic_test__'].lastSuccess, '2026-01-01T00:00:00.000Z');

  delete state.optOuts['__atomic_test__'];
  cfg.setTestStatePath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState leaves no .tmp file behind after a successful write', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);

  cfg.saveState();

  assert.ok(!fs.existsSync(stateFile + '.tmp'), '.tmp must be cleaned up after saveState');

  cfg.setTestStatePath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState creates a .bak copy after the atomic rename', () => {
  const { dir, stateFile } = makeTmpState({ optOuts: { prior: { lastSuccess: '2025-01-01T00:00:00.000Z' } } });
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);

  // First save creates state.json; second save should produce a .bak of the first save
  cfg.saveState(); // first - from in-memory, creates bak of original file
  cfg.saveState(); // second - bak now exists and is the state from first save

  const bak = stateFile + '.bak';
  assert.ok(fs.existsSync(bak), '.bak should exist after two saves');

  cfg.setTestStatePath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadState (resetState) recovers from .bak when state.json is missing', () => {
  const { dir, stateFile } = makeTmpState();
  const bakFile = stateFile + '.bak';
  cfg.setDryRun(false);

  // Write a known good state into the bak file
  const knownGoodState = { optOuts: { recoveredBroker: { lastSuccess: '2025-06-01T00:00:00.000Z' } } };
  fs.writeFileSync(bakFile, JSON.stringify(knownGoodState, null, 2));

  // Remove the primary state.json so only the bak exists
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

  // Point config to our temp dir and reload
  cfg.setTestStatePath(stateFile);

  // resetState reads from disk using getStatePath(); we need it to pick up bak
  const state = cfg.loadState();
  // Manually trigger the recovery by calling resetState
  // (resetState reads disk again, which should fall back to .bak)
  cfg.resetState();
  const recovered = cfg.loadState();

  assert.ok(
    recovered.optOuts['recoveredBroker'],
    'state should be recovered from .bak when state.json is absent'
  );
  assert.equal(
    recovered.optOuts['recoveredBroker'].lastSuccess,
    '2025-06-01T00:00:00.000Z'
  );

  cfg.setTestStatePath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
