/**
 * test/config-reliability.test.js
 *
 * Fix 1 [crash-safety]: module-level state init is safe when state.json is corrupt.
 * Fix 2 [durability]: .bak is written atomically (tmp+rename) and is valid after save.
 *
 * All tests use temp paths only - never the real state.json.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const cfg = require('../lib/config');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-reliability-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── Fix 1: readStateFileSafe is exported and works as a standalone helper ─────

test('readStateFileSafe: reads a valid JSON file correctly', () => {
  const dir  = makeTmpDir();
  const file = path.join(dir, 'state.json');
  try {
    const data = { optOuts: { broker1: { lastSuccess: '2025-01-01T00:00:00.000Z' } } };
    fs.writeFileSync(file, JSON.stringify(data));
    const result = cfg.readStateFileSafe(file);
    assert.deepEqual(result, data);
  } finally {
    cleanup(dir);
  }
});

test('readStateFileSafe: returns null for a corrupt (non-JSON) file', () => {
  const dir  = makeTmpDir();
  const file = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(file, 'NOT JSON {{{');
    const result = cfg.readStateFileSafe(file);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('readStateFileSafe: returns null for a missing file', () => {
  const dir  = makeTmpDir();
  const file = path.join(dir, 'missing.json');
  try {
    const result = cfg.readStateFileSafe(file);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('readStateFileSafe: returns null for an empty file', () => {
  const dir  = makeTmpDir();
  const file = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(file, '');
    const result = cfg.readStateFileSafe(file);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

// ── Fix 1: resetState falls back to .bak when primary is corrupt ──────────────

test('resetState: corrupt primary -> loads from .bak, no throw', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  try {
    // Corrupt primary, valid .bak
    fs.writeFileSync(statePath, 'CORRUPT {{{');
    const bakData = { optOuts: { fromBak: { lastSuccess: '2025-06-01T00:00:00.000Z' } } };
    fs.writeFileSync(bakPath, JSON.stringify(bakData));

    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    assert.doesNotThrow(() => cfg.resetState());
    const state = cfg.loadState();
    assert.ok(state.optOuts.fromBak, 'should recover broker entry from .bak');
    assert.equal(state.optOuts.fromBak.lastSuccess, '2025-06-01T00:00:00.000Z');
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

test('resetState: corrupt primary AND corrupt .bak -> empty state, no throw', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  try {
    fs.writeFileSync(statePath, 'BAD JSON');
    fs.writeFileSync(bakPath,   'ALSO BAD JSON');

    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    assert.doesNotThrow(() => cfg.resetState());
    const state = cfg.loadState();
    assert.deepEqual(state, { optOuts: {} });
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

test('resetState: corrupt primary AND missing .bak -> empty state, no throw', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(statePath, 'TRUNCATED');
    // no .bak file

    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    assert.doesNotThrow(() => cfg.resetState());
    const state = cfg.loadState();
    assert.deepEqual(state, { optOuts: {} });
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

// ── Fix 2: saveState writes .bak atomically (via tmp+rename) ─────────────────

test('saveState: .bak is created via tmp-rename (no .bak.tmp left behind)', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  const bakTmp    = bakPath  + '.tmp';
  try {
    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    cfg.saveState();

    assert.ok(fs.existsSync(statePath), 'state.json should exist after save');
    assert.ok(fs.existsSync(bakPath),   '.bak should exist after save');
    assert.ok(!fs.existsSync(bakTmp),   '.bak.tmp must not be left behind');
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

test('saveState: .bak content is valid JSON matching the saved state', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  try {
    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    const state = cfg.loadState();
    state.optOuts['__durability_test__'] = { lastSuccess: '2026-05-01T00:00:00.000Z' };
    cfg.saveState();
    delete state.optOuts['__durability_test__'];

    const primary = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const bak     = JSON.parse(fs.readFileSync(bakPath,   'utf8'));
    assert.deepEqual(bak, primary, '.bak should be byte-identical to state.json after save');
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

test('saveState: resetState can recover from .bak after primary is deleted', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  try {
    cfg.setTestStatePath(statePath);
    cfg.setDryRun(false);

    const state = cfg.loadState();
    state.optOuts['__recover_test__'] = { lastSuccess: '2026-03-01T00:00:00.000Z' };
    cfg.saveState();
    delete state.optOuts['__recover_test__'];

    // Simulate corrupt/deleted primary
    fs.unlinkSync(statePath);
    assert.ok(fs.existsSync(bakPath), '.bak should exist to recover from');

    cfg.resetState();
    const recovered = cfg.loadState();
    assert.ok(recovered.optOuts['__recover_test__'], 'should recover entry from .bak');
  } finally {
    cfg.setTestStatePath(null);
    cleanup(dir);
  }
});

test('saveState: dry-run does not write .bak', () => {
  const dir       = makeTmpDir();
  const statePath = path.join(dir, 'state.json');
  const bakPath   = statePath + '.bak';
  try {
    cfg.setTestStatePath(statePath);
    cfg.setDryRun(true);

    cfg.saveState();

    assert.ok(!fs.existsSync(statePath), 'state.json must not be written in dry-run');
    assert.ok(!fs.existsSync(bakPath),   '.bak must not be written in dry-run');
  } finally {
    cfg.setTestStatePath(null);
    cfg.setDryRun(false);
    cleanup(dir);
  }
});
