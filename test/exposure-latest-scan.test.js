// test/exposure-latest-scan.test.js
/**
 * NET-13: serpResultsFromHistory used the all-time best rank per broker, so a
 * broker seen once in an old scan counted forever and the SERP part of the
 * score could never improve. It now reflects the latest conclusive scan only.
 *
 * Also the persisted breach count (--score / --report used a hard-coded 0) and
 * the one-call loader the watcher uses for both signals.
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exposure = require('../lib/exposure');
const { serpResultsFromHistory, computeExposureScore } = exposure;

const row = (scanId, at, broker, engine, rank) => ({ scanId, scannedAt: at, personId: 'p', broker, engine, rank, hostname: `${broker}.com` });
const marker = (scanId, at, conclusive = true) => ({ scanId, scannedAt: at, scan: true, conclusive, enginesUsable: ['ddg'] });

const T1 = '2026-04-01T10:00:00.000Z';
const T2 = '2026-05-01T10:00:00.000Z';
const T3 = '2026-06-01T10:00:00.000Z';

const brokersOf = (results) => results.map(r => r.broker).sort();

test('NET-13: a broker seen only in an older scan does not count', () => {
  const rows = [
    row('s1', T1, 'Spokeo', 'ddg', 1),
    marker('s1', T1),
    row('s2', T2, 'Radaris', 'bing', 5),
    marker('s2', T2),
  ];
  assert.deepEqual(brokersOf(serpResultsFromHistory(rows)), ['Radaris']);
});

test('NET-13: the rank comes from the latest scan, so the score can improve', () => {
  const rows = [
    row('s1', T1, 'Spokeo', 'ddg', 1),
    marker('s1', T1),
    row('s2', T2, 'Spokeo', 'ddg', 8),
    marker('s2', T2),
  ];
  const out = serpResultsFromHistory(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].ranks.ddg, 8, 'not the all-time best of 1');

  const before = computeExposureScore({ serpResults: serpResultsFromHistory(rows.slice(0, 2)) }).score;
  const after = computeExposureScore({ serpResults: out }).score;
  assert.ok(after < before, `score should improve (${before} -> ${after})`);
});

test('NET-13: a later clean scan clears the SERP signal', () => {
  const rows = [
    row('s1', T1, 'Spokeo', 'ddg', 1),
    marker('s1', T1),
    marker('s2', T2),
  ];
  assert.deepEqual(serpResultsFromHistory(rows), []);
});

test('NET-5/NET-13: an inconclusive later scan does not erase what the last usable scan found', () => {
  const rows = [
    row('s1', T1, 'Spokeo', 'ddg', 2),
    marker('s1', T1),
    marker('s2', T2, false),
  ];
  assert.deepEqual(brokersOf(serpResultsFromHistory(rows)), ['Spokeo']);
});

test('NET-13: rows from several people in the same scan are merged with best rank per engine', () => {
  const rows = [
    row('s2', T2, 'Spokeo', 'ddg', 9),
    row('s2', T2, 'Spokeo', 'ddg', 3),
    row('s2', T2, 'Radaris', 'google', 4),
    marker('s2', T2),
    row('s1', T1, 'Old', 'ddg', 1),
    marker('s1', T1),
  ];
  const out = serpResultsFromHistory(rows);
  assert.deepEqual(brokersOf(out), ['Radaris', 'Spokeo']);
  assert.equal(out.find(r => r.broker === 'Spokeo').ranks.ddg, 3);
});

test('NET-13: history written before scan ids existed is split into scans by time', () => {
  const legacy = (at, broker, rank) => ({ scannedAt: at, personId: 'p', broker, engine: 'ddg', rank });
  const rows = [
    legacy(T1, 'Spokeo', 1),
    legacy('2026-05-01T10:00:00.000Z', 'Radaris', 4),
    legacy('2026-05-01T10:00:40.000Z', 'Whitepages', 2), // same scan: seconds apart
  ];
  assert.deepEqual(brokersOf(serpResultsFromHistory(rows)), ['Radaris', 'Whitepages']);
});

test('NET-13: a scan-id scan newer than undated legacy rows replaces them', () => {
  const rows = [
    { personId: 'p', broker: 'Ancient', engine: 'ddg', rank: 1 },
    row('s1', T1, 'Spokeo', 'ddg', 2),
    marker('s1', T1),
  ];
  assert.deepEqual(brokersOf(serpResultsFromHistory(rows)), ['Spokeo']);
});

test('NET-13: rows with no timestamps at all are one scan (the pre-existing behaviour)', () => {
  const rows = [
    { broker: 'Spokeo', engine: 'ddg', rank: 5 },
    { broker: 'Spokeo', engine: 'ddg', rank: 2 },
    { broker: 'Radaris', engine: 'bing', rank: 7 },
  ];
  const out = serpResultsFromHistory(rows);
  assert.deepEqual(brokersOf(out), ['Radaris', 'Spokeo']);
  assert.equal(out.find(r => r.broker === 'Spokeo').ranks.ddg, 2);
});

test('NET-13: marker rows and malformed rows never become broker results', () => {
  const rows = [marker('s1', T1), null, 42, { scan: true }, { broker: 'X' }];
  assert.deepEqual(serpResultsFromHistory(rows), []);
});

test('NET-13: a clean latest scan sits after later-dated inconclusive scans only when conclusive', () => {
  const rows = [
    row('s1', T1, 'Spokeo', 'ddg', 1), marker('s1', T1),
    marker('s2', T2),                  // clean and conclusive
    marker('s3', T3, false),           // blocked
  ];
  assert.deepEqual(serpResultsFromHistory(rows), [], 'the s2 clean scan is the latest usable one');
});

// -- persisted breach count + one-call loader -----------------------------------

let tmpDir;
function sandbox() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-exposure-'));
  exposure.setTestBreachResultPath(path.join(tmpDir, 'breach-result.json'));
  return tmpDir;
}
afterEach(() => {
  exposure.setTestBreachResultPath(null);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

test('NET-13: with no breach check on record the count is 0', () => {
  sandbox();
  assert.equal(exposure.loadBreachCount(), 0);
});

test('NET-13: a conclusive breach check is persisted and feeds the score', () => {
  sandbox();
  exposure.recordBreachResult({ totalBreaches: 3, inconclusive: false, perEmail: [{ email: 'secret@example.com' }] });
  assert.equal(exposure.loadBreachCount(), 3);

  const summary = computeExposureScore({ breachCount: exposure.loadBreachCount() });
  assert.equal(summary.breachWeight, 24);
});

test('NET-13: the stored breach file holds counts only, never an email address', () => {
  const dir = sandbox();
  exposure.recordBreachResult({ totalBreaches: 1, inconclusive: false, perEmail: [{ email: 'secret@example.com', breaches: [{ name: 'X' }] }] });
  const raw = fs.readFileSync(path.join(dir, 'breach-result.json'), 'utf8');
  assert.doesNotMatch(raw, /secret@example\.com/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'breach-result.json')).mode & 0o777, 0o600);
  }
});

test('NET-12/NET-13: an inconclusive check never lowers the recorded count; a conclusive one can', () => {
  sandbox();
  exposure.recordBreachResult({ totalBreaches: 4, inconclusive: false });
  exposure.recordBreachResult({ totalBreaches: 0, inconclusive: true });
  assert.equal(exposure.loadBreachCount(), 4, 'a failed lookup is not an improvement');

  exposure.recordBreachResult({ totalBreaches: 2, inconclusive: true });
  assert.equal(exposure.loadBreachCount(), 4);

  exposure.recordBreachResult({ totalBreaches: 1, inconclusive: false });
  assert.equal(exposure.loadBreachCount(), 1, 'a conclusive recheck may lower it');
});

test('NET-13: a corrupt breach file reads as 0 instead of throwing', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'breach-result.json'), '{ not json');
  assert.equal(exposure.loadBreachCount(), 0);
});

test('NET-13: loadPersistedSignals returns the latest-scan SERP results and the breach count in one call', () => {
  const dir = sandbox();
  const serpPath = path.join(dir, 'serp-history.json');
  fs.writeFileSync(serpPath, JSON.stringify([
    row('s1', T1, 'Spokeo', 'ddg', 1), marker('s1', T1),
    row('s2', T2, 'Radaris', 'bing', 6), marker('s2', T2),
  ]));
  exposure.recordBreachResult({ totalBreaches: 2, inconclusive: false });

  const signals = exposure.loadPersistedSignals({ serpHistoryPath: serpPath });
  assert.deepEqual(brokersOf(signals.serpResults), ['Radaris']);
  assert.equal(signals.breachCount, 2);

  const summary = computeExposureScore({ state: { optOuts: {} }, ...signals });
  assert.equal(summary.serpHits, 1);
  assert.equal(summary.breakdown.breach, 16);
});

test('NET-13: loadPersistedSignals tolerates a missing SERP history file', () => {
  const dir = sandbox();
  const signals = exposure.loadPersistedSignals({ serpHistoryPath: path.join(dir, 'nope.json') });
  assert.deepEqual(signals.serpResults, []);
  assert.equal(signals.breachCount, 0);
});
