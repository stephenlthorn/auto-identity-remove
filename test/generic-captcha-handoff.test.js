/**
 * test/generic-captcha-handoff.test.js
 *
 * R2 (generic side of R1's CAPTCHA contract): the generic runner used to fill an
 * opt-out form and click submit without ever noticing a CAPTCHA, so the broker
 * either rejected the empty challenge or, worse, the run guessed at the result.
 *
 * Now, when the form it is about to submit contains a CAPTCHA widget (reCAPTCHA,
 * hCaptcha or Turnstile frame / container / response field, in the form or as a
 * visible widget on the page):
 *
 *   opts.handleCaptcha given  -> handleCaptcha(page, { broker }) runs AFTER the
 *       form is filled (so a person solving it by hand only has the CAPTCHA left)
 *       and BEFORE the click. 'none' and 'solved' submit as usual; anything else
 *       ('failed', 'timeout', 'skipped', a throw, an unknown value) is
 *       'captcha_failed' for that broker: no submit, no success.
 *   no handleCaptcha          -> 'captcha_failed' at once, nothing typed or sent.
 *
 * `handleCaptcha` here is a stub of lib/manual-captcha.js (R1).
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext, optOutForm } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001',
};
const BROKER = { name: 'CaptchaBroker', url: 'https://broker.example/opt-out', source: 'markup' };

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-captcha-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SUCCESS = { body: 'Your request has been received.' };

/** An opt-out form with (or without) a CAPTCHA widget inside it. */
const form = ({ captcha = true, afterSubmit = SUCCESS } = {}) => optOutForm({
  fields: ['email', 'firstName', 'lastName', ...(captcha ? [gr.CAPTCHA_IN_FORM_SELECTOR] : [])],
  afterSubmit,
});

const run = (page, opts = {}, dryRun = false) =>
  gr.processGenericUrl(page, BROKER, { optOuts: {} }, dryRun, new Set(), { person: PERSON, ...opts });

/** A stub handleCaptcha that records what it saw and what the page looked like. */
function stubHandler(outcome, { onCall } = {}) {
  const calls = [];
  const handleCaptcha = async (page, ctx) => {
    calls.push({ ctx, filledBefore: page.filled.length, clickedBefore: page.clicked.length });
    if (onCall) onCall(page);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { handleCaptcha, calls };
}

// ── no CAPTCHA: nothing changes ──────────────────────────────────────────────

test('a form with no CAPTCHA never calls handleCaptcha and submits as before', async () => {
  const page = makeFakePage({ forms: [form({ captcha: false })] });
  const { handleCaptcha, calls } = stubHandler('solved');
  const result = await run(page, { handleCaptcha });
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 0);
  assert.ok(page.clicked.length > 0);
});

test('with no handleCaptcha and no CAPTCHA the form submits as before', async () => {
  const page = makeFakePage({ forms: [form({ captcha: false })] });
  assert.equal((await run(page)).status, 'success');
});

// ── CAPTCHA, no handler ──────────────────────────────────────────────────────

test('a CAPTCHA on the form with no handleCaptcha is captcha_failed: nothing typed, nothing sent', async () => {
  const page = makeFakePage({ forms: [form()] });
  const result = await run(page);
  assert.equal(result.status, 'captcha_failed');
  assert.match(result.detail, /captcha/i);
  assert.deepEqual(page.filled, [], 'the person\'s details are not typed into a form that cannot be sent');
  assert.deepEqual(page.clicked, [], 'and nothing is submitted');
});

// ── CAPTCHA, with a handler ──────────────────────────────────────────────────

test('solved: handleCaptcha runs after the form is filled and before the click, then the form submits', async () => {
  const page = makeFakePage({ forms: [form()] });
  const { handleCaptcha, calls } = stubHandler('solved');
  const result = await run(page, { handleCaptcha });
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].filledBefore > 0, 'the form was already filled, so a human only has the CAPTCHA left');
  assert.equal(calls[0].clickedBefore, 0, 'and nothing was submitted yet');
  assert.ok(page.clicked.length > 0, 'it submitted afterwards');
});

test('the handler gets the page and the broker row', async () => {
  const page = makeFakePage({ forms: [form()] });
  const { handleCaptcha, calls } = stubHandler('solved');
  await run(page, { handleCaptcha });
  assert.deepEqual(calls[0].ctx, { broker: BROKER });
});

