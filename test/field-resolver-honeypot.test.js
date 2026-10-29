/**
 * test/field-resolver-honeypot.test.js
 *
 * BRK-15: two ways the semantic resolver put PII in the wrong box.
 *
 *   1. isFullNameToken accepted surname / family_name / given_name / fname /
 *      lname, so "Jane Doe" was typed into a last-name box.
 *   2. The visibility test was just "non-zero rect and not [hidden]". A honeypot
 *      parked at left:-9999px, sized 1px, aria-hidden or tabindex=-1 passed it,
 *      so the bot trap was filled instead of (or tying with) the real field.
 *
 * The resolver's scorer runs inside page.evaluate. These tests run the real
 * production callback against mock elements, the same way
 * field-resolver.test.js does, so there is no second copy of the logic here.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveField, RESOLVE_MARKER } = require('../lib/field-resolver');

const ON_SCREEN = { left: 20, top: 100, right: 220, bottom: 130, width: 200, height: 30 };

/**
 * A mock form control. `style` feeds getComputedStyle; `ancestors` is a list of
 * { attrs, style } objects from nearest parent outward.
 */
function makeEl({
  tagName = 'INPUT', type = 'text', name = '', id = '', placeholder = '',
  rect = ON_SCREEN, attrs = {}, style = {}, ancestors = [], autocomplete = '',
} = {}) {
  const view = {
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    getComputedStyle: (node) => ({
      display: 'block', visibility: 'visible', opacity: '1', ...(node._style || {}),
    }),
  };
  const doc = { defaultView: view };

  const chain = [];
  let child = null;
  for (const a of [...ancestors].reverse()) {
    const node = {
      _attrs: { ...(a.attrs || {}) },
      _style: a.style || {},
      parentElement: child,
      ownerDocument: doc,
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    };
    child = node;
    chain.push(node);
  }

  const el = {
    tagName,
    type,
    name,
    id,
    placeholder,
    hidden: false,
    parentElement: child,
    ownerDocument: doc,
    _attrs: { ...attrs },
    _style: style,
    getBoundingClientRect: () => rect,
    getAttribute(k) {
      if (Object.prototype.hasOwnProperty.call(this._attrs, k)) return this._attrs[k];
      if (k === 'autocomplete') return autocomplete;
      return null;
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
  };
  return el;
}

/** Page stub: evaluate runs the real callback; locator resolves the tagged element. */
function makePage(candidates) {
  const marked = () => candidates.find(c => c.getAttribute(RESOLVE_MARKER) === '1') || null;
  return {
    async evaluate(fn, arg) {
      const saved = global.document;
      global.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => (
          sel.startsWith('[' + RESOLVE_MARKER)
            ? candidates.filter(c => c.hasAttribute(RESOLVE_MARKER))
            : candidates
        ),
        body: {},
      };
      try { return await fn(arg); } finally {
        if (saved === undefined) delete global.document; else global.document = saved;
      }
    },
    locator() { return { get tagged() { return marked(); } }; },
  };
}

async function winner(candidates, selector, value) {
  const page = makePage(candidates);
  const loc = await resolveField(page, selector, value);
  if (!loc) return null;
  return loc.tagged;
}

const quiet = async (fn) => {
  const orig = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = orig; }
};

// ── 1. a full name never goes into a surname / family / given / fname / lname box ──

for (const field of ['surname', 'family_name', 'familyname', 'given_name', 'fname', 'lname', 'sur_name']) {
  test(`full name is not typed into a "${field}" field`, async () => {
    const only = makeEl({ name: field, id: field, placeholder: field.replace(/_/g, ' ') });
    const got = await quiet(() => winner([only], 'input[name*="name"]', 'Jane Doe'));
    assert.equal(got, null, `"${field}" is one half of a name, not the full name`);
  });
}

test('the real full-name field still wins next to a surname field', async () => {
  const surname = makeEl({ name: 'surname', id: 'surname', placeholder: 'Surname' });
  const full = makeEl({ name: 'full_name', id: 'full_name', placeholder: 'Your name' });
  const got = await quiet(() => winner([surname, full], 'input[name*="name"]', 'Jane Doe'));
  assert.equal(got, full);
});

// ── 2. honeypots are not fillable ─────────────────────────────────────────────

const HONEYPOTS = {
  'parked off-screen at left:-9999px': { rect: { left: -9999, top: 100, right: -9799, bottom: 130, width: 200, height: 30 } },
  'parked off-screen at top:-9999px': { rect: { left: 20, top: -9999, right: 220, bottom: -9969, width: 200, height: 30 } },
  'parked off-screen to the right': { rect: { left: 9999, top: 100, right: 10199, bottom: 130, width: 200, height: 30 } },
  'zero-size': { rect: { left: 20, top: 100, right: 20, bottom: 100, width: 0, height: 0 } },
  '1px by 1px': { rect: { left: 20, top: 100, right: 21, bottom: 101, width: 1, height: 1 } },
  'aria-hidden on the field': { attrs: { 'aria-hidden': 'true' } },
  'aria-hidden on an ancestor': { ancestors: [{ attrs: {} }, { attrs: { 'aria-hidden': 'true' } }] },
  'tabindex=-1': { attrs: { tabindex: '-1' } },
  'opacity 0': { style: { opacity: '0' } },
  'visibility hidden': { style: { visibility: 'hidden' } },
  'inside a display:none ancestor': { ancestors: [{ style: { display: 'none' } }] },
};

const REAL_EMAIL = { type: 'email', name: 'email', id: 'email', autocomplete: 'email' };

for (const [label, overrides] of Object.entries(HONEYPOTS)) {
  test(`a honeypot email field ${label} is never filled`, async () => {
    const trap = makeEl({ ...REAL_EMAIL, ...overrides });
    const got = await quiet(() => winner([trap], 'input[type="email"]', 'jane@example.com'));
    assert.equal(got, null);
  });

  test(`the real email field is chosen over a honeypot ${label}`, async () => {
    const trap = makeEl({ ...REAL_EMAIL, ...overrides });
    const real = makeEl({ ...REAL_EMAIL, id: 'contact-email' });
    // The trap comes first in the DOM, like a real bot trap. If it were
    // fillable the two would tie on score and the resolver would abstain, so
    // "real wins" also proves the trap was excluded.
    const got = await quiet(() => winner([trap, real], 'input[type="email"]', 'jane@example.com'));
    assert.equal(got, real);
  });
}

test('an ordinary visible field is still fillable (no regression)', async () => {
  const real = makeEl({ ...REAL_EMAIL });
  const got = await quiet(() => winner([real], 'input[type="email"]', 'jane@example.com'));
  assert.equal(got, real);
});

test('a field far down a long page is still fillable (scrolled, not hidden)', async () => {
  const view = { scrollY: 4000 };
  const real = makeEl({
    ...REAL_EMAIL,
    // Viewport-relative top is negative once the page has been scrolled past it.
    rect: { left: 20, top: -3900, right: 220, bottom: -3870, width: 200, height: 30 },
  });
  real.ownerDocument.defaultView.scrollY = view.scrollY;
  const got = await quiet(() => winner([real], 'input[type="email"]', 'jane@example.com'));
  assert.equal(got, real, 'a negative viewport top is normal after scrolling; only the document origin counts');
});
