/**
 * test/prune-dead.test.js
 *
 * Tests for the pruneDeadUrls() aggregation function exported from
 * scripts/prune-dead.js.  Uses temp directories so no real log or data files
 * are touched.
 *
 * A host is only added after >= 3 separate runs spanning >= 14 days of hard
 * failures (BRK-11), so `writeLog(name, entries)` here writes the same entries
 * to three runs 10 days apart. The real bucketed log shape and the threshold
 * edge cases are covered in prune-dead-real-log.test.js.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { pruneDeadUrls } = require('../scripts/prune-dead');

let tmpDir;
let logsDir;
let deadUrlsPath;

beforeEach(() => {
  tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-dead-test-'));
  logsDir      = path.join(tmpDir, 'logs');
  deadUrlsPath = path.join(tmpDir, 'dead-urls.json');
  fs.mkdirSync(logsDir);
  // Start with empty dead-urls.json
  fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: [] }, null, 2) + '\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01T03:00:00Z');

// One log file with its mtime set to `dayOffset` days after T0 (flat arrays carry
// no runAt, so the run time falls back to the file's mtime).
function writeLog(filename, entries, dayOffset = 0) {
  const file = path.join(logsDir, filename);
  fs.writeFileSync(file, JSON.stringify(entries), 'utf8');
  const at = new Date(T0 + dayOffset * DAY);
  fs.utimesSync(file, at, at);
}

// The same entries in three runs 10 days apart: enough history to prune on.
function writeThreeRuns(entries) {
  writeLog('run-1.json', entries, 0);
  writeLog('run-2.json', entries, 10);
  writeLog('run-3.json', entries, 20);
}

function readDead() {
  return JSON.parse(fs.readFileSync(deadUrlsPath, 'utf8')).hosts;
}

// ── Core pruning logic ────────────────────────────────────────────────────────

test('adds hosts that are dead in every run they appear in', () => {
  writeThreeRuns([
    { broker: 'gone.com',  status: 'dead',    detail: 'HTTP 404' },
    { broker: 'alive.com', status: 'success', detail: '' },
  ]);

  const { added, total } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, ['gone.com']);
  assert.equal(total, 1);
  assert.deepEqual(readDead(), ['gone.com']);
});

test('does NOT add a host that was reachable in any run', () => {
  writeLog('run-1.json', [
    { broker: 'flaky.com', status: 'dead',    detail: 'HTTP 404' },
  ]);
  writeLog('run-2.json', [
    { broker: 'flaky.com', status: 'success', detail: 'Form submitted' },
  ]);

  const { added } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, []);
  assert.deepEqual(readDead(), []);
});

test('does NOT add a host that appears in only one run as success', () => {
  writeLog('run-1.json', [
    { broker: 'newsite.com', status: 'success', detail: '' },
  ]);

  const { added } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, []);
});

test('is idempotent - running twice produces no change', () => {
  writeThreeRuns([
    { broker: 'gone.com', status: 'dead', detail: 'ENOTFOUND' },
  ]);

  const first  = pruneDeadUrls(logsDir, deadUrlsPath);
  const second = pruneDeadUrls(logsDir, deadUrlsPath);

  assert.deepEqual(first.added, ['gone.com']);
  assert.deepEqual(second.added, []);         // no new additions
  assert.equal(second.total, 1);              // still 1 total
  assert.deepEqual(readDead(), ['gone.com']); // unchanged
});

test('merges with existing entries, deduped and sorted', () => {
  // Pre-populate with one host
  fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: ['zombie.com'] }, null, 2) + '\n', 'utf8');

  writeThreeRuns([
    { broker: 'another-dead.com', status: 'dead', detail: 'HTTP 410' },
    { broker: 'zombie.com',       status: 'dead', detail: 'HTTP 404' },  // already in set
  ]);

  const { added, total } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, ['another-dead.com']);
  assert.equal(total, 2);
  assert.deepEqual(readDead(), ['another-dead.com', 'zombie.com']); // sorted
});

test('handles missing logs directory gracefully (no crash)', () => {
  const nonExistentLogs = path.join(tmpDir, 'no-logs-here');
  const { added, total } = pruneDeadUrls(nonExistentLogs, deadUrlsPath);
  assert.deepEqual(added, []);
  assert.equal(total, 0);
});

test('skips malformed log files without crashing', () => {
  fs.writeFileSync(path.join(logsDir, 'run-bad.json'), 'NOT VALID JSON', 'utf8');
  writeThreeRuns([
    { broker: 'consistently-dead.com', status: 'dead', detail: 'ERR_NAME_NOT_RESOLVED' },
  ]);

  const { added } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, ['consistently-dead.com']);
});

test('produces a sorted hosts array in the output file', () => {
  writeThreeRuns([
    { broker: 'zebra.com',  status: 'dead', detail: 'HTTP 404' },
    { broker: 'alpha.com',  status: 'dead', detail: 'HTTP 404' },
    { broker: 'middle.com', status: 'dead', detail: 'HTTP 404' },
  ]);

  pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(readDead(), ['alpha.com', 'middle.com', 'zebra.com']);
});

test('handles log files where entries lack a broker field', () => {
  writeThreeRuns([
    { status: 'dead', detail: 'HTTP 404' },        // no broker
    { broker: '', status: 'dead', detail: '' },    // empty broker
    { broker: 'real.com', status: 'dead', detail: 'HTTP 404' },
  ]);

  const { added } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, ['real.com']);
});
