/**
 * test/solve-budget.test.js
 *
 * Q2: one solve budget per run. A solve is counted when a paid task is created,
 * the cap is optional, a bad cap means "no paid solve allowed", and the spend is
 * a balance difference, never a price table.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sb = require('../lib/solve-budget');

test('parseMaxSolves: unset means no cap', () => {
  assert.deepEqual(sb.parseMaxSolves(undefined), { cap: null, problem: null });
  assert.deepEqual(sb.parseMaxSolves(null), { cap: null, problem: null });
});

test('parseMaxSolves: a whole number of 1 or more is the cap', () => {
  assert.deepEqual(sb.parseMaxSolves(1), { cap: 1, problem: null });
  assert.deepEqual(sb.parseMaxSolves(25), { cap: 25, problem: null });
});

test('parseMaxSolves: anything else is a problem and the cap becomes 0 (no paid solve)', () => {
  for (const bad of [0, -3, 1.5, '5', '', 'many', NaN, Infinity, true, [], {}]) {
    const r = sb.parseMaxSolves(bad);
    assert.equal(r.cap, 0, `cap for ${JSON.stringify(bad)}`);
    assert.match(r.problem, /capsolver\.maxSolvesPerRun/);
  }
});

test('solveCapWarnings: reads capsolver.maxSolvesPerRun and says what is used instead', () => {
  assert.deepEqual(sb.solveCapWarnings({ capsolver: { apiKey: 'k' } }), []);
  assert.deepEqual(sb.solveCapWarnings(null), []);
  assert.deepEqual(sb.solveCapWarnings({ capsolver: { maxSolvesPerRun: 3 } }), []);
  const [w] = sb.solveCapWarnings({ capsolver: { maxSolvesPerRun: 0 } });
  assert.match(w, /whole number of 1 or more/);
  assert.match(w, /no paid solve/);
});

test('budget: no cap never refuses and still counts', async () => {
  const b = sb.createSolveBudget({ cap: null });
  for (let i = 0; i < 5; i++) assert.equal(await b.reserve(), true);
  assert.equal(b.used(), 5);
  assert.equal(b.exhausted(), false);
});

test('budget: refuses after the cap and does not count a refusal as a solve', async () => {
  const b = sb.createSolveBudget({ cap: 2 });
  assert.equal(await b.reserve(), true);
  assert.equal(await b.reserve(), true);
  assert.equal(b.exhausted(), true);
  assert.equal(await b.reserve(), false);
  assert.equal(b.used(), 2);
  assert.equal(b.refusals(), 1);
});

test('budget: a cap of 0 refuses the very first solve', async () => {
  const b = sb.createSolveBudget({ cap: 0 });
  assert.equal(b.exhausted(), true);
  assert.equal(await b.reserve(), false);
  assert.equal(b.used(), 0);
});

test('describeCapReached: carries the numbers', () => {
  const b = sb.createSolveBudget({ cap: 2 });
  b.reserve(); b.reserve();
  assert.equal(sb.describeCapReached(b), 'solve cap reached (2 of 2 used)');
});

test('budget: the balance is read once before the first solve and once at the end', async () => {
  const reads = [];
  const balances = [5.0, 4.99];
  const b = sb.createSolveBudget({ cap: 5, fetchBalance: async () => { reads.push('read'); return balances.shift(); } });
  assert.equal(reads.length, 0, 'nothing is read before a solve');
  await b.reserve();
  await b.reserve();
  assert.equal(reads.length, 1, 'only the first solve triggers the start read');
  const end = await b.finish();
  assert.equal(reads.length, 2);
  assert.equal(end.used, 2);
  assert.equal(end.cap, 5);
  assert.ok(Math.abs(end.spend - 0.01) < 1e-9);
});

test('budget: a run that never solved never reads the balance', async () => {
  let reads = 0;
  const b = sb.createSolveBudget({ cap: 5, fetchBalance: async () => { reads += 1; return 1; } });
  const end = await b.finish();
  assert.equal(reads, 0);
  assert.deepEqual(end, { used: 0, cap: 5, spend: null });
});

test('budget: an unreadable balance means the spend is unknown, never zero', async () => {
  const b = sb.createSolveBudget({ cap: null, fetchBalance: async () => { throw new Error('offline'); } });
  await b.reserve();
  assert.equal((await b.finish()).spend, null);
  const none = sb.createSolveBudget({ cap: null });
  await none.reserve();
  assert.equal((await none.finish()).spend, null);
});

test('budget: a balance that went UP (a top-up mid-run) is unknown spend', async () => {
  const balances = [1, 9];
  const b = sb.createSolveBudget({ cap: null, fetchBalance: async () => balances.shift() });
  await b.reserve();
  assert.equal((await b.finish()).spend, null);
});

test('budget: an end read that fails after a good start read is unknown', async () => {
  let n = 0;
  const b = sb.createSolveBudget({ cap: null, fetchBalance: async () => { n += 1; if (n === 2) throw new Error('x'); return 3; } });
  await b.reserve();
  assert.equal((await b.finish()).spend, null);
});

test('summaryLines: count, cap and spend; no price table', () => {
  assert.deepEqual(sb.summaryLines({ used: 0, cap: 2, spend: null }), []);
  assert.deepEqual(sb.summaryLines({ used: 2, cap: 2, spend: 0.0042 }), [
    'CapSolver: 2 solves used (cap 2), spend about $0.0042 (balance difference)',
  ]);
  assert.deepEqual(sb.summaryLines({ used: 1, cap: null, spend: null }), [
    'CapSolver: 1 solve used (no cap), spend unknown (the balance could not be read)',
  ]);
});

test('readBalance: posts the key to getBalance and returns the number', async () => {
  const seen = [];
  const post = async (url, body) => { seen.push({ url, body }); return { data: { errorId: 0, balance: 1.25 } }; };
  assert.equal(await sb.readBalance('KEY', { post }), 1.25);
  assert.equal(seen[0].url, 'https://api.capsolver.com/getBalance');
  assert.deepEqual(seen[0].body, { clientKey: 'KEY' });
});

test('readBalance: an error response or junk is null, and the key never escapes', async () => {
  assert.equal(await sb.readBalance('KEY', { post: async () => ({ data: { errorId: 1, errorDescription: 'bad KEY' } }) }), null);
  assert.equal(await sb.readBalance('KEY', { post: async () => ({ data: { errorId: 0, balance: 'lots' } }) }), null);
  assert.equal(await sb.readBalance('KEY', { post: async () => { throw new Error('boom KEY'); } }), null);
  assert.equal(await sb.readBalance('', { post: async () => { throw new Error('never'); } }), null);
});

test('budgetForRun: no cap set gives an uncapped budget and the solver config carries it', () => {
  const cfg = { capsolver: { apiKey: 'CAP-REALKEY12345678' } };
  const { budget, capsolver, warnings } = sb.budgetForRun(cfg);
  assert.equal(budget.cap, null);
  assert.equal(capsolver.budget, budget);
  assert.equal(capsolver.apiKey, 'CAP-REALKEY12345678');
  assert.deepEqual(warnings, []);
  assert.equal(cfg.capsolver.budget, undefined, 'the config object itself is not changed');
});

test('budgetForRun: a good cap, and a bad cap that allows no paid solve', () => {
  assert.equal(sb.budgetForRun({ capsolver: { maxSolvesPerRun: 2 } }).budget.cap, 2);
  const bad = sb.budgetForRun({ capsolver: { maxSolvesPerRun: -1 } });
  assert.equal(bad.budget.cap, 0);
  assert.equal(bad.warnings.length, 1);
});

test('budgetForRun: no capsolver section means no solver config at all', () => {
  assert.equal(sb.budgetForRun({}).capsolver, null);
  assert.equal(sb.budgetForRun(null).capsolver, null);
});

test('budgetForRun: the balance reader uses the configured key and a placeholder key reads nothing', async () => {
  const seen = [];
  const post = async (url, body) => { seen.push(body.clientKey); return { data: { errorId: 0, balance: 2 } }; };
  const real = sb.budgetForRun({ capsolver: { apiKey: 'CAP-REALKEY12345678' } }, { post });
  await real.budget.reserve();
  assert.deepEqual(seen, ['CAP-REALKEY12345678']);
  const fake = sb.budgetForRun({ capsolver: { apiKey: 'CAP-YOUR_KEY_HERE' } }, { post });
  await fake.budget.reserve();
  assert.equal(seen.length, 1, 'a placeholder key is never sent to the service');
});

test('finish: asked twice it answers the same and reads the end balance once', async () => {
  let reads = 0;
  const b = sb.createSolveBudget({ cap: null, fetchBalance: async () => { reads += 1; return reads === 1 ? 3 : 2.5; } });
  await b.reserve();
  const a = await b.finish();
  const c = await b.finish();
  assert.deepEqual(a, c);
  assert.equal(reads, 2);
});

test('runLogSolves: the numbers that go into the run log, nothing when the solver was not used', () => {
  assert.equal(sb.runLogSolves({ used: 0, cap: 2, spend: null }), undefined);
  assert.deepEqual(sb.runLogSolves({ used: 2, cap: 2, spend: 0.01 }), { used: 2, cap: 2, spendUsd: 0.01 });
  assert.deepEqual(sb.runLogSolves({ used: 1, cap: null, spend: null }), { used: 1, cap: null, spendUsd: null });
});
