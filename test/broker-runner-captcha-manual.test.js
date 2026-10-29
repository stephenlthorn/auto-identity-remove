/**
 * test/broker-runner-captcha-manual.test.js
 *
 * R1 (issue #16), runner side: a CAPTCHA broker no longer ends the moment the
 * paid solver is unavailable. At a desktop the window comes forward, the person
 * solves it, and the normal submit and post-submit classification continue; a
 * timeout is a captcha_failed that says why and how to retry; headless, dry-run,
 * preview and noise runs never wait.
 *
 * The CAPTCHA is a mutable page model (test/manual-captcha-harness.js), the human
 * is a script on a fake clock, and no real notification or solver is ever used.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');
const { makeCaptchaPage, makeClock, humanSolves } = require('./manual-captcha-harness');
const realManual = require('../lib/manual-captcha');

const URL_ = 'https://example.test/optout';
const BROKER = {
  name: 'CaptchaSite',
  method: 'direct-form',
  optOutUrl: URL_,
  submitSelector: 'button[type="submit"]',
  formFields: {},
  captchaLikely: true,
};
const SUBMIT = { id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true };
const PROBES = ['pageCaptchaType', 'readCaptchaState', 'pageHasDataDome', 'pageHasArkose', 'pageHasPerimeterX', 'pageHasAkamai'];

/** The harness page plus a CAPTCHA widget model: the probes answer from the model, everything else from the harness. */
function makeBrokerPage({ type = 'recaptcha', state = {}, url, before = 'Opt out of this site', after = 'Opt out of this site\nYour request has been received.' } = {}) {
  const elements = [{ ...SUBMIT }];
  const page = makePage({ elements, before, after });
  page.elements = elements;
  const widget = makeCaptchaPage({ type, state, url });
  const baseEvaluate = page.evaluate;
  page.evaluate = async (fn, arg) => (
    typeof fn === 'function' && PROBES.includes(fn.name) ? widget.evaluate(fn) : baseEvaluate(fn, arg)
  );
  page.model = widget.model;
  page.url = () => widget.model.url;
  page.isClosed = () => page.closed;
  page.bringToFront = async () => { widget.model.broughtToFront += 1; };
  return page;
}

function setup({ script = [], page = makeBrokerPage(), stubs = {}, config = {}, runnerConfig = {} } = {}) {
  const clock = makeClock(script, page);
  const seen = [];
  const toasts = [];
  const h = loadRunner({
    './manual-captcha': {
      ...realManual,
      handleCaptcha: (p, o) => {
        seen.push(o);
        return realManual.handleCaptcha(p, { ...o, now: clock.now, sleep: clock.sleep });
      },
    },
    './notify': { desktopNotify: (title, message) => toasts.push({ title, message }) },
    ...stubs,
  });
  h.runner.configure({
    person: PERSON,
    personCount: 1,
    capsolver: null,
    manual: true,
    headless: false,
    isTTY: true,
    config,
    ...runnerConfig,
  });
  return { h, page, clock, seen, toasts, run: (broker = BROKER) => h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON) };
}

// ── the feature: a person solves it, the broker succeeds ──────────────────────

test('R1: a person solves the CAPTCHA during the wait and the broker records success', async () => {
  const t = setup({ script: [humanSolves(25000)] });
  await t.run();

  assert.equal(t.h.logged.at(-1).status, 'success', JSON.stringify(t.h.logged));
  assert.equal(t.h.recorded.success.length, 1);
  assert.equal(t.h.recorded.failure.length, 0);
  assert.equal(t.page.model.broughtToFront, 1, 'the window must come to the front');
  assert.equal(t.page.clicks.length, 1, 'the tool still submits the form itself');
  assert.equal(t.toasts.length, 1, 'one desktop notification');
  assert.match(t.toasts[0].message, /CaptchaSite/);
});

test('R1: the wait uses captcha.manualTimeoutSec from the config', async () => {
  const t = setup({ config: { captcha: { manualTimeoutSec: 45 } }, script: [humanSolves(1000)] });
  await t.run();
  assert.equal(t.seen[0].timeoutMs, 45000);
  assert.equal(t.seen[0].manual, true);
  assert.equal(t.seen[0].broker.name, 'CaptchaSite');
});

test('R1: a solved CAPTCHA is still classified by what the submit produced (no evidence is still unverified)', async () => {
  const page = makeBrokerPage({ type: 'hcaptcha', before: 'Opt out', after: 'Opt out' });
  const t = setup({ page, script: [humanSolves(2000)] });
  await t.run();
  assert.equal(t.h.logged.at(-1).status, 'unverified');
  assert.equal(t.h.recorded.success.length, 0, 'solving a CAPTCHA is not a removal');
});

test('R1: --no-capsolver with manual solving on hands the CAPTCHA to the person instead of giving up', async () => {
  const t = setup({ runnerConfig: { noCapsolver: true, capsolver: { apiKey: 'CAP-TESTKEY12345678' } }, script: [humanSolves(5000)] });
  await t.run();
  assert.equal(t.h.logged.at(-1).status, 'success');
  assert.equal(t.seen[0].capsolver, null, 'the paid solver must stay off');
  assert.equal(t.h.calls.captcha.length, 0);
});

test('R1: when CapSolver fails, a person covers it', async () => {
  const t = setup({
    runnerConfig: { capsolver: { apiKey: 'CAP-TESTKEY12345678' } },
    stubs: { './captcha': { detectAndSolveCaptcha: async () => false } },
    script: [humanSolves(8000)],
  });
  await t.run();
  assert.equal(t.h.logged.at(-1).status, 'success');
  assert.equal(t.page.model.broughtToFront, 1);
});

