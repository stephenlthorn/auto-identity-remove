/**
 * test/manual-captcha-probe.test.js
 *
 * readCaptchaState runs INSIDE the page (page.evaluate serializes it), so it is
 * exercised here by running the very same function against a small fake
 * `document`. What matters: which response fields count as "the widget reported
 * a token", that an empty or whitespace field does not, and which wording makes
 * a page a "verify you are human" challenge (and which footer text must not).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCaptchaState } = require('../lib/manual-captcha');

/** Just enough DOM: [name="..."] selectors on a tag, and iframe[src*="..."] lists. */
function fakeDocument({ fields = [], iframes = [], text = '', readyState = 'complete' } = {}) {
  const byTagAndName = (selector) => {
    const m = selector.match(/^(\w+)\[name="([^"]+)"\]$/);
    return m ? fields.filter(f => f.tag === m[1] && f.name === m[2]) : [];
  };
  return {
    readyState,
    body: { innerText: text },
    querySelectorAll: (selector) => byTagAndName(selector),
    querySelector: (selector) => {
      const needles = [...selector.matchAll(/iframe\[src\*="([^"]+)"\]/g)].map(m => m[1]);
      return iframes.find(src => needles.some(n => src.includes(n))) ? {} : null;
    },
  };
}

function read(docSpec) {
  const previous = globalThis.document;
  globalThis.document = fakeDocument(docSpec);
  try { return readCaptchaState(); } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
}

test('no response field and no challenge wording: nothing reported', () => {
  const s = read({ text: 'Opt out of this site. Protected by reCAPTCHA. Google Privacy Policy and Terms of Service apply.' });
  assert.deepEqual(s, { ready: true, token: false, frame: false, humanText: false });
});

for (const [label, field] of [
  ['reCAPTCHA', { tag: 'textarea', name: 'g-recaptcha-response' }],
  ['hCaptcha', { tag: 'textarea', name: 'h-captcha-response' }],
  ['Turnstile', { tag: 'input', name: 'cf-turnstile-response' }],
]) {
  test(`${label}: a non-empty response field is a token`, () => {
    assert.equal(read({ fields: [{ ...field, value: 'abc.def' }] }).token, true);
  });
  test(`${label}: an empty or blank response field is not a token`, () => {
    assert.equal(read({ fields: [{ ...field, value: '' }] }).token, false);
    assert.equal(read({ fields: [{ ...field, value: '   ' }] }).token, false);
  });
}

test('one filled field among several empty ones still counts (hCaptcha mirrors into g-recaptcha-response)', () => {
  const s = read({ fields: [
    { tag: 'textarea', name: 'g-recaptcha-response', value: '' },
    { tag: 'textarea', name: 'g-recaptcha-response', value: 'tok' },
  ] });
  assert.equal(s.token, true);
});

test('a field of a different name never counts', () => {
  assert.equal(read({ fields: [{ tag: 'input', name: 'email', value: 'x@example.com' }] }).token, false);
});

test('a visible challenge iframe (DataDome, Arkose) is reported as a frame', () => {
  assert.equal(read({ iframes: ['https://geo.captcha-delivery.com/captcha/?x=1'] }).frame, true);
  assert.equal(read({ iframes: ['https://client-api.arkoselabs.com/fc/gc/'] }).frame, true);
  assert.equal(read({ iframes: ['https://www.youtube.com/embed/x'] }).frame, false);
});

test('"verify you are human" style wording is a challenge page', () => {
  for (const text of [
    'Verify you are human',
    "Please verify you're human to continue",
    'Are you a robot?',
    "Confirm that you're not a robot",
    'Prove you are human',
  ]) {
    assert.equal(read({ text }).humanText, true, text);
  }
});

test('footer text that merely mentions CAPTCHA is not a challenge', () => {
  for (const text of [
    'This site is protected by reCAPTCHA and the Google Privacy Policy applies.',
    'We verify your identity before removing a record.',
    'Human resources',
  ]) {
    assert.equal(read({ text }).humanText, false, text);
  }
});

test('ready is true only for a fully loaded document', () => {
  assert.equal(read({ readyState: 'loading' }).ready, false);
  assert.equal(read({ readyState: 'interactive' }).ready, false);
  assert.equal(read({ readyState: 'complete' }).ready, true);
});

test('a document with no body yet does not throw', () => {
  const previous = globalThis.document;
  globalThis.document = { readyState: 'loading', body: null, querySelectorAll: () => [], querySelector: () => null };
  try {
    assert.deepEqual(readCaptchaState(), { ready: false, token: false, frame: false, humanText: false });
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});
