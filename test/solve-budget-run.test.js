/**
 * test/solve-budget-run.test.js
 *
 * Q2, end to end: a run with `capsolver.maxSolvesPerRun` against fixture CAPTCHA
 * pages. The explicit runner and the generic pass share ONE budget (the same
 * solver config object carries it, as watcher.js hands it to both), and the
 * summary reports the count and, when both balance reads worked, the spend.
 *
 * The real solver code runs; only axios.create is stubbed, so no request leaves
 * the machine, and the paid tasks are counted at the (stubbed) service.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');
const { makeCaptchaPage } = require('./manual-captcha-harness');
const { makeFakePage, makeContext: makeGenericContext, optOutForm } = require('./helpers/generic-fake-page');
const captcha = require('../lib/captcha');
const manual = require('../lib/manual-captcha');
const gr = require('../generic-runner');
const sb = require('../lib/solve-budget');

const KEY = 'CAP-SECRETKEY-0123456789';
const PROBES = ['pageCaptchaType', 'readCaptchaState', 'pageHasDataDome', 'pageHasArkose', 'pageHasPerimeterX', 'pageHasAkamai'];

// ── the stubbed service ──────────────────────────────────────────────────────

async function withService(fn) {
  const calls = [];
  const stub = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/createTask')) return { data: { errorId: 0, taskId: `t${calls.length}` } };
      return { data: { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'tok' } } };
    },
  };
  const axiosLib = require('axios');
  const original = axiosLib.create;
  const log = console.log;
  axiosLib.create = () => stub;
  console.log = () => {};
  try { await fn(); } finally { axiosLib.create = original; console.log = log; }
  return { created: calls.filter(c => c.url.endsWith('/createTask')).length, calls };
}

// ── explicit runner ──────────────────────────────────────────────────────────

const brokerNamed = (name) => ({
  name,
  method: 'direct-form',
  optOutUrl: `https://${name.toLowerCase()}.example.test/optout`,
  submitSelector: 'button[type="submit"]',
  formFields: {},
  captchaLikely: true,
});

function explicitPage() {
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out of this site',
    after: 'Opt out of this site\nYour request has been received.',
  });
  const widget = makeCaptchaPage({ type: 'recaptcha' });
  const base = page.evaluate;
  page.evaluate = async (fn, arg) => {
    if (typeof fn === 'function' && PROBES.includes(fn.name)) return widget.evaluate(fn);
    if (typeof fn === 'function' && String(fn).includes('data-sitekey')) return '6LdSITEKEY';
    return base(fn, arg);
  };
  page.url = () => widget.model.url;
  page.isClosed = () => page.closed;
  return page;
}

function explicitRunner(capsolver, extra = {}) {
  const h = loadRunner({ './captcha': captcha });
  h.runner.configure({ person: PERSON, personCount: 1, capsolver, manual: false, headless: true, isTTY: false, config: {}, ...extra });
  return h;
}

async function runExplicit(h, names) {
  for (const name of names) {
    const page = explicitPage();
    await h.runner.processBrokerWithPerson(makeContext(page), brokerNamed(name), PERSON);
  }
}

test('a cap of 2 against three CAPTCHA brokers: two paid tasks, the third is captcha_failed with the cap reason', async () => {
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 2 } });
  const h = explicitRunner(capsolver);
  const service = await withService(() => runExplicit(h, ['One', 'Two', 'Three']));

  assert.equal(service.created, 2, 'exactly two paid tasks were created');
  const statuses = h.logged.map(l => l.status);
  assert.equal(statuses.filter(s => s === 'captcha_failed').length, 1, JSON.stringify(h.logged));
  const failed = h.logged.find(l => l.status === 'captcha_failed');
  assert.equal(failed.name, 'Three');
  assert.match(failed.detail, /solve cap reached \(2 of 2 used\)/);
  assert.ok(failed.detail.startsWith('https://three.example.test/optout'), 'the opt-out URL leads the detail');
  assert.deepEqual(h.recorded.failure, [{ name: 'Three', kind: 'captcha_failed' }]);
  assert.equal(budget.used(), 2);
});

test('the capped broker is found again by aidr captchas', async () => {
  const { capsolver } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 1 } });
  const h = explicitRunner(capsolver);
  await withService(() => runExplicit(h, ['One', 'Two']));
  const entries = h.logged.map(l => ({ broker: l.name, status: l.status, detail: l.detail }));
  assert.deepEqual([...manual.captchaBrokersFromLog(entries)], ['Two']);
});

test('no cap set: behaviour is unchanged, every CAPTCHA broker is solved', async () => {
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY } });
  const h = explicitRunner(capsolver);
  const service = await withService(() => runExplicit(h, ['One', 'Two', 'Three']));
  assert.equal(service.created, 3);
  assert.equal(h.logged.filter(l => l.status === 'captcha_failed').length, 0);
  assert.equal(budget.used(), 3);
});

for (const bad of [0, -1, 1.5, '2']) {
  test(`an invalid cap (${JSON.stringify(bad)}) is reported and no paid solve is made`, async () => {
    const config = { capsolver: { apiKey: KEY, maxSolvesPerRun: bad } };
    const { capsolver, warnings } = sb.budgetForRun(config);
    assert.equal(warnings.length, 1);
    assert.deepEqual(manual.captchaConfigWarnings(config), warnings, 'the same warning reaches config check and run start');

    const h = explicitRunner(capsolver);
    const service = await withService(() => runExplicit(h, ['One']));
    assert.equal(service.created, 0);
    assert.equal(h.logged.at(-1).status, 'captcha_failed');
    assert.match(h.logged.at(-1).detail, /solve cap reached \(0 of 0 used\)/);
  });
}

test('a person at a screen still solves by hand once the cap is used up', async () => {
  const { capsolver } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 1 } });
  await capsolver.budget.reserve();
  const { makeClock, humanSolves } = require('./manual-captcha-harness');
  const page = explicitPage();
  const widget = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([humanSolves(3000)], widget);
  const base = page.evaluate;
  page.evaluate = async (fn, arg) => (typeof fn === 'function' && PROBES.includes(fn.name) ? widget.evaluate(fn) : base(fn, arg));
  page.url = () => widget.model.url;
  const h = loadRunner({
    './captcha': captcha,
    './manual-captcha': { ...manual, handleCaptcha: (p, o) => manual.handleCaptcha(p, { ...o, now: clock.now, sleep: clock.sleep }) },
    './notify': { desktopNotify: () => {} },
  });
  h.runner.configure({ person: PERSON, personCount: 1, capsolver, manual: true, headless: false, isTTY: true, config: {} });
  const service = await withService(() => h.runner.processBrokerWithPerson(makeContext(page), brokerNamed('Hand'), PERSON));
  assert.equal(service.created, 0, 'no paid task');
  assert.notEqual(h.logged.at(-1).status, 'captcha_failed');
});

test('a dry run never spends and never counts', async () => {
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 2 } });
  const h = explicitRunner(capsolver, { dryRun: true });
  const service = await withService(() => runExplicit(h, ['One', 'Two']));
  assert.equal(service.created, 0);
  assert.equal(budget.used(), 0);
});

// ── generic pass: the same budget ────────────────────────────────────────────

const GENERIC_PERSON = { firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', email: 'jane@example.com', state: 'CA', zip: '90001' };

function genericPage() {
  const page = makeFakePage({
    forms: [optOutForm({
      fields: ['email', 'firstName', 'lastName', gr.CAPTCHA_IN_FORM_SELECTOR],
      afterSubmit: { body: 'Your request has been received.' },
    })],
  });
  const base = page.evaluate;
  page.evaluate = async (fn, arg) => {
    if (typeof fn === 'function' && fn.name === 'pageCaptchaType') return 'recaptcha';
    if (typeof fn === 'function' && String(fn).includes('data-sitekey')) return '6LdSITEKEY';
    return base(fn, arg);
  };
  return page;
}

/** What watcher.js builds for the generic pass, from the same solver config object. */
function genericHooks(capsolver) {
  return {
    handleCaptcha: (page, ctx) => manual.handleCaptcha(page, { capsolver, manual: false, solve: captcha.detectAndSolveCaptcha, ...ctx }),
    captchaFailureDetail: ({ outcome, broker }) => manual.captchaFailureDetail({
      outcome, url: broker && broker.url, headless: true, isTTY: false, config: {}, noSolver: false, budget: capsolver.budget,
    }),
  };
}

