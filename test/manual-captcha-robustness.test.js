/**
 * test/manual-captcha-robustness.test.js
 *
 * BRK2-4: a page that stops answering (a busy loop, a crashed renderer) must not
 * hang the CAPTCHA wait: every read is raced against the time that is left, and the
 * whole handling has a hard ceiling that closes the page.
 *
 * BRK2-5: "the challenge is gone" only means "solved" when the page is still the
 * form. A page replaced by a 502 or a thank-you page has no CAPTCHA either, and
 * calling that solved sent the runner on to a submit that had nothing to submit.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleCaptcha } = require('../lib/manual-captcha');
const { makeCaptchaPage, makeClock, humanSolves, widgetVanishes } = require('./manual-captcha-harness');

const BROKER = { name: 'CaptchaSite', optOutUrl: 'https://example.test/optout' };

// ── BRK2-4 ────────────────────────────────────────────────────────────────────

/** A page that answers normally until `hang()` is called, then never answers again. */
function hangingPage() {
  const inner = makeCaptchaPage({ type: 'recaptcha' });
  const page = {
    ...inner,
    hung: false,
    evaluations: 0,
    closes: [],
    async evaluate(fn) {
      page.evaluations += 1;
      if (page.hung) return new Promise(() => {});
      return inner.evaluate(fn);
    },
    async close(options) { page.closes.push(options); inner.model.closed = true; },
    isClosed: () => inner.model.closed,
  };
  page.hang = () => { page.hung = true; };
  return page;
}

test('BRK2-4: a page that stops responding mid-wait ends as timeout, not a hang', async () => {
  const page = hangingPage();
  setTimeout(() => page.hang(), 120);
  const t0 = Date.now();
  const outcome = await Promise.race([
    handleCaptcha(page, { manual: true, timeoutMs: 600, pollMs: 50, broker: BROKER, onWaiting() {} }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 6000)),
  ]);
  assert.equal(outcome, 'timeout');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms for a 600 ms wait`);
});

test('BRK2-4: while one read is still unanswered no further reads are queued behind it', async () => {
  const page = hangingPage();
  setTimeout(() => page.hang(), 100);
  await handleCaptcha(page, { manual: true, timeoutMs: 500, pollMs: 20, broker: BROKER, onWaiting() {} });
  const readsWhileHung = page.evaluations;
  assert.ok(readsWhileHung < 40, `${readsWhileHung} evaluations were issued; a stuck page must not collect a queue of them`);
});

test('BRK2-4: a page that never answers at all is cut off by the hard ceiling and closed', async () => {
  const page = hangingPage();
  page.hang();
  const t0 = Date.now();
  const outcome = await Promise.race([
    handleCaptcha(page, { manual: true, timeoutMs: 300, hardTimeoutMs: 800, pollMs: 50, broker: BROKER, onWaiting() {} }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 6000)),
  ]);
  assert.equal(outcome, 'timeout');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(page.closes.length, 1, 'the unusable page is closed');
  assert.deepEqual(page.closes[0], { runBeforeUnload: false });
});

test('BRK2-4: a normal solve is unaffected by the new bounds', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([humanSolves(2000)], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'solved');
});

// ── BRK2-5 ────────────────────────────────────────────────────────────────────

const replacedByErrorPage = (at) => ({ at, run: (page) => {
  page.model.type = null;
  page.model.unsupported = null;
  page.model.state.frame = false;
  page.model.state.humanText = false;
  page.model.controls = 0;
} });

test('BRK2-5: the page replaced by an error page (no CAPTCHA, no form) is not "solved"', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([replacedByErrorPage(300)], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'navigated');
});

test('BRK2-5: the page moving to another URL is not "solved" even when it has a form', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([{ at: 300, run: (p) => { p.model.url = 'https://example.test/somewhere-else'; widgetVanishes(0).run(p); } }], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'navigated');
});

test('BRK2-5: an interstitial that lets the visitor through on the same URL, form still there, is still solved', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([widgetVanishes(300)], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'solved');
});

test('BRK2-5: a token still wins whatever else changed', async () => {
  const page = makeCaptchaPage({ type: 'recaptcha' });
  const clock = makeClock([humanSolves(300)], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'solved');
});

test('BRK2-5: a full-page challenge that never had a form is solved when it lets the visitor through, even to another URL', async () => {
  const page = makeCaptchaPage({ type: null, state: { humanText: true }, controls: 0 });
  const clock = makeClock([{ at: 300, run: (p) => { p.model.state.humanText = false; p.model.url = 'https://example.test/home'; } }], page);
  const outcome = await handleCaptcha(page, { manual: true, broker: BROKER, now: clock.now, sleep: clock.sleep, onWaiting() {} });
  assert.equal(outcome, 'solved');
});