test('none: the handler found nothing to solve, so the form submits', async () => {
  const page = makeFakePage({ forms: [form()] });
  const { handleCaptcha } = stubHandler('none');
  assert.equal((await run(page, { handleCaptcha })).status, 'success');
});

for (const outcome of ['failed', 'timeout', 'skipped']) {
  test(`${outcome}: captcha_failed, nothing submitted`, async () => {
    const page = makeFakePage({ forms: [form()] });
    const { handleCaptcha } = stubHandler(outcome);
    const result = await run(page, { handleCaptcha });
    assert.equal(result.status, 'captcha_failed');
    assert.ok(result.detail.includes(outcome), `the detail says why: ${result.detail}`);
    assert.deepEqual(page.clicked, [], 'a CAPTCHA that was not solved is never submitted into');
  });
}

test('an unknown handler result is treated as unsolved (fail closed)', async () => {
  for (const weird of [undefined, null, true, 'maybe', 0]) {
    const page = makeFakePage({ forms: [form()] });
    const { handleCaptcha } = stubHandler(weird);
    const result = await run(page, { handleCaptcha });
    assert.equal(result.status, 'captcha_failed', `result ${String(weird)}`);
    assert.deepEqual(page.clicked, []);
  }
});

test('a handler that throws is captcha_failed, never an uncaught error and never a submit', async () => {
  const page = makeFakePage({ forms: [form()] });
  const { handleCaptcha } = stubHandler(new Error('solver exploded'));
  const result = await run(page, { handleCaptcha });
  assert.equal(result.status, 'captcha_failed');
  assert.deepEqual(page.clicked, []);
});

test('text the CAPTCHA step put on the page is not mistaken for the broker\'s answer', async () => {
  // A solved-CAPTCHA banner must not read as "request received". The click added
  // nothing, so this is unverified.
  const page = makeFakePage({ forms: [form({ afterSubmit: {} })] });
  const { handleCaptcha } = stubHandler('solved', {
    onCall: (p) => { p.body += '\nVerification complete. Your request has been received.'; },
  });
  assert.equal((await run(page, { handleCaptcha })).status, 'unverified');
});

test('the handler is not called for a form that could not be filled', async () => {
  const page = makeFakePage({ forms: [optOutForm({ fields: [gr.CAPTCHA_IN_FORM_SELECTOR] })] });
  const { handleCaptcha, calls } = stubHandler('solved');
  const result = await run(page, { handleCaptcha });
  assert.equal(calls.length, 0, 'solving a CAPTCHA for a form we cannot fill would waste a person\'s three minutes');
  assert.notEqual(result.status, 'success');
  assert.deepEqual(page.clicked, []);
});

// ── dry run ──────────────────────────────────────────────────────────────────

test('a dry run never calls handleCaptcha (no paid solve, no waiting on a human)', async () => {
  const page = makeFakePage({ forms: [form()] });
  const { handleCaptcha, calls } = stubHandler('solved');
  const result = await run(page, { handleCaptcha }, true);
  assert.equal(result.status, 'skipped');
  assert.equal(calls.length, 0);
});

// ── detection ────────────────────────────────────────────────────────────────

test('the in-form selector covers reCAPTCHA, hCaptcha and Turnstile frames, containers and response fields', () => {
  const selector = gr.CAPTCHA_IN_FORM_SELECTOR;
  for (const piece of [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile',
    'textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', 'input[name="cf-turnstile-response"]',
  ]) {
    assert.ok(selector.includes(piece), `missing ${piece}`);
  }
});

test('a visible widget outside the <form> still counts', async () => {
  const page = makeFakePage({
    forms: [form({ captcha: false })],
    pageSelectors: (sel) => sel === gr.CAPTCHA_ON_PAGE_SELECTOR,
  });
  const { handleCaptcha, calls } = stubHandler('timeout');
  const result = await run(page, { handleCaptcha });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'captcha_failed');
});

test('a hidden page-level widget (an invisible badge) does not count', async () => {
  const page = makeFakePage({
    forms: [form({ captcha: false })],
    pageSelectors: (sel) => sel === gr.CAPTCHA_ON_PAGE_SELECTOR,
    hidden: (sel) => sel === gr.CAPTCHA_ON_PAGE_SELECTOR,
  });
  const { handleCaptcha, calls } = stubHandler('timeout');
  const result = await run(page, { handleCaptcha });
  assert.equal(calls.length, 0);
  assert.equal(result.status, 'success');
});

