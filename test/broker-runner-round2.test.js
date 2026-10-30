/**
 * test/broker-runner-round2.test.js
 *
 * Round 2 of the broker-runner audit, against the stub harness:
 *
 *   BRK2-3   a form submitted while the CAPTCHA wait was on (by the person, or by the
 *            callback CapSolver fires) is never clicked a second time, and is never
 *            reported "nothing was submitted" because the form went away
 *   BRK2-5   a CAPTCHA that "went away" because the page was replaced is not solved
 *   CLI2-5   a closed browser fails THAT broker, not the run
 *   CLI2-10  a partial run writes no checkpoint
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
const PROBES = ['pageCaptchaType', 'readCaptchaState', 'readPageShape', 'pageHasDataDome', 'pageHasArkose', 'pageHasPerimeterX', 'pageHasAkamai'];

function makeBrokerPage({ before = 'Opt out of this site', after = 'Opt out of this site\nYour request has been received.' } = {}) {
  const elements = [{ ...SUBMIT }];
  const page = makePage({ elements, before, after });
  page.elements = elements;
  const widget = makeCaptchaPage({ type: 'recaptcha' });
  page.watchCount = 0;
  const baseEvaluate = page.evaluate;
  page.evaluate = async (fn, arg) => {
    if (typeof fn === 'function') {
      if (PROBES.includes(fn.name)) return widget.evaluate(fn);
      if (fn.name === 'installSubmitWatch') return true;
      if (fn.name === 'readSubmitWatch') return page.watchCount;
    }
    return baseEvaluate(fn, arg);
  };
  page.model = widget.model;
  page.url = () => widget.model.url;
  page.isClosed = () => page.closed;
  page.bringToFront = async () => {};
  return page;
}

function setup({ script = [], page = makeBrokerPage(), runnerConfig = {}, stubs = {} } = {}) {
  const clock = makeClock(script, page);
  const h = loadRunner({
    './manual-captcha': {
      ...realManual,
      handleCaptcha: (p, o) => realManual.handleCaptcha(p, { ...o, now: clock.now, sleep: clock.sleep }),
    },
    './notify': { desktopNotify() {} },
    ...stubs,
  });
  h.runner.configure({ person: PERSON, personCount: 1, capsolver: null, manual: true, headless: false, isTTY: true, config: {}, ...runnerConfig });
  return { h, page, clock, run: (broker = BROKER) => h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON) };
}

/** The person solves the CAPTCHA and presses Send themselves; the form is still on screen. */
const personSolvesAndSubmitsInPlace = (at) => ({ at, run: (p) => { p.model.state.token = true; p.watchCount = 1; p.submitted = true; } });

// ── BRK2-3 ────────────────────────────────────────────────────────────────────

test('BRK2-3: the person pressed Send during the wait and the form is still there: exactly zero clicks by the tool', async () => {
  const t = setup({ script: [personSolvesAndSubmitsInPlace(4000)] });
  await t.run();
  assert.equal(t.page.clicks.length, 0, 'a second click is a second request at the broker');
  assert.equal(t.h.logged.at(-1).status, 'success', JSON.stringify(t.h.logged));
  assert.equal(t.h.recorded.success.length, 1);
});

test('BRK2-3: the confirmation replaced the form (same URL): classified, not "nothing was submitted"', async () => {
  const t = setup({
    script: [{ at: 4000, run: (p) => { p.model.state.token = true; p.submitted = true; p.elements[0].visible = false; } }],
  });
  await t.run();
  assert.equal(t.page.clicks.length, 0);
  assert.notEqual(t.h.logged.at(-1).status, 'error', JSON.stringify(t.h.logged));
  assert.equal(t.h.logged.at(-1).status, 'success');
});

test('BRK2-3: a banner the CAPTCHA step put on the page is never taken for the broker\'s answer (the tool still submits once)', async () => {
  const page = makeBrokerPage({ before: 'Opt out of this site', after: 'Opt out of this site' });
  const t = setup({
    page,
    script: [{ at: 4000, run: (p) => { p.model.state.token = true; p.extraBody = 'Verification complete. Your request has been received.'; } }],
  });
  const baseEvaluate = page.evaluate;
  page.evaluate = async (fn, arg) => {
    const text = await baseEvaluate(fn, arg);
    return (typeof fn === 'function' && !fn.name && String(fn).includes('innerText') && page.extraBody) ? `${text}\n${page.extraBody}` : text;
  };
  await t.run();
  assert.equal(page.clicks.length, 1, 'the banner is not a submission');
  assert.equal(t.h.logged.at(-1).status, 'unverified', JSON.stringify(t.h.logged));
});

test('BRK2-3: a solve that leaves the page untouched is still submitted exactly once by the tool', async () => {
  const t = setup({ script: [humanSolves(4000)] });
  await t.run();
  assert.equal(t.page.clicks.length, 1);
  assert.equal(t.h.logged.at(-1).status, 'success');
});

