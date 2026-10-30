/**
 * test/generic-form-gating.test.js
 *
 * codex #3: registry rows that point at a homepage, or that the feed classified
 * `manual`, still went to the generic form filler. The filler typed the user's
 * name, email, state and zip into the FIRST form it found and clicked the first
 * submit button, so a footer newsletter or contact form got a person's details
 * instead of a removal request.
 *
 * Strategy 3 (generic form fill) may now only submit a form that
 *   - looks like an opt-out / deletion / privacy-request form (its own text,
 *     labels, legend, heading, id/class/action, submit label, or, for the sole
 *     real form on the page, the page URL/title), AND
 *   - does not look like a newsletter / subscribe / login / search / contact /
 *     checkout form.
 * A row's own `method: 'manual'` and a bare homepage URL keep the form filler off
 * entirely; Do Not Sell, consent-manager and DSAR-link handling still apply.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, optOutForm, newsletterForm, DEFAULT_DESC } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001',
};

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-gate-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (page, broker, opts = {}) =>
  gr.processGenericUrl(page, broker, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });
const row = (overrides = {}) => ({ name: 'GateBroker', url: 'https://broker.example/opt-out', source: 'markup', ...overrides });
const desc = (overrides) => ({ ...DEFAULT_DESC, ...overrides });

// ── classifyOptOutForm (pure) ────────────────────────────────────────────────

test('classifyOptOutForm accepts forms whose own text, heading, legend, action, id, class or button says opt-out', () => {
  const accepted = [
    desc({ text: 'Request deletion of your personal information. Email' }),
    desc({ heading: 'Do Not Sell My Personal Information' }),
    desc({ legends: 'Privacy request' }),
    desc({ action: 'https://broker.example/ccpa/submit' }),
    desc({ id: 'optout-form' }),
    desc({ className: 'form do-not-sell-form' }),
    desc({ submitTexts: ['Opt Out'] }),
    desc({ dialogLabel: 'Data Subject Request' }),
    desc({ text: 'Exercise your GDPR rights. Name Email' }),
    desc({ text: 'Remove my record from your database' }),
    desc({ id: 'doNotSell' }),
    desc({ text: 'Suppress my information' }),
  ];
  for (const d of accepted) {
    const v = gr.classifyOptOutForm(d, {});
    assert.equal(v.eligible, true, `should accept ${JSON.stringify(d)} but: ${v.reason}`);
  }
});

test('classifyOptOutForm rejects newsletter, subscribe, login, search, contact and checkout forms', () => {
  const rejected = [
    desc({ text: 'Subscribe to our newsletter', submitTexts: ['Subscribe'] }),
    desc({ text: 'Sign up for updates', heading: 'Stay in touch', submitTexts: ['Sign up'] }),
    desc({ text: 'Join our mailing list. Email' }),
    desc({ text: 'Email Password', hasPassword: true, submitTexts: ['Log in'] }),
    desc({ text: 'Find a person. First name Last name', hasSearch: true, submitTexts: ['Search'] }),
    desc({ action: 'https://broker.example/people/search', text: 'First name Last name' }),
    desc({ heading: 'Contact us', text: 'Name Email Message', submitTexts: ['Send message'] }),
    desc({ heading: 'Get in touch' }),
    desc({ text: 'Billing details Card number', hasPayment: true, submitTexts: ['Pay now'], heading: 'Checkout' }),
    desc({ text: 'Remove item from cart', heading: 'Your cart' }),
    desc({ text: 'Leave feedback' }),
  ];
  for (const d of rejected) {
    const v = gr.classifyOptOutForm(d, {});
    assert.equal(v.eligible, false, `should reject ${JSON.stringify(d)}`);
  }
});

test('classifyOptOutForm: a newsletter signal in the strong fields beats opt-out words in the body', () => {
  // "unsubscribe / opt out anytime" fine print inside a newsletter signup.
  const v = gr.classifyOptOutForm(desc({
    text: 'Get 10% off. You can opt out anytime. Email',
    submitTexts: ['Subscribe'],
  }), {});
  assert.equal(v.eligible, false);
});

test('classifyOptOutForm: negative words only in the body are overridden by a real opt-out heading', () => {
  const v = gr.classifyOptOutForm(desc({
    heading: 'Privacy request form',
    text: 'To verify your identity we may ask you to log in or search our records. Name Email',
  }), {});
  assert.equal(v.eligible, true);
});

test('classifyOptOutForm: a login form is never eligible even if it mentions opt out', () => {
  const v = gr.classifyOptOutForm(desc({ hasPassword: true, heading: 'Opt out portal login', text: 'Email Password' }), {});
  assert.equal(v.eligible, false);
});

test('classifyOptOutForm: no vocabulary anywhere is not eligible', () => {
  assert.equal(gr.classifyOptOutForm(desc({ text: 'Email Go' }), {}).eligible, false);
});

test('classifyOptOutForm: invisible forms are not eligible', () => {
  assert.equal(gr.classifyOptOutForm(desc({ visible: false, text: 'Opt out' }), {}).eligible, false);
});

test('classifyOptOutForm: an opt-out page URL vouches only for the SOLE non-footer form', () => {
  const bare = desc({ text: 'Email Go' });
  const ctx = { pageUrl: 'https://broker.example/privacy/opt-out', pageTitle: '', visibleFormCount: 1 };
  assert.equal(gr.classifyOptOutForm(bare, ctx).eligible, true, 'the only real form on an opt-out page');
  assert.equal(gr.classifyOptOutForm(bare, { ...ctx, visibleFormCount: 2 }).eligible, false, 'ambiguous with two forms');
  assert.equal(gr.classifyOptOutForm(desc({ ...bare, chrome: true }), ctx).eligible, false, 'a footer/header form is never vouched for by the page');
  assert.equal(gr.classifyOptOutForm(bare, { pageUrl: 'https://broker.example/', visibleFormCount: 1 }).eligible, false, 'a homepage URL vouches for nothing');
});

test('classifyOptOutForm: the page TITLE can vouch too', () => {
  const v = gr.classifyOptOutForm(desc({ text: 'Email Go' }), { pageUrl: 'https://broker.example/p/12', pageTitle: 'Opt Out of Data Sales', visibleFormCount: 1 });
  assert.equal(v.eligible, true);
});

test('classifyOptOutForm: a footer form needs strong signals, body words are not enough', () => {
  const v = gr.classifyOptOutForm(desc({ chrome: true, text: 'Remove me from the list of people who get offers. Email' }), {});
  assert.equal(v.eligible, false);
  const strong = gr.classifyOptOutForm(desc({ chrome: true, heading: 'Do Not Sell My Info', text: 'Email' }), {});
  assert.equal(strong.eligible, true);
});

test('classifyOptOutForm: a form that appeared after clicking Do Not Sell is trusted if it is not excluded', () => {
  const v = gr.classifyOptOutForm(desc({ text: 'Email Submit' }), { afterOptOutClick: true, isNewSinceClick: true });
  assert.equal(v.eligible, true);
  assert.equal(gr.classifyOptOutForm(desc({ text: 'Email Submit' }), { afterOptOutClick: true, isNewSinceClick: false }).eligible, false, 'a form that was already there is not');
  assert.equal(gr.classifyOptOutForm(desc({ text: 'Subscribe Email', submitTexts: ['Subscribe'] }), { afterOptOutClick: true, isNewSinceClick: true }).eligible, false, 'but exclusions still win');
});

// ── processGenericUrl: Strategy 3 behaviour ──────────────────────────────────

test('codex #3: a page whose only form is a footer newsletter signup is never filled or submitted', async () => {
  const page = makeFakePage({ forms: [newsletterForm({ afterSubmit: { body: 'Thanks for subscribing. Your request has been received.' } })] });
  const result = await run(page, row());
  assert.deepEqual(page.filled, [], 'no PII into a newsletter form');
  assert.deepEqual(page.clicked, []);
  assert.equal(result.status, 'manual');
  assert.equal(result.detail, 'https://broker.example/opt-out', 'manual detail stays the bare URL so the end-of-run opener can use it');
});

test('codex #3: login, search and contact forms are never filled or submitted', async () => {
  const forms = [
    { desc: { text: 'Email Password', hasPassword: true, submitTexts: ['Log in'] }, fields: ['email'] },
    { desc: { text: 'Find a person', hasSearch: true, submitTexts: ['Search'] }, fields: ['firstName', 'lastName'] },
    { desc: { heading: 'Contact us', text: 'Name Email Message', submitTexts: ['Send'] }, fields: ['email', 'fullName'] },
  ];
  const page = makeFakePage({ forms });
  const result = await run(page, row());
  assert.deepEqual(page.filled, []);
  assert.deepEqual(page.clicked, []);
  assert.notEqual(result.status, 'success');
});

test('codex #3: the real opt-out form is picked even when a newsletter form comes first and a login form last', async () => {
  const page = makeFakePage({
    forms: [
      newsletterForm(),
      optOutForm({ afterSubmit: { body: 'Your request has been received.' } }),
      { desc: { hasPassword: true, text: 'Email Password' }, fields: ['email'] },
    ],
  });
  const result = await run(page, row());
  assert.equal(result.status, 'success');
  assert.ok(page.filled.every(f => f.form === 1));
});

test('codex #3: a feed row classified manual never reaches the form filler, even with an eligible form', async () => {
  const page = makeFakePage({ forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })] });
  const result = await run(page, row({ method: 'manual', source: 'ca' }));
  assert.deepEqual(page.filled, []);
  assert.deepEqual(page.clicked, []);
  assert.equal(result.status, 'manual');
});

test('codex #3: only rows with no method (Markup/BADBOOL) or direct-form may use the form filler', async () => {
  for (const method of ['search-form', 'email', 'unknown']) {
    const page = makeFakePage({ forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })] });
    const result = await run(page, row({ method, source: 'ca' }));
    assert.deepEqual(page.filled, [], `method ${method} must not reach the form filler`);
    assert.equal(result.status, 'manual');
  }
});

test('codex #3: a homepage-only row never reaches the form filler', async () => {
  const page = makeFakePage({ url: 'https://broker.example/', forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })] });
  const result = await run(page, row({ url: 'https://broker.example/', source: 'markup' }));
  assert.deepEqual(page.filled, []);
  assert.deepEqual(page.clicked, []);
  assert.equal(result.status, 'manual');
});

test('codex #3: a homepage-only row can still use the Do Not Sell link, and its form passes the same checks', async () => {
  const page = makeFakePage({
    url: 'https://broker.example/',
    pageScope: false,
    pageSelectors: (sel) => sel.includes('Do Not Sell'),
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page, row({ url: 'https://broker.example/', method: 'manual', source: 'ca' }));
  assert.ok(page.clicked.some(c => c.sel.includes('Do Not Sell')), 'the Do Not Sell link is still followed');
  assert.equal(result.status, 'success');
});

test('codex #3: a homepage row whose Do Not Sell click opens a NEWSLETTER-looking form still does not submit it', async () => {
  const page = makeFakePage({
    url: 'https://broker.example/',
    pageScope: false,
    pageSelectors: (sel) => sel.includes('Do Not Sell'),
    forms: [newsletterForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page, row({ url: 'https://broker.example/', source: 'markup' }));
  assert.deepEqual(page.filled, []);
  assert.equal(result.status, 'manual');
});

test('codex #3: a feed row classified direct-form on an opt-out path is processed normally', async () => {
  const page = makeFakePage({ forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })] });
  const result = await run(page, row({ method: 'direct-form', source: 'vt' }));
  assert.equal(result.status, 'success');
});

test('codex #3: the sole form on an opt-out URL is accepted even with no vocabulary of its own', async () => {
  const page = makeFakePage({
    url: 'https://broker.example/privacy/opt-out',
    forms: [{ desc: { text: 'Email Go', chrome: false }, fields: ['email'], afterSubmit: { body: 'Your request has been received.' } }],
  });
  const result = await run(page, row({ url: 'https://broker.example/privacy/opt-out' }));
  assert.equal(result.status, 'success');
});

test('codex #3: two vocabulary-free forms on an opt-out URL are ambiguous, so neither is submitted', async () => {
  const page = makeFakePage({
    url: 'https://broker.example/privacy/opt-out',
    forms: [
      { desc: { text: 'Email Go' }, fields: ['email'] },
      { desc: { text: 'Email Go' }, fields: ['email'] },
    ],
  });
  const result = await run(page, row({ url: 'https://broker.example/privacy/opt-out' }));
  assert.deepEqual(page.filled, []);
  assert.equal(result.status, 'manual');
});

test('codex #3: a page with no <form> element at all is manual, not a page-wide guess', async () => {
  const page = makeFakePage({ forms: [] });
  const result = await run(page, row());
  assert.deepEqual(page.filled, []);
  assert.equal(result.status, 'manual');
});

// ── loading: the row's method is kept ────────────────────────────────────────

test('loadGenericBrokers keeps the feed row method so the runner can respect it', () => {
  const ROOT = path.join(__dirname, '..');
  const MARKUP_PATH = path.join(ROOT, 'data', 'markup-parsed.json');
  const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
  const FEEDS_PATH = path.join(ROOT, 'data', 'feeds-brokers.json');
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Home Co', optOutUrl: 'https://home-co.com/', method: 'manual', source: 'ca' },
      { name: 'Form Co', optOutUrl: 'https://form-co.com/opt-out', method: 'direct-form', source: 'vt' },
    ]),
  };
  const fsMock = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (files[p] !== undefined) return files[p]; throw new Error(`unexpected read ${p}`); },
  };
  const originalLoad = Module._load.bind(Module);
  Module._load = (request, parent, isMain) => (
    request === 'fs' && parent && parent.filename && parent.filename.includes('generic-runner')
      ? fsMock
      : originalLoad(request, parent, isMain)
  );
  const grPath = require.resolve('../generic-runner');
  const saved = require.cache[grPath];
  delete require.cache[grPath];
  let fresh;
  try { fresh = require('../generic-runner'); } finally { Module._load = originalLoad; }
  require.cache[grPath] = saved;

  const brokers = fresh.loadGenericBrokers(new Set());
  const byName = Object.fromEntries(brokers.map(b => [b.name, b]));
  assert.equal(byName['Home Co'].method, 'manual');
  assert.equal(byName['Form Co'].method, 'direct-form');
});