// ── a person that never comes ─────────────────────────────────────────────────

test('R1: a timeout is captcha_failed with why and how to retry, and the run does not hang', async () => {
  const t = setup();
  await t.run();

  const last = t.h.logged.at(-1);
  assert.equal(last.status, 'captcha_failed');
  assert.ok(last.detail.startsWith(URL_), 'the watcher opens manual URLs from the start of the detail');
  assert.match(last.detail, /3 min/);
  assert.match(last.detail, /aidr captchas/);
  assert.deepEqual(t.h.recorded.failure, [{ name: 'CaptchaSite', kind: 'captcha_failed' }]);
  assert.equal(t.h.recorded.success.length, 0);
  assert.equal(t.page.clicks.length, 0, 'nothing is submitted past an unsolved CAPTCHA');
  assert.equal(t.page.closed, true);
  assert.ok(t.clock.t >= 180000 && t.clock.t < 200000, `fake clock ran out at ${t.clock.t}ms`);
});

// ── nobody at a screen ────────────────────────────────────────────────────────

test('R1: headless never waits and the detail says a display is needed', async () => {
  const t = setup({ runnerConfig: { manual: false, headless: true } });
  await t.run();
  const last = t.h.logged.at(-1);
  assert.equal(last.status, 'captcha_failed');
  assert.match(last.detail, /no display/i);
  assert.match(last.detail, /aidr captchas/);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(t.page.model.broughtToFront, 0);
  assert.equal(t.toasts.length, 0);
});

test('R1: manual off with no key says which setting to change', async () => {
  const t = setup({ runnerConfig: { manual: false }, config: { captcha: { manual: false } } });
  await t.run();
  assert.match(t.h.logged.at(-1).detail, /captcha\.manual/);
  assert.equal(t.clock.sleeps, 0);
});

test('R1: --no-capsolver with manual off keeps the old "manual" outcome and now says it is a CAPTCHA', async () => {
  const t = setup({ runnerConfig: { manual: false, noCapsolver: true } });
  await t.run();
  const last = t.h.logged.at(-1);
  assert.equal(last.status, 'manual');
  assert.ok(last.detail.startsWith(URL_));
  assert.match(last.detail, /CAPTCHA/);
  assert.equal(t.seen.length, 0);
});

// ── runs that never submit never wait ─────────────────────────────────────────

test('R1: dry-run never waits and never asks anyone', async () => {
  const t = setup({ runnerConfig: { dryRun: true } });
  await t.run();
  assert.equal(t.seen.length, 0);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(t.h.logged.at(-1).status, 'skipped');
});

test('R1: preview never waits and never asks anyone', async () => {
  const t = setup({ runnerConfig: { dryRun: true, preview: true } });
  await t.run();
  assert.equal(t.seen.length, 0);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(t.h.logged.at(-1).status, 'preview');
});

test('R1: a noise (bogus person) submission never asks a person to solve a CAPTCHA for fake data', async () => {
  const bogus = { ...PERSON, firstName: 'Fake', lastName: 'Person', isBogus: true };
  const page = makeBrokerPage();
  const t = setup({ page, runnerConfig: { brokersFor: () => [BROKER] } });
  await t.h.runner.processBrokerWithPerson(makeContext(page), BROKER, bogus);
  assert.equal(t.seen.length, 1);
  assert.equal(t.seen[0].manual, false);
  assert.equal(t.clock.sleeps, 0);
});

// ── the person submits the form themselves ────────────────────────────────────

/** The person clicks submit themselves: the site answers with a new page and the form is gone. */
const personSubmits = (at) => ({
  at,
  run: (p) => {
    p.model.type = null;
    p.model.url = 'https://example.test/thanks';
    p.submitted = true;
    p.elements[0].visible = false;
  },
});

test('R1: if the person submits the form during the wait, the thank-you page is classified (no second click)', async () => {
  const t = setup({ script: [personSubmits(12000)] });
  await t.run();

  assert.equal(t.h.logged.at(-1).status, 'success', JSON.stringify(t.h.logged));
  assert.equal(t.page.clicks.length, 0, 'the form is gone: nothing left to click');
  assert.equal(t.h.recorded.success.length, 1);
});

test('R1: a navigation that leaves the form in place is just the normal click path', async () => {
  const t = setup({
    script: [{ at: 6000, run: (p) => { p.model.url = 'https://example.test/optout?cf=1'; } }, humanSolves(8000)],
  });
  await t.run();
  assert.equal(t.h.logged.at(-1).status, 'success');
  assert.equal(t.page.clicks.length, 1, 'the form is still there, so the tool clicks it');
});

test('R1: a page the person landed on with no confirmation wording is unverified, never success', async () => {
  const page = makeBrokerPage({ after: 'Thanks for visiting. Browse our other pages.' });
  const t = setup({ page, script: [personSubmits(4000)] });
  await t.run();
  assert.equal(t.h.logged.at(-1).status, 'unverified');
  assert.equal(t.h.recorded.success.length, 0);
});

// ── plain brokers are untouched ───────────────────────────────────────────────

test('R1: a broker that is not captchaLikely never reaches the CAPTCHA step', async () => {
  const t = setup();
  await t.run({ ...BROKER, captchaLikely: false });
  assert.equal(t.seen.length, 0);
  assert.equal(t.clock.sleeps, 0);
  assert.equal(t.h.logged.at(-1).status, 'success');
});
