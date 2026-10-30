/**
 * test/config-dryrun-checkpoint.test.js
 *
 * CORE-7a: clearCheckpoint() had no dry-run guard. A `--dry-run` preview after an
 * interrupted real run deleted the checkpoint, so the following `--resume`
 * silently restarted from the top.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

test('clearCheckpoint is a no-op during a dry run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-ckpt-'));
  const ckpt = path.join(dir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckpt);
  try {
    cfg.saveCheckpoint('Spokeo');
    assert.equal(cfg.loadCheckpoint(), 'Spokeo');

    cfg.setDryRun(true);
    cfg.clearCheckpoint();
    assert.equal(fs.existsSync(ckpt), true, 'a preview must not delete the real run\'s checkpoint');
    assert.equal(cfg.loadCheckpoint(), 'Spokeo');

    cfg.setDryRun(false);
    cfg.clearCheckpoint();
    assert.equal(fs.existsSync(ckpt), false, 'a real run still clears it');
  } finally {
    cfg.setDryRun(false);
    cfg.setTestCheckpointPath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
