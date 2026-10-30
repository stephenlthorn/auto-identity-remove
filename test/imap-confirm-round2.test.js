/**
 * test/imap-confirm-round2.test.js
 *
 * BRK2-2 / codex #4: a confirmation click was recorded as success for any page under
 * HTTP 400 that lacked a narrow "link expired" phrase, so "Something went wrong" and
 * "Sign in to continue" both started a 90-day cooldown. A page now needs positive
 * evidence; an unknown page leaves the request pending ("unverified").
 *
 * codex #7: results carry a redacted URL (host and path); the raw URL, which holds
 * the confirmation token, is only ever used to navigate.
 *
 * BRK2-11: the click happens in a context of its own, never in a profile that other
 * clicks (and other persons) have left cookies in.
 *
 * codex #3: navigation requests are re-checked every time, not from a per-host cache.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processConfirmationEmails, makeNavigationGuard } = require('../lib/imap-confirm');

const SPOKEO = { name: 'Spokeo', expectedSender: 'optout@spokeo.com', optOutUrl: 'https://www.spokeo.com/optout' };
const PERSON = { firstName: 'Test', lastName: 'User', email: 'test.user@home.example', zip: '78701' };
const TOKEN_URL = 'https://spokeo.com/confirm?token=SECRET-TOKEN-123&uid=jane#frag';

const memStore = () => { const ids = new Set(); return { has: (id) => ids.has(id), add: (id) => ids.add(id), ids }; };

function eml(url = TOKEN_URL) {
  return ['From: optout@spokeo.com', 'To: test.user@home.example', 'Subject: Confirm', 'Message-ID: <m1@x>', '', `Confirm: ${url}`].join('\r\n');
}

function pageWith({ text, status = 200, lang = '', finalUrl }) {
  const calls = { goto: [], closed: false };
  let current = 'about:blank';
  const page = {
    calls,
    goto: async (url) => { calls.goto.push(url); current = finalUrl || url; return { status: () => status, url: () => current }; },
    url: () => current,
    textContent: async () => text,
    evaluate: async () => lang,
    close: async () => { calls.closed = true; },
  };
  return page;
}

function run({ page, context, extra = {}, url } = {}) {
  const recorded = [];
  const store = memStore();
  const moved = [];
  const ctx = context || { newPage: async () => page };
  return processConfirmationEmails(ctx, [SPOKEO], {
    dir: '/x',
    persons: [PERSON],
    relayAliases: {},
    _readDir: () => ['m.eml'],
    _readFile: () => eml(url),
    _moveFile: (f) => { moved.push(f); return true; },
    _recordSuccess: (key, detail) => recorded.push({ key, detail }),
    _isPending: () => true,
    _processedStore: store,
    _resolveHost: async () => ['93.184.216.34'],
    ...extra,
  }).then((out) => ({ out, recorded, store, moved }));
}

// ── BRK2-2 ────────────────────────────────────────────────────────────────────

test('BRK2-2: "Something went wrong. Please try again later." is a failure, never a success', async () => {
  const { out, recorded } = await run({ page: pageWith({ text: 'Something went wrong. Please try again later.' }) });
  assert.equal(recorded.length, 0);
  assert.equal(out.processed.length, 0);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].reason, 'confirmation_failed');
});

test('BRK2-2: a sign-in wall is not a confirmation', async () => {
  const { out, recorded } = await run({ page: pageWith({ text: 'Sign in to continue' }) });
  assert.equal(recorded.length, 0);
  assert.equal(out.processed.length, 0);
  assert.equal(out.failed[0].reason, 'blocked_page');
});

test('BRK2-2: a bot wall is not a confirmation', async () => {
  const { out, recorded } = await run({ page: pageWith({ text: 'Checking your browser before accessing the site. Verify you are human.' }) });
  assert.equal(recorded.length, 0);
  assert.equal(out.failed[0].reason, 'blocked_page');
});

test('BRK2-2: a page with no sign either way is unverified: nothing recorded, request stays pending, the link is not clicked again', async () => {
  const { out, recorded, store, moved } = await run({ page: pageWith({ text: 'Welcome to Spokeo. Browse our listings and learn about our plans.' }) });
  assert.equal(recorded.length, 0, 'no 90-day cooldown on a guess');
  assert.equal(out.processed.length, 0);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].reason, 'unverified');
  assert.ok(store.ids.size > 0, 'the message is remembered as clicked so the next run does not click it again');
  assert.equal(moved.length, 1);
});

test('BRK2-2: positive wording is a confirmation (several real-world phrasings)', async () => {
  for (const text of [
    'Your opt-out request has been confirmed.',
    'Thank you for confirming your email address.',
    'Your request has been received and is being processed.',
    'You have been removed from our database.',
    'Success! Your opt-out is confirmed.',
    'Your listing has been removed.',
  ]) {
    const { out, recorded } = await run({ page: pageWith({ text }) });
    assert.equal(out.processed.length, 1, `"${text}" should count (failed: ${JSON.stringify(out.failed.map((f) => f.reason))})`);
    assert.equal(recorded.length, 1);
  }
});

test('BRK2-2: failure wording wins over a success phrase on the same page', async () => {
  const { out, recorded } = await run({ page: pageWith({ text: 'Your request could not be confirmed. Something went wrong, please try again.' }) });
  assert.equal(recorded.length, 0);
  assert.equal(out.processed.length, 0);
});

// ── codex #7 ──────────────────────────────────────────────────────────────────

test('codex #7: the processed result carries host and path only; the page was navigated to with the real link', async () => {
  const page = pageWith({ text: 'Your opt-out request has been confirmed.' });
  const { out, recorded } = await run({ page });
  assert.equal(page.calls.goto[0], TOKEN_URL, 'navigation needs the raw url');
  const shown = JSON.stringify(out);
  assert.ok(!shown.includes('SECRET-TOKEN-123'), shown);
  assert.ok(!shown.includes('uid=jane'));
  assert.equal(out.processed[0].url, 'https://spokeo.com/confirm');
  assert.ok(!JSON.stringify(recorded).includes('SECRET-TOKEN-123'));
});

test('codex #7: failed and unmatched results are redacted too, error text included', async () => {
  const page = pageWith({ text: 'Not found', status: 404, finalUrl: TOKEN_URL });
  const { out } = await run({ page });
  const shown = JSON.stringify(out);
  assert.ok(!shown.includes('SECRET-TOKEN-123'), shown);

  const offHost = await run({ page: pageWith({ text: 'x' }), url: 'https://evil.example.org/confirm?token=SECRET-TOKEN-123' });
  assert.ok(!JSON.stringify(offHost.out).includes('SECRET-TOKEN-123'), JSON.stringify(offHost.out));
});

test('codex #7: a thrown navigation error that quotes the url is scrubbed', async () => {
  const context = { newPage: async () => ({ goto: async (u) => { throw new Error(`page.goto: net::ERR_TIMED_OUT at ${u}`); }, close: async () => {} }) };
  const { out } = await run({ context });
  assert.ok(!JSON.stringify(out).includes('SECRET-TOKEN-123'), JSON.stringify(out));
  assert.equal(out.failed[0].reason, 'navigation_error');
});

test('codex #7: a dry run is redacted as well', async () => {
  const { out } = await run({ extra: { dryRun: true } });
  assert.equal(out.processed[0].url, 'https://spokeo.com/confirm');
});

test('codex #8: the broker\'s page text kept in the result has the person\'s details removed', async () => {
  const { out } = await run({ page: pageWith({ text: 'Thanks Test User. Your opt-out request has been confirmed for test.user@home.example.' }) });
  const text = out.processed[0].finalText;
  assert.ok(!text.includes('test.user@home.example') && !text.includes('Test User'), text);
});

// ── BRK2-11 ───────────────────────────────────────────────────────────────────

test('BRK2-11: openContext gives every click a context of its own, closed afterwards; the shared one is untouched', async () => {
  const opened = [];
  const closed = [];
  let sharedUsed = 0;
  const shared = { newPage: async () => { sharedUsed += 1; return pageWith({ text: 'x' }); } };
  const openContext = async () => {
    const page = pageWith({ text: 'Your opt-out request has been confirmed.' });
    const id = opened.length;
    opened.push(id);
    return { context: { newPage: async () => page }, close: async () => { closed.push(id); } };
  };
  const { out } = await run({ context: shared, extra: { openContext } });
  assert.equal(out.processed.length, 1);
  assert.deepEqual(opened, [0]);
  assert.deepEqual(closed, [0]);
  assert.equal(sharedUsed, 0);
});

test('BRK2-11: openContext that fails fails that click, not the run', async () => {
  const { out } = await run({ context: { newPage: async () => { throw new Error('x'); } }, extra: { openContext: async () => { throw new Error('no browser'); } } });
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].reason, 'navigation_error');
});

test('BRK2-11: on a shared context the cookies are cleared before and after the click', async () => {
  const steps = [];
  const page = pageWith({ text: 'Your opt-out request has been confirmed.' });
  const context = {
    clearCookies: async () => { steps.push('clear'); },
    newPage: async () => { steps.push('page'); return page; },
  };
  await run({ context });
  assert.deepEqual(steps, ['clear', 'page', 'clear']);
});

// ── codex #3: no per-host verdict cache for navigations ───────────────────────

test('codex #3: a navigation is re-resolved every time (rebinding), a script request may reuse an earlier answer', async () => {
  const answers = [['93.184.216.34'], ['10.0.0.9']];
  let lookups = 0;
  const resolveHost = async () => answers[Math.min(lookups++, 1)];
  const guard = makeNavigationGuard({ broker: SPOKEO, resolveHost });
  const route = (url, navigation) => {
    const out = { aborted: false };
    return { out, route: { request: () => ({ url: () => url, isNavigationRequest: () => navigation }), abort: async () => { out.aborted = true; }, continue: async () => {} } };
  };
  const first = route('https://spokeo.com/confirm?t=1', true);
  await guard.handler(first.route);
  assert.equal(first.out.aborted, false);
  const second = route('https://spokeo.com/confirm/step2', true);
  await guard.handler(second.route);
  assert.equal(second.out.aborted, true, 'the same host now answers privately');
  assert.equal(lookups, 2);
});
