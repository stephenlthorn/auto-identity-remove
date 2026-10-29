/**
 * test/manual-captcha-handle.test.js
 *
 * R1 (issue #16): handleCaptcha is the one place that decides what to do when a
 * form shows a CAPTCHA. It must (1) leave a clean page alone, (2) let a usable
 * CapSolver key go first, (3) otherwise bring the window forward and wait for a
 * person, (4) never hang, never throw because the page navigated, and never call
 * a person's solved CAPTCHA a failure or an unsolved one a success.
 *
 * Time is a fake clock and the "human" is a script, so a 3-minute wait is instant.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleCaptcha } = require('../lib/manual-captcha');
const { makeCaptchaPage, makeClock, humanSolves, widgetVanishes } = require('./manual-captcha-harness');

const BROKER = { name: 'CaptchaSite', optOutUrl: 'https://example.test/optout', captchaLikely: true, recaptchaV3Action: 'optout' };
const REAL_KEY = { apiKey: 'CAP-TESTKEY12345678' };

function setup({ spec = {}, script = [], options = {} } = {}) {
  const page = makeCaptchaPage(spec);
  const clock = makeClock(script, page);
  const waiting = [];
  const solverCalls = [];
  const solve = options.solve || (async (p, capsolver, broker) => { solverCalls.push({ capsolver, broker }); return options.solverResult ?? false; });
  const run = (extra = {}) => handleCaptcha(page, {
    capsolver: null,
    manual: false,
    broker: BROKER,
    onWaiting: (info) => waiting.push(info),
    now: clock.now,
    sleep: clock.sleep,
    solve,
    ...options.base,
    ...extra,
  });
  return { page, clock, waiting, solverCalls, run };
}

// ── nothing to do ──────────────────────────────────────────────────────────────

test('a page without a CAPTCHA is left alone: none, no window stolen, no solver call, no wait', async () => {
  const t = setup({ spec: { type: null } });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: true }), 'none');
  assert.equal(t.page.model.broughtToFront, 0);
  assert.equal(t.waiting.length, 0);
  assert.equal(t.solverCalls.length, 0);
  assert.equal(t.clock.sleeps, 0);
});

// ── the paid solver goes first ─────────────────────────────────────────────────

test('a usable CapSolver key is tried first and a success never bothers the person', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, options: { solverResult: true } });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: true }), 'solved');
  assert.equal(t.solverCalls.length, 1);
  assert.deepEqual(t.solverCalls[0].capsolver, REAL_KEY);
  assert.equal(t.solverCalls[0].broker.recaptchaV3Action, 'optout', 'the broker must reach the solver (v3 pageAction)');
  assert.equal(t.page.model.broughtToFront, 0);
  assert.equal(t.waiting.length, 0);
});

test('when the solver fails, a person gets a turn and a token ends the wait as solved', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(7000)], options: { solverResult: false } });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: true }), 'solved');
  assert.equal(t.solverCalls.length, 1);
  assert.equal(t.page.model.broughtToFront, 1);
  assert.equal(t.waiting.length, 1);
});

test('a throwing solver is a failed solver, not a crashed run: the person still gets a turn', async () => {
  const t = setup({
    spec: { type: 'hcaptcha' },
    script: [humanSolves(3000)],
    options: { solve: async () => { throw new Error('page.evaluate: Target closed'); } },
  });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: true }), 'solved');
});

test('a placeholder key counts as no key: the solver is not called', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(2000)] });
  assert.equal(await t.run({ capsolver: { apiKey: 'CAP-YOUR_KEY_HERE' }, manual: true }), 'solved');
  assert.equal(t.solverCalls.length, 0);
});

test('the solver is never offered a challenge it cannot read (text-only interstitial)', async () => {
  const t = setup({
    spec: { type: null, state: { humanText: true } },
    script: [widgetVanishes(3000)],
    options: { solverResult: true },
  });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: true }), 'solved');
  assert.equal(t.solverCalls.length, 0, 'the solver returns true for "no CAPTCHA found", which would hide this challenge');
});

// ── nobody to ask ──────────────────────────────────────────────────────────────

test('solver failed and manual is off: failed, and the window is never stolen', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, options: { solverResult: false } });
  assert.equal(await t.run({ capsolver: REAL_KEY, manual: false }), 'failed');
  assert.equal(t.page.model.broughtToFront, 0);
  assert.equal(t.waiting.length, 0);
  assert.equal(t.clock.sleeps, 0, 'a headless or unattended run must not wait');
});

test('no key and manual off: skipped (neither a solver nor a person applies)', async () => {
  const t = setup({ spec: { type: 'turnstile' } });
  assert.equal(await t.run({ capsolver: null, manual: false }), 'skipped');
  assert.equal(t.waiting.length, 0);
  assert.equal(t.clock.sleeps, 0);
});

// ── waiting for a person ───────────────────────────────────────────────────────

test('bring the page forward and announce the wait once, with the broker and the timeout', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(4000)] });
  await t.run({ manual: true, timeoutMs: 120000 });
  assert.equal(t.page.model.broughtToFront, 1);
  assert.equal(t.waiting.length, 1);
  assert.equal(t.waiting[0].broker, BROKER);
  assert.equal(t.waiting[0].timeoutSec, 120);
});

test('the default wait is three minutes', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(4000)] });
  await t.run({ manual: true });
  assert.equal(t.waiting[0].timeoutSec, 180);
});

for (const [label, type] of [['reCAPTCHA', 'recaptcha'], ['hCaptcha', 'hcaptcha'], ['Turnstile', 'turnstile']]) {
  test(`${label}: a filled response field means the person solved it`, async () => {
    const t = setup({ spec: { type }, script: [humanSolves(9000)] });
    assert.equal(await t.run({ manual: true }), 'solved');
    assert.ok(t.clock.t >= 9000 && t.clock.t < 12000, `returned promptly after the token appeared (at ${t.clock.t}ms)`);
  });
}

test('a token that is already there when the wait starts is accepted without waiting', async () => {
  const t = setup({ spec: { type: 'recaptcha', state: { token: true } } });
  assert.equal(await t.run({ manual: true }), 'solved');
  assert.equal(t.clock.sleeps, 0);
});

test('a widget that disappears without a token counts as solved once the page is steady', async () => {
  const t = setup({ spec: { type: 'turnstile' }, script: [widgetVanishes(5000)] });
  assert.equal(await t.run({ manual: true }), 'solved');
  assert.ok(t.clock.t >= 5000);
});

test('a page that is still loading and shows no widget is not "gone" yet', async () => {
  const t = setup({
    spec: { type: 'recaptcha' },
    script: [
      { at: 3000, run: (p) => { p.model.type = null; p.model.state.ready = false; } },
      { at: 8000, run: (p) => { p.model.type = 'recaptcha'; p.model.state.ready = true; } },
      humanSolves(12000),
    ],
  });
  assert.equal(await t.run({ manual: true }), 'solved');
  assert.ok(t.clock.t >= 12000, `must not report solved while the page was merely loading (returned at ${t.clock.t}ms)`);
});

test('an unattended wait ends in timeout and never hangs', async () => {
  const t = setup({ spec: { type: 'recaptcha' } });
  assert.equal(await t.run({ manual: true, timeoutMs: 30000 }), 'timeout');
  assert.ok(t.clock.t >= 30000 && t.clock.t <= 32000, `waited about the timeout, not far past it (${t.clock.t}ms)`);
});

test('a stuck clock cannot hang the wait: the poll count is bounded too', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const result = await handleCaptcha(page, {
    manual: true,
    broker: BROKER,
    timeoutMs: 5000,
    now: () => 0,
    sleep: async () => {},
    solve: async () => false,
  });
  assert.equal(result, 'timeout');
});

test('navigation during the wait is tolerated, not thrown and not read as solved', async () => {
  const t = setup({ spec: { type: 'recaptcha', evalFailures: 0 }, script: [
    { at: 2000, run: (p) => { p.model.evalFailures = 3; } },
    humanSolves(9000),
  ] });
  assert.equal(await t.run({ manual: true }), 'solved');
  assert.ok(t.clock.t >= 9000, `three failed reads must not end the wait early (${t.clock.t}ms)`);
});

test('a page that keeps failing to answer ends as a timeout, not an exception', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [{ at: 1000, run: (p) => { p.model.evalFailures = 1e9; } }] });
  assert.equal(await t.run({ manual: true, timeoutMs: 10000 }), 'timeout');
});

test('the person closing the window ends the wait as failed', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [{ at: 6000, run: (p) => { p.model.closed = true; } }] });
  assert.equal(await t.run({ manual: true }), 'failed');
  assert.ok(t.clock.t < 10000, 'no point waiting out the clock on a closed window');
});

test('a broken notification or bringToFront must not break the wait', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(3000)] });
  t.page.bringToFront = async () => { throw new Error('no window server'); };
  assert.equal(await t.run({ manual: true, onWaiting: () => { throw new Error('notifier exploded'); } }), 'solved');
});

test('a page without bringToFront (minimal stub) still waits', async () => {
  const t = setup({ spec: { type: 'recaptcha' }, script: [humanSolves(3000)] });
  delete t.page.bringToFront;
  assert.equal(await t.run({ manual: true }), 'solved');
});

// ── challenges a person cannot act on ──────────────────────────────────────────

test('invisible reCAPTCHA v3 has nothing to click: no wait, skipped', async () => {
  const t = setup({ spec: { type: 'recaptcha-v3' } });
  assert.equal(await t.run({ manual: true }), 'skipped');
  assert.equal(t.clock.sleeps, 0);
  assert.equal(t.page.model.broughtToFront, 0);
});

test('a bot-manager script with no visible challenge (DataDome, PerimeterX, Akamai) is skipped, not waited on', async () => {
  for (const unsupported of ['datadome', 'perimeterx', 'akamai']) {
    const t = setup({ spec: { type: null, unsupported } });
    assert.equal(await t.run({ manual: true }), 'skipped', unsupported);
    assert.equal(t.clock.sleeps, 0, unsupported);
  }
});

test('a DataDome or Arkose challenge that IS on screen is waited on and can be solved by hand', async () => {
  for (const unsupported of ['datadome', 'arkose']) {
    const t = setup({ spec: { type: null, unsupported, state: { frame: true } }, script: [widgetVanishes(6000)] });
    assert.equal(await t.run({ manual: true }), 'solved', unsupported);
    assert.equal(t.waiting.length, 1, unsupported);
  }
});

test('a plain "verify you are human" page is waited on until the challenge is gone', async () => {
  const t = setup({ spec: { type: null, state: { humanText: true } }, script: [widgetVanishes(15000)] });
  assert.equal(await t.run({ manual: true }), 'solved');
  assert.ok(t.clock.t >= 15000);
});

// ── pages that cannot answer the probe ─────────────────────────────────────────

test('a page that cannot answer the probe falls back to the solver-only behaviour of old', async () => {
  const unreadable = { async evaluate() { return ''; }, url: () => 'x' };
  const calls = [];
  const solved = await handleCaptcha(unreadable, {
    capsolver: null, manual: true, broker: BROKER,
    solve: async (p, c, b) => { calls.push([c, b]); return true; },
  });
  assert.equal(solved, 'solved');
  assert.equal(calls.length, 1);
  const failed = await handleCaptcha(unreadable, {
    capsolver: null, manual: true, broker: BROKER, solve: async () => false,
  });
  assert.equal(failed, 'failed', 'an unreadable page cannot be waited on');
});