test('the page-level selector leaves out invisible reCAPTCHA frames (the v3 badge is on every page that loads it)', () => {
  assert.match(gr.CAPTCHA_ON_PAGE_SELECTOR, /size=invisible/);
});

test('a detector that throws does not block the form (today\'s behaviour)', async () => {
  const page = makeFakePage({ forms: [form({ captcha: false })] });
  const realLocator = page.locator;
  page.locator = (sel) => {
    if (sel === gr.CAPTCHA_ON_PAGE_SELECTOR) throw new Error('page crashed');
    return realLocator(sel);
  };
  assert.equal((await run(page)).status, 'success');
});

// ── Do Not Sell flow shares the same gate ────────────────────────────────────

test('a CAPTCHA on the form a Do Not Sell click opens is gated the same way', async () => {
  const dnsPage = () => makeFakePage({
    body: 'Welcome\nPrivacy',
    forms: [form()],
    pageScope: false,
    pageSelectors: (sel) => sel.includes('Do Not Sell'),
  });

  const blocked = dnsPage();
  const refused = await run(blocked);
  assert.equal(refused.status, 'captcha_failed');
  assert.ok(!blocked.clicked.some(c => c.sel.includes('button[type="submit"]')), 'the form was not submitted');

  const solved = dnsPage();
  const { handleCaptcha, calls } = stubHandler('solved');
  assert.equal((await run(solved, { handleCaptcha })).status, 'success');
  assert.equal(calls.length, 1);
});

// ── runGenericBrokers: plumbing, outcome bucket, state ───────────────────────

test('classifyOutcome gives captcha_failed its own bucket (not error, not submitted)', () => {
  assert.equal(gr.classifyOutcome('captcha_failed', ''), 'captcha_failed');
});

test('runGenericBrokers passes opts.handleCaptcha through to the process function', async () => {
  const seen = [];
  const handleCaptcha = async () => 'solved';
  await gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} }, () => {}, () => {},
    {
      injectedBrokers: [BROKER],
      injectedProcessFn: async (_p, _b, _s, _d, _dead, processOpts) => { seen.push(processOpts.handleCaptcha); return { status: 'manual', detail: '' }; },
      handleCaptcha,
    },
  );
  assert.equal(seen[0], handleCaptcha);
});

test('runGenericBrokers logs captcha_failed, counts it apart, and never records a success', async () => {
  const logged = [];
  const successes = [];
  const configPath = require.resolve('../lib/config');
  const origEntry = require.cache[configPath];
  const failures = [];
  const spyConfig = Object.assign({}, require(configPath), {
    recordFailure: (name, kind) => failures.push({ name, kind }),
  });
  require.cache[configPath] = Object.assign({}, origEntry, { exports: spyConfig });
  delete require.cache[require.resolve('../generic-runner')];
  const freshGr = require('../generic-runner');
  freshGr._setConfig({ person: PERSON });

  let result;
  try {
    const page = makeFakePage({ forms: [form()] });
    result = await freshGr.runGenericBrokers(
      makeContext(page), new Set(), { optOuts: {} },
      (name, status, detail) => logged.push({ name, status, detail }),
      (name) => successes.push(name),
      { injectedBrokers: [BROKER], injectedDeadSet: new Set() },
    );
    assert.deepEqual(page.clicked, [], 'nothing was submitted');
  } finally {
    require.cache[configPath] = origEntry;
    delete require.cache[require.resolve('../generic-runner')];
  }

  assert.deepEqual(logged.map(l => l.status), ['captcha_failed']);
  assert.deepEqual(successes, [], 'no success, so no 90-day cooldown');
  assert.deepEqual(failures, [{ name: 'CaptchaBroker', kind: 'captcha_failed' }], 'drift tracking sees a captcha failure, like the explicit runner');
  assert.equal(result.genericStats.captcha_failed, 1);
  assert.equal(result.genericStats.submitted, 0);
  assert.equal(result.genericStats.error, 0);
  assert.equal(result.genericStats.attempted, 1);
});

test('genericStats always carries a captcha_failed count (0 when nothing hit one)', async () => {
  const result = await gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} }, () => {}, () => {},
    { injectedBrokers: [], injectedDeadSet: new Set() },
  );
  assert.equal(result.genericStats.captcha_failed, 0);
});
