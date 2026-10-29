/**
 * test/filter.test.js
 *
 * Tests for lib/filter.js:
 *   - parseList(arg)            - splits comma-separated names, trims whitespace
 *   - applyFilter(brokers, opts)- returns filtered broker array
 *   - extractFailedBrokers(log) - returns Set of broker names from error buckets
 *   - loadLastLog(logsDir)      - reads newest run-*.json from logs/, returns parsed or null
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseList, applyFilter, extractFailedBrokers, loadLastLog } = require('../lib/filter');

// ─── parseList ────────────────────────────────────────────────────────────────

test('parseList splits comma-separated values', () => {
  assert.deepEqual(parseList('a,b,c'), ['a', 'b', 'c']);
});

test('parseList trims whitespace around names', () => {
  assert.deepEqual(parseList(' Spokeo , Radaris , BeenVerified '), ['Spokeo', 'Radaris', 'BeenVerified']);
});

test('parseList single item returns array with one element', () => {
  assert.deepEqual(parseList('Spokeo'), ['Spokeo']);
});

test('parseList empty string returns empty array', () => {
  assert.deepEqual(parseList(''), []);
});

// ─── applyFilter - only ───────────────────────────────────────────────────────

const ALL = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];

test('applyFilter with only returns matching brokers', () => {
  const result = applyFilter(ALL, { only: 'A,C' });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(b => b.name), ['A', 'C']);
});

// Was "is case-sensitive": `--only spokeo` silently matched nothing. The shared
// broker predicate (CORE-4) is case-insensitive, and applyFilter now uses it so
// the explicit list and the generic/email passes can never disagree.
test('applyFilter with only is case-insensitive', () => {
  const result = applyFilter(ALL, { only: 'a,c' });
  assert.deepEqual(result.map(b => b.name), ['A', 'C']);
});

test('applyFilter with only single broker returns one broker', () => {
  const result = applyFilter(ALL, { only: 'B' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});

// ─── applyFilter - skip ───────────────────────────────────────────────────────

test('applyFilter with skip removes named brokers, keeps the rest', () => {
  const result = applyFilter(ALL, { skip: 'B' });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(b => b.name), ['A', 'C']);
});

test('applyFilter with skip multiple brokers', () => {
  const result = applyFilter(ALL, { skip: 'A,C' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});

test('applyFilter with skip missing broker leaves list unchanged', () => {
  const result = applyFilter(ALL, { skip: 'Z' });
  assert.equal(result.length, 3);
});

// ─── applyFilter - retryFailedFromLog ─────────────────────────────────────────

test('applyFilter with retryFailedFromLog returns only matching brokers', () => {
  const failed = new Set(['B']);
  const result = applyFilter(ALL, { retryFailedFromLog: failed });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});

test('applyFilter with empty retryFailedFromLog returns empty array', () => {
  const result = applyFilter(ALL, { retryFailedFromLog: new Set() });
  assert.equal(result.length, 0);
});

test('applyFilter with retryFailedFromLog multiple names', () => {
  const failed = new Set(['A', 'C']);
  const result = applyFilter(ALL, { retryFailedFromLog: failed });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(b => b.name), ['A', 'C']);
});

// ─── applyFilter - no filter → returns all ────────────────────────────────────

test('applyFilter with no options returns all brokers', () => {
  const result = applyFilter(ALL, {});
  assert.equal(result.length, 3);
});

test('applyFilter with undefined options returns all brokers', () => {
  const result = applyFilter(ALL);
  assert.equal(result.length, 3);
});

// ─── extractFailedBrokers ─────────────────────────────────────────────────────

test('extractFailedBrokers returns Set of names from errors and captchaFailed', () => {
  const log = {
    errors: [{ name: 'A' }],
    captchaFailed: [{ name: 'B' }],
    pendingConfirm: [],
  };
  const result = extractFailedBrokers(log);
  assert.ok(result instanceof Set);
  assert.deepEqual([...result].sort(), ['A', 'B']);
});

test('extractFailedBrokers includes pendingConfirm names', () => {
  const log = {
    errors: [{ name: 'A' }],
    captchaFailed: [],
    pendingConfirm: [{ name: 'C' }],
  };
  const result = extractFailedBrokers(log);
  assert.deepEqual([...result].sort(), ['A', 'C']);
});

test('extractFailedBrokers returns empty Set when all buckets empty', () => {
  const log = { errors: [], captchaFailed: [], pendingConfirm: [] };
  const result = extractFailedBrokers(log);
  assert.equal(result.size, 0);
});

test('extractFailedBrokers handles missing buckets gracefully', () => {
  const log = { errors: [{ name: 'X' }] };
  const result = extractFailedBrokers(log);
  assert.deepEqual([...result], ['X']);
});

test('extractFailedBrokers deduplicates if same name appears in multiple buckets', () => {
  const log = {
    errors: [{ name: 'A' }],
    captchaFailed: [{ name: 'A' }],
    pendingConfirm: [],
  };
  const result = extractFailedBrokers(log);
  assert.equal(result.size, 1);
  assert.ok(result.has('A'));
});

// ─── loadLastLog ──────────────────────────────────────────────────────────────

test('loadLastLog returns null when logsDir does not exist', () => {
  const result = loadLastLog('/nonexistent/path/logs');
  assert.equal(result, null);
});

test('loadLastLog returns null when no run-*.json files present', () => {
  // Use os.tmpdir + unique subdir that exists but is empty-ish
  const os = require('os');
  const fs = require('fs');
  const dir = path.join(os.tmpdir(), `filter-test-empty-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const result = loadLastLog(dir);
  assert.equal(result, null);
  fs.rmdirSync(dir);
});

test('loadLastLog returns parsed JSON from the most recently named run-*.json', () => {
  const os = require('os');
  const fs = require('fs');
  const dir = path.join(os.tmpdir(), `filter-test-logs-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  const older = { runAt: '2026-05-17', errors: [], captchaFailed: [], pendingConfirm: [] };
  const newer = { runAt: '2026-05-18', errors: [{ name: 'Spokeo' }], captchaFailed: [], pendingConfirm: [] };

  fs.writeFileSync(path.join(dir, 'run-2026-05-17.json'), JSON.stringify(older));
  fs.writeFileSync(path.join(dir, 'run-2026-05-18.json'), JSON.stringify(newer));

  const result = loadLastLog(dir);
  assert.deepEqual(result, newer);

  fs.rmSync(dir, { recursive: true });
});

test('loadLastLog returns null when run file contains invalid JSON', () => {
  const os = require('os');
  const fs = require('fs');
  const dir = path.join(os.tmpdir(), `filter-test-invalid-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-2026-05-18.json'), 'not-valid-json{{{');
  const result = loadLastLog(dir);
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true });
});
