/**
 * test/config-review-fixes.test.js
 *
 * Covers the 2026-06-10 review findings owned by lib/config.js:
 *   B7  - detail/lastDetail schema unification (recordPendingConfirmation -> lastDetail)
 *   B9  - readStateFileSafe rejects non-object / array / primitive shapes
 *   B10 - encryptConfigToDisk / decryptConfigToDisk use the fsync'd write path
 *   B11 - saveCheckpoint is atomic (tmp + rename)
 *   B21 - HISTORY_MAX >= DEFUNCT_THRESHOLD is asserted at module load
 *   B23 - recordSuccess computes a single Date (lastAttempt == lastSuccess)
 *   B6  - recordKnowRequest accepts an optional (person, totalPersons) and keys via stateKey
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function withTmpState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-review-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();
  try {
    fn({ dir, stateFile });
  } finally {
    cfg.setTestStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── B9: readStateFileSafe shape validation ──────────────────────────────────

test('B9: readStateFileSafe rejects a JSON array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b9-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify([1, 2, 3]));
  assert.equal(cfg.readStateFileSafe(f), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B9: readStateFileSafe rejects a JSON primitive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b9-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, '42');
  assert.equal(cfg.readStateFileSafe(f), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B9: readStateFileSafe rejects an object without optOuts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b9-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ foo: 'bar' }));
  assert.equal(cfg.readStateFileSafe(f), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B9: readStateFileSafe accepts a well-shaped state object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b9-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ optOuts: { Spokeo: { lastSuccess: 'x' } } }));
  const parsed = cfg.readStateFileSafe(f);
  assert.ok(parsed && parsed.optOuts && parsed.optOuts.Spokeo);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B23: recordSuccess single Date ──────────────────────────────────────────

test('B23: recordSuccess sets lastAttempt equal to lastSuccess (single clock read)', () => {
  withTmpState(() => {
    cfg.recordSuccess('Spokeo', 'done');
    const entry = cfg.loadState().optOuts.Spokeo;
    assert.equal(entry.lastSuccess, entry.lastAttempt, 'both stamps must be the same instant');
  });
});

// ── B7: schema unification detail -> lastDetail ─────────────────────────────

test('B7: recordPendingConfirmation writes lastDetail, not the dead `detail` field', () => {
  withTmpState(() => {
    cfg.recordPendingConfirmation('Radaris', 'check your email');
    const entry = cfg.loadState().optOuts.Radaris;
    assert.equal(entry.lastDetail, 'check your email');
    assert.equal(entry.detail, undefined, 'dead `detail` field must not be written');
  });
});

// ── B6: recordKnowRequest keys via stateKey ─────────────────────────────────

test('B6: recordKnowRequest with a bare name (legacy) keys on the bare name', () => {
  withTmpState(() => {
    cfg.recordKnowRequest('Pipl');
    const state = cfg.loadState();
    assert.ok(state.optOuts['Pipl'] && state.optOuts['Pipl'].knowRequestedAt);
  });
});

test('B6: recordKnowRequest with a person + count > 1 keys on the composite stateKey', () => {
  withTmpState(() => {
    const person = { firstName: 'Jane', lastName: 'Doe' };
    cfg.recordKnowRequest('Pipl', person, 2);
    const state = cfg.loadState();
    assert.ok(state.optOuts['Pipl|Jane Doe'], 'composite key expected in multi-person mode');
    assert.equal(state.optOuts['Pipl'], undefined, 'bare key must NOT be used in multi-person mode');
  });
});

test('B6: recordKnowRequest with a person but count <= 1 keys on the bare name', () => {
  withTmpState(() => {
    const person = { firstName: 'Jane', lastName: 'Doe' };
    cfg.recordKnowRequest('Pipl', person, 1);
    const state = cfg.loadState();
    assert.ok(state.optOuts['Pipl'] && state.optOuts['Pipl'].knowRequestedAt);
    assert.equal(state.optOuts['Pipl|Jane Doe'], undefined);
  });
});

// ── B11: atomic checkpoint write ────────────────────────────────────────────

test('B11: saveCheckpoint leaves no .tmp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b11-'));
  const ckptPath = path.join(dir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);
  cfg.setDryRun(false);

  cfg.saveCheckpoint('Spokeo');

  assert.ok(fs.existsSync(ckptPath), 'checkpoint written');
  assert.equal(fs.readFileSync(ckptPath, 'utf8').trim(), 'Spokeo');
  assert.ok(!fs.existsSync(ckptPath + '.tmp'), 'no .tmp left after atomic write');

  cfg.setTestCheckpointPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── B21: HISTORY_MAX >= DEFUNCT_THRESHOLD coupling ──────────────────────────

test('B21: HISTORY_MAX is at least DEFUNCT_THRESHOLD', () => {
  // If this coupling were ever broken the config module would throw at require
  // time; reaching this line at all proves the assertion held. Re-verify the
  // relationship explicitly for documentation value.
  const { DEFUNCT_THRESHOLD } = require('../lib/defunct');
  assert.ok(cfg.HISTORY_MAX >= DEFUNCT_THRESHOLD, 'HISTORY_MAX must be >= DEFUNCT_THRESHOLD');
});

// ── B10: fsync'd config.enc write ───────────────────────────────────────────

test('B10: encryptConfigToDisk leaves no .tmp file behind (fsync path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-b10-'));
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify({ person: { firstName: 'A' } }));

  cfg.encryptConfigToDisk({ configPath, encPath, passphrase: 'pw' });

  assert.ok(fs.existsSync(encPath), 'enc file written');
  assert.ok(!fs.existsSync(encPath + '.tmp'), 'no .tmp left behind after fsync write');

  // Round-trip decrypt to confirm integrity of the fsync'd write.
  cfg.decryptConfigToDisk({ configPath, encPath, passphrase: 'pw' });
  const back = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(back.person.firstName, 'A');
  assert.ok(!fs.existsSync(configPath + '.tmp'), 'no .tmp left behind on decrypt');

  fs.rmSync(dir, { recursive: true, force: true });
});
