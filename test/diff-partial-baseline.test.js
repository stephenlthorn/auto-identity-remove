/**
 * test/diff-partial-baseline.test.js
 *
 * CFG-15c: loadPreviousLog took the newest run-*.json as the baseline, even
 * when that run was `--only Spokeo` or `--retry-failed`. Diffing a full run
 * against a one-broker log reports hundreds of "newly removed" brokers and
 * hides real regressions. The watcher marks partial runs (top-level
 * `partial: true` and a `filter` object); the baseline must skip them.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPreviousLog, isPartialLog } = require('../lib/diff');

function logsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-diff-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const full = marker => ({ marker, runAt: marker, succeeded: [{ broker: 'Spokeo' }] });

test('isPartialLog recognises partial: true', () => {
  assert.equal(isPartialLog({ partial: true }), true);
});

test('isPartialLog recognises a populated filter object', () => {
  assert.equal(isPartialLog({ filter: { only: ['Spokeo'] } }), true);
  assert.equal(isPartialLog({ filter: { skip: ['Radaris'], only: [] } }), true);
  assert.equal(isPartialLog({ filter: { retryFailed: true } }), true);
});

test('isPartialLog treats an absent or empty filter as a full run', () => {
  assert.equal(isPartialLog({}), false);
  assert.equal(isPartialLog({ partial: false }), false);
  assert.equal(isPartialLog({ filter: null }), false);
  assert.equal(isPartialLog({ filter: {} }), false);
  assert.equal(isPartialLog({ filter: { only: [], skip: [] } }), false);
  assert.equal(isPartialLog(null), false);
});

test('loadPreviousLog skips a newer partial run and uses the last full one', () => {
  const dir = logsDir({
    'run-2026-05-17T10-00-00.json': full('full-older'),
    'run-2026-05-18T10-00-00.json': { ...full('only-spokeo'), partial: true, filter: { only: ['Spokeo'] } },
    'run-2026-05-19T10-00-00.json': full('current'),
  });
  const prev = loadPreviousLog(dir, 'run-2026-05-19T10-00-00.json');
  assert.equal(prev.marker, 'full-older');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a log carrying only a filter (no partial flag) is skipped too', () => {
  const dir = logsDir({
    'run-2026-05-17T10-00-00.json': full('full-older'),
    'run-2026-05-18T10-00-00.json': { ...full('retry'), filter: { retryFailed: true } },
    'run-2026-05-19T10-00-00.json': full('current'),
  });
  assert.equal(loadPreviousLog(dir, 'run-2026-05-19T10-00-00.json').marker, 'full-older');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a newer full run is still preferred over an older one', () => {
  const dir = logsDir({
    'run-2026-05-17T10-00-00.json': full('older'),
    'run-2026-05-18T10-00-00.json': { ...full('newer'), partial: false, filter: null },
    'run-2026-05-19T10-00-00.json': full('current'),
  });
  assert.equal(loadPreviousLog(dir, 'run-2026-05-19T10-00-00.json').marker, 'newer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns null when every earlier log is partial', () => {
  const dir = logsDir({
    'run-2026-05-18T10-00-00.json': { ...full('a'), partial: true },
    'run-2026-05-19T10-00-00.json': full('current'),
  });
  assert.equal(loadPreviousLog(dir, 'run-2026-05-19T10-00-00.json'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable newest log falls through to the next one instead of ending the search', () => {
  const dir = logsDir({
    'run-2026-05-17T10-00-00.json': full('older'),
    'run-2026-05-18T10-00-00.json': '{"truncated": ',
    'run-2026-05-19T10-00-00.json': full('current'),
  });
  assert.equal(loadPreviousLog(dir, 'run-2026-05-19T10-00-00.json').marker, 'older');
  fs.rmSync(dir, { recursive: true, force: true });
});