test('BRK2-3: CapSolver\'s callback submitted the form: the tool does not click again', async () => {
  const page = makeBrokerPage();
  const t = setup({
    page,
    runnerConfig: { capsolver: { apiKey: 'CAP-TESTKEY12345678' }, manual: false },
    stubs: { './captcha': { detectAndSolveCaptcha: async () => { page.watchCount = 1; page.submitted = true; return true; } } },
  });
  await t.run();
  assert.equal(page.clicks.length, 0);
  assert.equal(t.h.logged.at(-1).status, 'success');
});

// ── BRK2-5 ────────────────────────────────────────────────────────────────────

test('BRK2-5: the page replaced by an error page during the wait is captcha_failed, not a submit of nothing', async () => {
  const t = setup({
    script: [{ at: 3000, run: (p) => { p.model.type = null; p.model.controls = 0; p.elements[0].visible = false; } }],
  });
  await t.run();
  const last = t.h.logged.at(-1);
  assert.equal(last.status, 'captcha_failed', JSON.stringify(t.h.logged));
  assert.deepEqual(t.h.recorded.failure, [{ name: 'CaptchaSite', kind: 'captcha_failed' }]);
  assert.equal(t.h.recorded.success.length, 0);
  assert.match(last.detail, /aidr captchas/);
});

// ── CLI2-5 ────────────────────────────────────────────────────────────────────

test('CLI2-5: a browser that closed under the run fails that broker with a clear detail instead of throwing', async () => {
  const h = loadRunner();
  h.runner.configure({ person: PERSON, personCount: 1, config: {} });
  const dead = { async newPage() { throw new Error('browserContext.newPage: Target page, context or browser has been closed'); } };
  const result = await h.runner.processBrokerWithPerson(dead, { ...BROKER, captchaLikely: false }, PERSON);
  const last = h.logged.at(-1);
  assert.equal(last.status, 'error');
  assert.match(last.detail, /browser closed/i);
  assert.equal(h.recorded.failure.length, 0, 'not the broker\'s fault: no failure count toward defunct');
  assert.equal(result && result.browserClosed, true, 'the caller can tell and relaunch');
});

// ── CLI2-10 ───────────────────────────────────────────────────────────────────

test('CLI2-10: a partial run (--only / --retry-failed / --captchas) never writes the checkpoint', async () => {
  const page = makeBrokerPage();
  const t = setup({ page, runnerConfig: { partial: true } });
  await t.run({ ...BROKER, captchaLikely: false });
  assert.deepEqual(t.h.recorded.checkpoints, []);
});

test('CLI2-10: a full run still writes it', async () => {
  const page = makeBrokerPage();
  const t = setup({ page });
  await t.run({ ...BROKER, captchaLikely: false });
  assert.deepEqual(t.h.recorded.checkpoints, ['CaptchaSite']);
});

// ── codex #8 ──────────────────────────────────────────────────────────────────

test('codex #8: a success snippet that echoes the person\'s details is redacted in the log line', async () => {
  const page = makeBrokerPage({
    before: 'Opt out of this site',
    after: 'Opt out of this site\nThanks Test User, your opt-out request has been received for test.user@example.com in zip 78701.',
  });
  const t = setup({ page, script: [humanSolves(1000)] });
  await t.run({ ...BROKER, captchaLikely: false });
  const last = t.h.logged.at(-1);
  assert.equal(last.status, 'success');
  for (const secret of ['test.user@example.com', 'Test User', '78701']) assert.ok(!last.detail.includes(secret), `${secret} leaked: ${last.detail}`);
  assert.match(last.detail, /opt-out request has been received/);
});

test('codex #8: the snippet that is recorded for a pending confirmation is redacted too', async () => {
  const page = makeBrokerPage({
    before: 'Opt out of this site',
    after: 'Opt out of this site\nWe sent a confirmation email to test.user@example.com. Check your email to confirm your request.',
  });
  const t = setup({ page });
  await t.run({ ...BROKER, captchaLikely: false });
  assert.equal(t.h.logged.at(-1).status, 'pending_confirm', JSON.stringify(t.h.logged));
  assert.ok(!t.h.logged.at(-1).detail.includes('test.user@example.com'));
  assert.equal(t.h.recorded.pending.length, 1);
  assert.ok(!String(t.h.recorded.pending[0].snippet).includes('test.user@example.com'), 'state.json must not keep the email');
});

test('codex #8: the relay alias the broker was shown is redacted as well', async () => {
  const page = makeBrokerPage({
    before: 'Opt out of this site',
    after: 'Opt out of this site\nYour opt-out request has been received. We wrote to hide.q1@relay.example.',
  });
  const t = setup({ page, runnerConfig: { submissionEmail: 'hide.q1@relay.example' } });
  await t.run({ ...BROKER, captchaLikely: false });
  assert.ok(!t.h.logged.at(-1).detail.includes('hide.q1@relay.example'), t.h.logged.at(-1).detail);
});
