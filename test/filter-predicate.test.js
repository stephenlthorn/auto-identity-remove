/**
 * test/filter-predicate.test.js
 *
 * CORE-4: --only / --skip / --retry-failed used to filter only the explicit
 * non-email broker list, so `aidr run --only Spokeo` still sent every opt-out
 * email and ran ~490 generic submissions. The fix is one predicate, built from
 * the flags, that every runner consults (opts.include).
 *
 * CORE-5: --retry-failed read `entry.name` but logResult writes `entry.broker`,
 * so the retry set was always empty against a real log.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  makeBrokerPredicate,
  applyFilter,
  extractFailedBrokers,
  loadLastLog,
} = require('../lib/filter');

// ─── makeBrokerPredicate ──────────────────────────────────────────────────────

test('makeBrokerPredicate: no filter includes every broker', () => {
  const include = makeBrokerPredicate({});
  assert.equal(include('Spokeo'), true);
  assert.equal(include('anything.example.com'), true);
  assert.equal(makeBrokerPredicate()('Spokeo'), true);
});

test('makeBrokerPredicate: null flag values (flag absent) include everything', () => {
  const include = makeBrokerPredicate({ only: null, skip: null, retryFailedFromLog: undefined });
  assert.equal(include('Spokeo'), true);
});

test('makeBrokerPredicate: only keeps just the named brokers', () => {
  const include = makeBrokerPredicate({ only: 'Spokeo,Radaris' });
  assert.equal(include('Spokeo'), true);
  assert.equal(include('Radaris'), true);
  assert.equal(include('BeenVerified'), false);
});

test('makeBrokerPredicate: names match case-insensitively and ignore padding', () => {
  const include = makeBrokerPredicate({ only: ' spokeo , RADARIS ' });
  assert.equal(include('Spokeo'), true);
  assert.equal(include('radaris'), true);
  assert.equal(include(' Radaris '), true);
  assert.equal(include('Other'), false);
});

test('makeBrokerPredicate: skip excludes the named brokers only', () => {
  const include = makeBrokerPredicate({ skip: 'spokeo' });
  assert.equal(include('Spokeo'), false);
  assert.equal(include('Radaris'), true);
});

test('makeBrokerPredicate: retryFailedFromLog keeps only brokers in the set', () => {
  const include = makeBrokerPredicate({ retryFailedFromLog: new Set(['Spokeo']) });
  assert.equal(include('spokeo'), true);
  assert.equal(include('Radaris'), false);
});

test('makeBrokerPredicate: an empty retry set includes nothing (nothing failed)', () => {
  const include = makeBrokerPredicate({ retryFailedFromLog: new Set() });
  assert.equal(include('Spokeo'), false);
});

test('makeBrokerPredicate: --only and --retry-failed narrow each other, they do not outrank each other (CLI2-2)', () => {
  // A broker has to be both named by --only and in the retry set. It used to be
  // "only wins", which dropped --retry-failed silently.
  const include = makeBrokerPredicate({ only: 'A,B', retryFailedFromLog: new Set(['B', 'C']) });
  assert.equal(include('B'), true, 'named and failed');
  assert.equal(include('A'), false, 'named but did not fail');
  assert.equal(include('C'), false, 'failed but not named');
  assert.equal(makeBrokerPredicate({ only: 'A', retryFailedFromLog: new Set(['B']) })('B'), false);
});

test('makeBrokerPredicate: --skip always removes, whatever else selects (CLI2-2)', () => {
  // The rule used to be "retry-failed outranks skip" and "only outranks skip",
  // so `--retry-failed --skip A` re-ran A, the broker the user asked to leave out.
  assert.equal(makeBrokerPredicate({ retryFailedFromLog: new Set(['A']), skip: 'A' })('A'), false);
  assert.equal(makeBrokerPredicate({ retryFailedFromLog: new Set(['A', 'B']), skip: 'A' })('B'), true, 'the rest of the retry set still runs');
  assert.equal(makeBrokerPredicate({ only: 'A,B', skip: 'a' })('A'), false, 'case-insensitive, like every other name');
  assert.equal(makeBrokerPredicate({ only: 'A,B', skip: 'a' })('B'), true);
  assert.equal(makeBrokerPredicate({ only: 'A', retryFailedFromLog: new Set(['A']), skip: 'A' })('A'), false);
});

test('makeBrokerPredicate: --skip with nothing else selecting is unchanged', () => {
  const include = makeBrokerPredicate({ skip: 'A, b' });
  assert.equal(include('A'), false);
  assert.equal(include('B'), false);
  assert.equal(include('C'), true);
});

test('makeBrokerPredicate: a --only list that parses to nothing includes nothing', () => {
  // "--only ," must run nothing, never fall back to "run everything".
  const include = makeBrokerPredicate({ only: ',' });
  assert.equal(include('Spokeo'), false);
});

test('makeBrokerPredicate: nullish or blank broker names are never included under a filter', () => {
  const include = makeBrokerPredicate({ only: 'Spokeo' });
  assert.equal(include(undefined), false);
  assert.equal(include(''), false);
});

test('makeBrokerPredicate agrees with applyFilter for the same options', () => {
  const brokers = [{ name: 'Spokeo' }, { name: 'Radaris' }, { name: 'BeenVerified' }];
  const optionSets = [
    { only: 'spokeo,beenverified' },
    { skip: 'RADARIS' },
    { retryFailedFromLog: new Set(['Radaris']) },
    {},
  ];
  for (const opts of optionSets) {
    const include = makeBrokerPredicate(opts);
    assert.deepEqual(
      brokers.filter(b => include(b.name)).map(b => b.name),
      applyFilter(brokers, opts).map(b => b.name),
      JSON.stringify([...Object.keys(opts)]),
    );
  }
});

// ─── CORE-5: extractFailedBrokers against a real log ──────────────────────────

function silently(fn) {
  const original = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = original; }
}

test('extractFailedBrokers reads the entries logResult really writes (broker, not name)', () => {
  const { results, logResult, resetResults } = require('../lib/logger');
  resetResults();
  silently(() => {
    logResult('Spokeo', 'error', 'timeout');
    logResult('Radaris', 'captcha_failed', 'https://radaris.example/optout');
    logResult('BeenVerified', 'pending_confirm', 'check inbox');
    logResult('Whitepages', 'success');
  });

  const log = JSON.parse(JSON.stringify(results));
  const failed = extractFailedBrokers(log);

  assert.deepEqual([...failed].sort(), ['BeenVerified', 'Radaris', 'Spokeo']);
  resetResults();
});

test('extractFailedBrokers survives a write to disk and loadLastLog round trip', () => {
  const { results, logResult, resetResults } = require('../lib/logger');
  resetResults();
  silently(() => logResult('Spokeo', 'error', 'boom'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-filter-'));
  try {
    fs.writeFileSync(path.join(dir, 'run-2026-10-29T09-00-00.json'), JSON.stringify(results, null, 2));
    const failed = extractFailedBrokers(loadLastLog(dir));
    assert.ok(failed.has('Spokeo'), 'the retry set must contain the broker that errored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetResults();
  }
});

test('extractFailedBrokers still accepts the legacy {name} entry shape', () => {
  const failed = extractFailedBrokers({ errors: [{ name: 'Legacy' }], captchaFailed: [{ broker: 'New' }] });
  assert.deepEqual([...failed].sort(), ['Legacy', 'New']);
});

test('extractFailedBrokers prefers broker over name when both are present', () => {
  const failed = extractFailedBrokers({ errors: [{ broker: 'Real', name: 'Other' }] });
  assert.deepEqual([...failed], ['Real']);
});

test('extractFailedBrokers ignores entries with neither broker nor name', () => {
  const failed = extractFailedBrokers({ errors: [{ detail: 'x' }, null, {}] });
  assert.equal(failed.size, 0);
});
