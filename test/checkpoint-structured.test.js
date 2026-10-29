/**
 * test/checkpoint-structured.test.js
 *
 * R2: the checkpoint file gains a structured form
 *   { phase: 'explicit' | 'generic', personIndex, key, index }
 * so --resume can pick the ~490-broker generic pass back up. A bare broker name
 * (what every earlier run wrote) must keep working, and nothing here may let a
 * preview (--dry-run) touch the checkpoint of an interrupted real run.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

let dir;
let ckpt;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-ckpt-struct-'));
  ckpt = path.join(dir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckpt);
  cfg.setDryRun(false);
});

afterEach(() => {
  cfg.setDryRun(false);
  cfg.setTestCheckpointPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const GENERIC = { phase: 'generic', personIndex: 1, key: 'Acme Data|Jane Doe', index: 42 };

// ── writing ──────────────────────────────────────────────────────────────────

test('saveCheckpoint writes a structured record as one JSON line', () => {
  cfg.saveCheckpoint(GENERIC);
  const text = fs.readFileSync(ckpt, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), GENERIC);
});

test('saveCheckpoint keeps writing a bare string exactly as before', () => {
  cfg.saveCheckpoint('Spokeo');
  assert.equal(fs.readFileSync(ckpt, 'utf8'), 'Spokeo\n');
});

test('a structured checkpoint is written atomically with mode 0600 and no temp file left behind', { skip: process.platform === 'win32' }, () => {
  cfg.saveCheckpoint(GENERIC);
  assert.equal(fs.statSync(ckpt).mode & 0o777, 0o600, 'the checkpoint names the person, so owner-only');
  assert.deepEqual(fs.readdirSync(dir), ['state.json.checkpoint'], 'the tmp file was renamed away');
});

test('saveCheckpoint refuses a malformed record and leaves the existing checkpoint alone', () => {
  cfg.saveCheckpoint('Spokeo');
  assert.throws(() => cfg.saveCheckpoint({ phase: 'nonsense', key: 'X', index: 1, personIndex: 0 }), TypeError);
  assert.throws(() => cfg.saveCheckpoint({ phase: 'generic', key: '', index: 1, personIndex: 0 }), TypeError);
  assert.throws(() => cfg.saveCheckpoint({ phase: 'generic', key: 'X', index: -1, personIndex: 0 }), TypeError);
  assert.throws(() => cfg.saveCheckpoint({ phase: 'generic', key: 'X', index: 1.5, personIndex: 0 }), TypeError);
  assert.throws(() => cfg.saveCheckpoint(undefined), TypeError);
  assert.throws(() => cfg.saveCheckpoint(42), TypeError);
  assert.equal(fs.readFileSync(ckpt, 'utf8'), 'Spokeo\n');
});

test('saveCheckpoint accepts a record without an index (the explicit runner does not know one)', () => {
  cfg.saveCheckpoint({ phase: 'explicit', personIndex: 0, key: 'Spokeo' });
  assert.deepEqual(cfg.loadCheckpoint(), { phase: 'explicit', personIndex: 0, key: 'Spokeo', index: null });
});

test('a dry run never writes a structured checkpoint', () => {
  cfg.setDryRun(true);
  cfg.saveCheckpoint(GENERIC);
  assert.equal(fs.existsSync(ckpt), false);
});

test('a dry run never clears a structured checkpoint, a real run does', () => {
  cfg.saveCheckpoint(GENERIC);
  cfg.setDryRun(true);
  cfg.clearCheckpoint();
  assert.deepEqual(cfg.loadCheckpoint(), GENERIC, 'the preview must not delete the interrupted run\'s resume point');
  cfg.setDryRun(false);
  cfg.clearCheckpoint();
  assert.equal(fs.existsSync(ckpt), false);
  assert.equal(cfg.loadCheckpoint(), null);
});

// ── reading ──────────────────────────────────────────────────────────────────

test('loadCheckpoint round-trips a structured record', () => {
  cfg.saveCheckpoint(GENERIC);
  assert.deepEqual(cfg.loadCheckpoint(), GENERIC);
});

test('loadCheckpoint still returns a bare broker name for a plain-string file', () => {
  fs.writeFileSync(ckpt, 'BeenVerified\n');
  assert.equal(cfg.loadCheckpoint(), 'BeenVerified');
  fs.writeFileSync(ckpt, 'Spokeo|Jane Doe\n');
  assert.equal(cfg.loadCheckpoint(), 'Spokeo|Jane Doe');
});

test('loadCheckpoint treats a structured file of an unknown shape as no checkpoint, so a run restarts rather than skips', () => {
  for (const bad of [
    '{"phase":"sideways","personIndex":0,"key":"X","index":1}',
    '{"phase":"generic","personIndex":0,"key":"","index":1}',
    '{"phase":"generic","personIndex":0,"index":1}',
    '{"personIndex":0,"key":"X","index":1}',
    '{}',
    '{"phase":"generic","personIndex":0,"key":42,"index":1}',
  ]) {
    fs.writeFileSync(ckpt, bad + '\n');
    assert.equal(cfg.loadCheckpoint(), null, `should not trust ${bad}`);
  }
});

test('loadCheckpoint does not throw on a truncated JSON file; it reads as a plain key that matches nothing', () => {
  fs.writeFileSync(ckpt, '{"phase":"gene');
  assert.doesNotThrow(() => cfg.loadCheckpoint());
  assert.equal(cfg.findResumeIndex([{ name: 'Spokeo' }], cfg.loadCheckpoint(), { firstName: 'A', lastName: 'B' }, 1), -1);
});

test('loadCheckpoint drops junk fields and nulls an out-of-range personIndex or index', () => {
  fs.writeFileSync(ckpt, JSON.stringify({ phase: 'generic', personIndex: -3, key: 'X', index: 'seven', extra: 'ignored' }) + '\n');
  assert.deepEqual(cfg.loadCheckpoint(), { phase: 'generic', personIndex: null, key: 'X', index: null });
});

// ── normalizeCheckpoint ──────────────────────────────────────────────────────

test('normalizeCheckpoint maps a bare string to the explicit phase and passes structured records through', () => {
  assert.deepEqual(cfg.normalizeCheckpoint('Spokeo|Jane Doe'), { phase: 'explicit', personIndex: null, key: 'Spokeo|Jane Doe', index: null });
  assert.deepEqual(cfg.normalizeCheckpoint(GENERIC), GENERIC);
});

test('normalizeCheckpoint returns null for anything that is not a checkpoint', () => {
  for (const nothing of [null, undefined, '', '   ', 7, [], {}, { phase: 'generic' }]) {
    assert.equal(cfg.normalizeCheckpoint(nothing), null, `${JSON.stringify(nothing)}`);
  }
});

// ── findResumeIndex with a structured record ─────────────────────────────────

const BROKERS = [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }];
const JANE = { firstName: 'Jane', lastName: 'Doe' };

test('findResumeIndex resumes an explicit-phase structured record by its key', () => {
  const record = { phase: 'explicit', personIndex: 1, key: 'Bravo|Jane Doe', index: 1 };
  assert.equal(cfg.findResumeIndex(BROKERS, record, JANE, 2), 1);
});

test('findResumeIndex never resumes the explicit list from a generic-phase record', () => {
  // A generic checkpoint means the explicit pass already finished, even when a
  // generic row happens to share a name with an explicit broker.
  assert.equal(cfg.findResumeIndex(BROKERS, { phase: 'generic', personIndex: 0, key: 'Bravo', index: 0 }, JANE, 1), -1);
});

test('findResumeIndex still resumes from a bare string', () => {
  assert.equal(cfg.findResumeIndex(BROKERS, 'Charlie', JANE, 1), 2);
});