const runGeneric = (name, capsolver) => gr.processGenericUrl(
  genericPage(),
  { name, url: `https://${name.toLowerCase()}.example.test/opt-out`, source: 'markup' },
  { optOuts: {} }, false, new Set(),
  { person: GENERIC_PERSON, ...genericHooks(capsolver) },
);

test('the explicit runner and the generic pass draw from ONE budget', async () => {
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 2 } });
  const h = explicitRunner(capsolver);
  const generic = [];
  const service = await withService(async () => {
    await runExplicit(h, ['One']);
    generic.push(await runGeneric('GenA', capsolver));
    generic.push(await runGeneric('GenB', capsolver));
  });

  assert.equal(service.created, 2, 'one explicit solve plus one generic solve');
  assert.equal(h.logged.at(-1).status === 'captcha_failed', false, 'the explicit broker got its solve');
  assert.equal(generic[0].status, 'success');
  assert.equal(generic[1].status, 'captcha_failed');
  assert.match(generic[1].detail, /solve cap reached \(2 of 2 used\)/);
  assert.equal(budget.used(), 2);
});

test('generic pass with no cap solves every CAPTCHA form', async () => {
  const { capsolver } = sb.budgetForRun({ capsolver: { apiKey: KEY } });
  const results = [];
  const service = await withService(async () => {
    for (const n of ['GenA', 'GenB', 'GenC']) results.push(await runGeneric(n, capsolver));
  });
  assert.equal(service.created, 3);
  assert.deepEqual(results.map(r => r.status), ['success', 'success', 'success']);
});

