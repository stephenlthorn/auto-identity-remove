/**
 * test/solve-budget-captcha.test.js
 *
 * Q2: the budget at the point of spending. A paid task is only created after the
 * budget agrees, handleCaptcha reports a used-up budget as 'capped' (and still lets
 * a person solve it), and the failure detail carries the numbers.
 *
 * axios.create is stubbed, so nothing reaches the network.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const captcha = require('../lib/captcha');
const { handleCaptcha, captchaFailureDetail, captchaConfigWarnings } = require('../lib/manual-captcha');
const { createSolveBudget } = require('../lib/solve-budget');
const { makeCaptchaPage, makeClock, humanSolves } = require('./manual-captcha-harness');

const KEY = 'CAP-SECRETKEY-0123456789';

function stubAxios() {
  const calls = [];
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/createTask')) return { data: { errorId: 0, taskId: `t${calls.length}` } };
      return { data: { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'tok', token: 'tok', userAgent: 'ua' } } };
    },
  };
}

async function withStubbedAxios(fn) {
  const stub = stubAxios();
  const axiosLib = require('axios');
  const original = axiosLib.create;
  const log = console.log;
  axiosLib.create = () => stub;
  console.log = () => {};
  try { await fn(stub); } finally { axiosLib.create = original; console.log = log; }
  return stub;
}

const v2Page = () => ({
  url: () => 'https://broker.example.com/optout',
  evaluate: async () => '6LdSITEKEY',
});

const creates = (stub) => stub.calls.filter(c => c.url.endsWith('/createTask'));

test('a solver creates a paid task only after the budget agrees', async () => {
  const budget = createSolveBudget({ cap: 2 });
  const capsolver = { apiKey: KEY, budget };
  const results = [];
  const stub = await withStubbedAxios(async () => {
    for (let i = 0; i < 3; i++) results.push(await captcha.solveRecaptcha(v2Page(), capsolver));
  });
  assert.equal(creates(stub).length, 2, 'two paid tasks, never a third');
  assert.deepEqual(results, [true, true, false]);
  assert.equal(budget.used(), 2);
  assert.equal(budget.refusals(), 1);
});

test('every solver type goes through the budget', async () => {
  const budget = createSolveBudget({ cap: 0 });
  const capsolver = { apiKey: KEY, budget };
  const stub = await withStubbedAxios(async () => {
    const page = { url: () => 'https://broker.example.com', evaluate: async () => ({ siteKey: '6L', awsKey: 'k' }) };
    await captcha.solveRecaptcha(page, capsolver);
    await captcha.solveHcaptcha(page, capsolver);
    await captcha.solveTurnstile(page, capsolver);
    await captcha.solveRecaptchaV3(page, capsolver, {});
    await captcha.solveAwsWaf(page, capsolver);
  });
  assert.equal(creates(stub).length, 0, 'a cap of 0 means no solver creates a task');
});

test('a solver with no budget behaves as before', async () => {
  const stub = await withStubbedAxios(async () => {
    assert.equal(await captcha.solveRecaptcha(v2Page(), { apiKey: KEY }), true);
  });
  assert.equal(creates(stub).length, 1);
});

test('a task the service refused to create still counts: the money question is settled at the call', async () => {
  const budget = createSolveBudget({ cap: 5 });
  const axiosLib = require('axios');
  const original = axiosLib.create;
  const log = console.log;
  axiosLib.create = () => ({ post: async () => ({ data: { errorId: 1, errorDescription: 'Key denied access' } }) });
  console.log = () => {};
  try {
    assert.equal(await captcha.solveRecaptcha(v2Page(), { apiKey: KEY, budget }), false);
  } finally { axiosLib.create = original; console.log = log; }
  assert.equal(budget.used(), 1);
});

// ── handleCaptcha ─────────────────────────────────────────────────────────────

const solverThatSpends = (budget) => async () => (await budget.reserve());

test('handleCaptcha: a used-up budget does not call the solver and answers capped', async () => {
  const budget = createSolveBudget({ cap: 1 });
  await budget.reserve();
  let called = 0;
  const outcome = await handleCaptcha(makeCaptchaPage({ type: 'recaptcha' }), {
    capsolver: { apiKey: KEY, budget },
    manual: false,
    solve: async () => { called += 1; return true; },
  });
  assert.equal(outcome, 'capped');
  assert.equal(called, 0);
});

test('handleCaptcha: with budget left the solver runs as before', async () => {
  const budget = createSolveBudget({ cap: 2 });
  const outcome = await handleCaptcha(makeCaptchaPage({ type: 'recaptcha' }), {
    capsolver: { apiKey: KEY, budget },
    manual: false,
    solve: solverThatSpends(budget),
  });
  assert.equal(outcome, 'solved');
  assert.equal(budget.used(), 1);
});

test('handleCaptcha: a used-up budget still lets a person solve it by hand', async () => {
  const budget = createSolveBudget({ cap: 0 });
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([humanSolves(5000)], page);
  const outcome = await handleCaptcha(page, {
    capsolver: { apiKey: KEY, budget },
    manual: true,
    solve: async () => { throw new Error('the paid solver must not be called'); },
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(outcome, 'solved');
});

test('handleCaptcha: a solver that was refused mid-solve reports capped, not a plain failure', async () => {
  const budget = createSolveBudget({ cap: 1 });
  const outcome = await handleCaptcha(makeCaptchaPage({ type: 'recaptcha' }), {
    capsolver: { apiKey: KEY, budget },
    manual: false,
    // Two callers raced for the last solve: this one lost at the call itself.
    solve: async () => { await budget.reserve(); await budget.reserve(); return false; },
  });
  assert.equal(outcome, 'capped');
});

test('handleCaptcha: a CAPTCHA the solver cannot do is never "capped" (the cap is not why)', async () => {
  const budget = createSolveBudget({ cap: 0 });
  const outcome = await handleCaptcha(makeCaptchaPage({ unsupported: 'datadome' }), {
    capsolver: { apiKey: KEY, budget },
    manual: false,
    solve: async () => false,
  });
  assert.equal(outcome, 'skipped');
});

test('handleCaptcha: no budget on the solver config changes nothing', async () => {
  const outcome = await handleCaptcha(makeCaptchaPage({ type: 'recaptcha' }), {
    capsolver: { apiKey: KEY },
    manual: false,
    solve: async () => false,
  });
  assert.equal(outcome, 'failed');
});

// ── wording ───────────────────────────────────────────────────────────────────

test('captchaFailureDetail: capped says "solve cap reached" with the numbers and how to retry', () => {
  const budget = createSolveBudget({ cap: 2 });
  budget.reserve(); budget.reserve();
  const detail = captchaFailureDetail({ outcome: 'capped', url: 'https://example.test/optout', budget });
  assert.ok(detail.startsWith('https://example.test/optout - '), 'the watcher opens manual URLs from the start of the detail');
  assert.match(detail, /solve cap reached \(2 of 2 used\)/);
  assert.match(detail, /aidr captchas/);
});

test('captchaConfigWarnings: a bad capsolver.maxSolvesPerRun is reported with the other CAPTCHA settings', () => {
  assert.deepEqual(captchaConfigWarnings({ capsolver: { maxSolvesPerRun: 3 } }), []);
  assert.deepEqual(captchaConfigWarnings({}), []);
  const warnings = captchaConfigWarnings({ capsolver: { maxSolvesPerRun: '3' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /maxSolvesPerRun/);
});
