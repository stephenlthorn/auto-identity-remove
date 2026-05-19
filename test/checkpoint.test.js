const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

test('saveCheckpoint writes broker name to checkpoint file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);
  cfg.setDryRun(false);

  cfg.saveCheckpoint('Spokeo');

  assert.ok(fs.existsSync(ckptPath));
  assert.equal(fs.readFileSync(ckptPath, 'utf8').trim(), 'Spokeo');

  cfg.setTestCheckpointPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadCheckpoint returns broker name when file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);

  fs.writeFileSync(ckptPath, 'BeenVerified\n');
  assert.equal(cfg.loadCheckpoint(), 'BeenVerified');

  cfg.setTestCheckpointPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadCheckpoint returns null when no checkpoint file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);

  assert.equal(cfg.loadCheckpoint(), null);

  cfg.setTestCheckpointPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('clearCheckpoint removes checkpoint file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);
  cfg.setDryRun(false);

  fs.writeFileSync(ckptPath, 'Radaris');
  cfg.clearCheckpoint();
  assert.ok(!fs.existsSync(ckptPath));

  cfg.setTestCheckpointPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('clearCheckpoint is no-op when no checkpoint file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);
  cfg.setDryRun(false);

  assert.doesNotThrow(() => cfg.clearCheckpoint());

  cfg.setTestCheckpointPath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('saveCheckpoint is no-op in dry-run mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const ckptPath = path.join(tmpDir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckptPath);
  cfg.setDryRun(true);

  cfg.saveCheckpoint('Intelius');
  assert.ok(!fs.existsSync(ckptPath), 'no checkpoint file in dry-run');

  cfg.setTestCheckpointPath(null);
  cfg.setDryRun(false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