// ── the summary ──────────────────────────────────────────────────────────────

function balances(values) {
  const queue = [...values];
  return async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { data: next === undefined ? { errorId: 1 } : { errorId: 0, balance: next } };
  };
}

test('reportSolves: prints the count, the cap and the spend when both balance reads worked', async () => {
  const post = balances([5, 4.99]);
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY, maxSolvesPerRun: 2 } }, { post });
  const h = explicitRunner(capsolver);
  await withService(() => runExplicit(h, ['One', 'Two', 'Three']));

  const lines = [];
  const end = await sb.reportSolves(budget, (l) => lines.push(l));
  assert.equal(end.used, 2);
  assert.ok(Math.abs(end.spend - 0.01) < 1e-9);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 solves used \(cap 2\)/);
  assert.match(lines[0], /spend about \$0\.0100/);
  assert.ok(!lines[0].includes(KEY), 'the API key is never printed');
});

test('reportSolves: when the balance cannot be read it prints the count and says the spend is unknown', async () => {
  const post = async () => { throw new Error(`offline for ${KEY}`); };
  const { capsolver, budget } = sb.budgetForRun({ capsolver: { apiKey: KEY } }, { post });
  const h = explicitRunner(capsolver);
  await withService(() => runExplicit(h, ['One']));
  const lines = [];
  await sb.reportSolves(budget, (l) => lines.push(l));
  assert.match(lines[0], /1 solve used \(no cap\)/);
  assert.match(lines[0], /spend unknown/);
  assert.ok(!lines[0].includes(KEY));
});

test('reportSolves: a run that never used the solver prints nothing and reads no balance', async () => {
  let reads = 0;
  const post = async () => { reads += 1; return { data: { errorId: 0, balance: 1 } }; };
  const { budget } = sb.budgetForRun({ capsolver: { apiKey: KEY } }, { post });
  const lines = [];
  await sb.reportSolves(budget, (l) => lines.push(l));
  assert.deepEqual(lines, []);
  assert.equal(reads, 0);
});
