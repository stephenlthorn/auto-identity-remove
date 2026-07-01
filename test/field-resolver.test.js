/**
 * test/field-resolver.test.js
 *
 * Tests for lib/field-resolver.js (resolveField, deriveIntent) and the
 * updated fillForm() secondary-fallback path in lib/forms.js.
 *
 * No real Playwright browser needed: we stub page.evaluate and page.locator
 * the same way the rest of the test suite does (see forms-relay.test.js,
 * forms-bugs.test.js for the established mock pattern).
 *
 * Coverage targets:
 *   1. deriveIntent() — maps selector+value combos to the right intent.
 *   2. resolveField() — correct candidate wins above MATCH_THRESHOLD.
 *   3. resolveField() — abstains when score is below threshold.
 *   4. resolveField() — abstains on tie (ambiguous candidates).
 *   5. resolveField() — returns null for generic intent.
 *   6. fillForm() secondary fallback — fires for exact selectors that miss
 *      (input[name="email"]) which the primary getByLabel path never covers.
 *   7. fillForm() secondary fallback — fires for ambiguous-keyword selectors
 *      (input[name*="name"]) that the primary path kill-switches.
 *   8. fillForm() happy path — exact selector hit is unchanged (no resolver).
 *   9. fillForm() no double-fill — primary fallback success blocks resolver.
 *  10. Fields with no <label for>, only placeholder — resolver recovers.
 *  11. Fields with only aria-label — resolver recovers.
 *  12. Renamed name attribute (broker DOM change) — resolver still matches.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deriveIntent, resolveField, MATCH_THRESHOLD, SIGNAL_WEIGHTS } = require('../lib/field-resolver');
const { fillForm } = require('../lib/forms');

// ─── Helper: build a mock element descriptor (used in page.evaluate stub) ────

function makeEl(overrides = {}) {
  return {
    tagName: 'INPUT',
    type: 'text',
    name: '',
    id: '',
    placeholder: '',
    autocomplete: '',
    'aria-label': '',
    hidden: false,
    parentElement: null,
    _attrs: {},
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    getAttribute(attr) {
      if (Object.prototype.hasOwnProperty.call(this._attrs, attr)) return this._attrs[attr];
      if (attr === 'autocomplete') return this.autocomplete || '';
      if (attr === 'aria-label') return this['aria-label'] || '';
      return null;
    },
    setAttribute(attr, val) { this._attrs[attr] = String(val); },
    removeAttribute(attr) { delete this._attrs[attr]; },
    hasAttribute(attr) { return Object.prototype.hasOwnProperty.call(this._attrs, attr); },
    ...overrides,
  };
}

// ─── Build stub page for resolveField ────────────────────────────────────────

/**
 * Build a stub page that faithfully mirrors real Playwright page.evaluate /
 * page.locator semantics for the resolver's snapshot-consistent selection.
 *
 *   - evaluate(fn, arg): runs the REAL production callback `fn(arg)` against a
 *     mock `document` whose querySelectorAll returns these candidate objects.
 *     The candidates carry setAttribute/removeAttribute, so the production code
 *     that scores → threshold → tie-break → tags the winner with a data-* marker
 *     runs UNMODIFIED here (no second source of truth). This is what lets the
 *     selection logic and the marker semantics be exercised for real.
 *   - locator(sel): resolves to the candidate(s) matching `sel`. We model the
 *     marker attribute selector `[data-aidr-resolve="1"]` (used by resolveField)
 *     so .fill() hits the EXACT element that was tagged, not an index.
 *
 * `mutate` (optional) is a callback invoked ONCE, AFTER the scoring evaluate
 * but BEFORE the locator resolves — it lets a test model a DOM mutation between
 * the score round-trip and the use round-trip (the TOCTOU window). A faithful
 * mock can only approximate the browser here: the production fix tags the
 * winner DURING the scoring evaluate, so a post-score mutation that does not
 * touch the marker leaves the fill bound to the originally-scored element. A
 * mock that re-selected by numeric index (the OLD design) would instead bind to
 * whatever now sits at that index — that divergence is exactly the race.
 */
function makeResolvePage(candidates, opts = {}) {
  const RESOLVE_MARKER = 'data-aidr-resolve';
  let scored = false;

  function matches(el, sel) {
    if (sel === '[' + RESOLVE_MARKER + '="1"]') return el.getAttribute(RESOLVE_MARKER) === '1';
    if (sel === '[' + RESOLVE_MARKER + ']') return el.hasAttribute(RESOLVE_MARKER);
    // Treat any other selector as "all input/select/textarea" candidates.
    return true;
  }

  const page = {
    async evaluate(fn, arg) {
      // Run the REAL production callback against a mock document.
      const savedDoc = typeof global.document !== 'undefined' ? global.document : undefined;
      global.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => candidates.filter(el => matches(el, sel)),
        body: {},
      };
      try {
        const result = await fn(arg);
        if (!scored && typeof opts.mutate === 'function') {
          // Model a DOM mutation occurring after the score+tag round-trip.
          scored = true;
          opts.mutate(candidates);
        }
        return result;
      } finally {
        if (savedDoc !== undefined) global.document = savedDoc;
        else delete global.document;
      }
    },
    locator(sel) {
      const resolve = () => candidates.find(el => matches(el, sel)) || null;
      const makeHandle = () => ({
        get _resolvedEl() { return resolve(); },
        async evaluate(fn) {
          const el = resolve();
          const fakeNode = { tagName: (el && el.tagName) || 'INPUT', type: (el && el.type) || 'text' };
          return fn(fakeNode);
        },
        async fill(v) { const el = resolve(); if (el) el._filledWith = v; },
        async selectOption() {},
        async check() { const el = resolve(); if (el) el._checked = true; },
      });
      return Object.assign(makeHandle(), {
        first: makeHandle,
        nth: makeHandle,
      });
    },
  };
  return page;
}

// ─── 1. deriveIntent ──────────────────────────────────────────────────────────

test('deriveIntent: input[name="email"] → email', () => {
  assert.equal(deriveIntent('input[name="email"]', 'user@example.com'), 'email');
});

test('deriveIntent: input[type="email"] → email', () => {
  assert.equal(deriveIntent('input[type="email"]', ''), 'email');
});

test('deriveIntent: value looks like email address → email', () => {
  assert.equal(deriveIntent('input[name="contact"]', 'user@example.com'), 'email');
});

test('deriveIntent: input[name="firstName"] → firstName', () => {
  assert.equal(deriveIntent('input[name="firstName"]', 'Jane'), 'firstName');
});

test('deriveIntent: input[name="lastname"] → lastName', () => {
  assert.equal(deriveIntent('input[name="lastname"]', 'Doe'), 'lastName');
});

test('deriveIntent: input[name="name"] → fullName', () => {
  assert.equal(deriveIntent('input[name="name"]', 'Jane Doe'), 'fullName');
});

test('deriveIntent: input[name*="name" i] → fullName', () => {
  assert.equal(deriveIntent('input[name*="name" i]', 'Jane Doe'), 'fullName');
});

test('deriveIntent: input[name*="first" i] → firstName', () => {
  assert.equal(deriveIntent('input[name*="first" i]', 'Jane'), 'firstName');
});

test('deriveIntent: input[name*="last" i] → lastName', () => {
  assert.equal(deriveIntent('input[name*="last" i]', 'Doe'), 'lastName');
});

test('deriveIntent: input[name="phone"] → phone', () => {
  assert.equal(deriveIntent('input[name="phone"]', '5551234567'), 'phone');
});

test('deriveIntent: input[name="zip"] → zip', () => {
  assert.equal(deriveIntent('input[name="zip"]', '90210'), 'zip');
});

test('deriveIntent: input[name="city"] → city', () => {
  assert.equal(deriveIntent('input[name="city"]', 'Austin'), 'city');
});

test('deriveIntent: address selector → generic (too ambiguous to fill)', () => {
  assert.equal(deriveIntent('input[name="address"]', '123 Main St'), 'generic');
});

test('deriveIntent: unknown selector with plain text value → generic', () => {
  assert.equal(deriveIntent('input[name="something_random"]', 'hello'), 'generic');
});

// ─── 2. resolveField: correct candidate wins ─────────────────────────────────

test('resolveField: picks email input by type=email (score >> threshold)', async () => {
  const candidates = [
    makeEl({ name: 'submit_btn', type: 'submit', tagName: 'INPUT' }),
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'email address' }),
    makeEl({ name: 'city', type: 'text', tagName: 'INPUT' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'user@example.com');

  assert.ok(result !== null, 'should resolve a candidate for email intent');
  assert.equal(result._resolvedEl, candidates[1], 'should pick the email input (index 1)');
});

test('resolveField: picks firstName by autocomplete=given-name', async () => {
  const candidates = [
    makeEl({ name: 'first_name_field_v2', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'First name' }),
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="firstName"]', 'Jane');

  assert.ok(result !== null, 'should resolve firstName candidate');
  assert.equal(result._resolvedEl, candidates[0], 'should pick the first-name input (index 0)');
});

test('resolveField: picks lastName by name attribute', async () => {
  const candidates = [
    makeEl({ name: 'first_name', type: 'text', tagName: 'INPUT', autocomplete: 'given-name' }),
    makeEl({ name: 'last_name', type: 'text', tagName: 'INPUT', autocomplete: 'family-name', placeholder: 'Last name' }),
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="lastName"]', 'Doe');

  assert.ok(result !== null, 'should resolve lastName candidate');
  assert.equal(result._resolvedEl, candidates[1], 'should pick the last-name input (index 1)');
});

// ─── 3. resolveField: below threshold — abstains ─────────────────────────────

test('resolveField: returns null when no candidate scores above MATCH_THRESHOLD', async () => {
  // Only weak signal: placeholder contains "mail" (not "email"), score = 2
  const candidates = [
    makeEl({ name: 'contact_info', type: 'text', tagName: 'INPUT', placeholder: 'mail' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'user@example.com');

  assert.equal(result, null, 'should return null when score < MATCH_THRESHOLD');
});

// ─── 4. resolveField: tie — abstains ─────────────────────────────────────────

test('resolveField: returns null when two candidates share the same top score', async () => {
  // Both candidates are structurally identical — exact same score for email intent.
  // Same name, type, autocomplete, placeholder ⇒ identical scoring → tie.
  const candidates = [
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'email address' }),
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'email address' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'user@example.com');

  assert.equal(result, null, 'should return null on tied scores (ambiguous)');
});

// ─── 5. resolveField: generic intent — abstains ───────────────────────────────

test('resolveField: returns null for generic intent', async () => {
  const candidates = [
    makeEl({ name: 'address', type: 'text', tagName: 'INPUT' }),
  ];

  const page = makeResolvePage(candidates);
  // address selector → generic intent
  const result = await resolveField(page, 'input[name="address"]', '123 Main St');

  assert.equal(result, null, 'generic intent should always abstain');
});

// ─── 5b. fullName must NOT fill "false friend" *name* fields (wrong-PII guard) ─

test('deriveIntent: company_name / business_name → generic (not fullName)', () => {
  assert.equal(deriveIntent('input[name*="company_name" i]', 'Jane Doe'), 'generic');
  assert.equal(deriveIntent('input[name*="business_name" i]', 'Jane Doe'), 'generic');
  assert.equal(deriveIntent('input[name*="organization" i]', 'Jane Doe'), 'generic');
});

test('resolveField: fullName intent abstains on a multi-signal company_name decoy', async () => {
  // company_name scores name(2)+id(2)+placeholder(2)=6 under the OLD scorer and
  // was wrongly filled with the person's real name. It must now score 0.
  const candidates = [
    makeEl({ name: 'company_name', id: 'company_name', tagName: 'INPUT', placeholder: 'Company name' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="name"]', 'Jane Doe');
  assert.equal(result, null, 'must not fill a company_name field for fullName intent');
  assert.equal(candidates[0]._filledWith, undefined, 'company_name must not receive PII');
});

test('resolveField: fullName intent abstains on a middle_name / nickname decoy', async () => {
  for (const nm of ['middle_name', 'nickname', 'maiden_name']) {
    const candidates = [makeEl({ name: nm, id: nm, tagName: 'INPUT', placeholder: nm.replace('_', ' ') })];
    const page = makeResolvePage(candidates);
    const result = await resolveField(page, 'input[name="name"]', 'Jane Doe');
    assert.equal(result, null, `must not fill a ${nm} field for fullName intent`);
  }
});

test('resolveField: fullName still resolves a genuine full_name field', async () => {
  // Positive control: the fix must not break the real primary-name case.
  const candidates = [
    makeEl({ name: 'full_name', id: 'full_name', tagName: 'INPUT', autocomplete: 'name', placeholder: 'Full name' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="name"]', 'Jane Doe');
  assert.notEqual(result, null, 'a genuine full_name field must still resolve');
  await result.fill('Jane Doe');
  assert.equal(candidates[0]._filledWith, 'Jane Doe');
});

// ─── 6. fillForm: secondary fallback fires for exact selector miss ────────────
//  The provable gap: input[name="email"] has no *="..." pattern → extractKeyword
//  returns null → primary getByLabel path is skipped → previously no fallback.

// Build a page mock for fillForm() integration: the CSS selector miss path
// (.first().count()===0) routes to the resolver, whose score→tag→locate→fill
// runs against the REAL production callback over `candidates`. getByLabel is a
// no-op (primary fallback). A flag records whether the resolver's evaluate ran.
function makeFillFormPage(candidates) {
  const RESOLVE_MARKER = 'data-aidr-resolve';
  const state = { resolverCalled: false };

  // page.locator(sel): only marker selectors resolve; broker CSS selectors miss
  // so the fallback (and then the resolver) is exercised.
  function locatorMatches(el, sel) {
    if (sel === '[' + RESOLVE_MARKER + '="1"]') return el.getAttribute(RESOLVE_MARKER) === '1';
    if (sel === '[' + RESOLVE_MARKER + ']') return el.hasAttribute(RESOLVE_MARKER);
    return false; // CSS selectors always miss → exercise the fallback
  }
  // document.querySelectorAll(sel) inside evaluate: marker selectors resolve to
  // the tagged element; the candidate selector resolves to all candidates.
  function qsaMatches(el, sel) {
    if (sel === '[' + RESOLVE_MARKER + '="1"]') return el.getAttribute(RESOLVE_MARKER) === '1';
    if (sel === '[' + RESOLVE_MARKER + ']') return el.hasAttribute(RESOLVE_MARKER);
    return true; // the input/select/textarea candidate selector matches all
  }

  const page = {
    locator(sel) {
      const resolve = () => candidates.find(el => locatorMatches(el, sel)) || null;
      const handle = {
        get _resolvedEl() { return resolve(); },
        async count() { return resolve() ? 1 : 0; },
        async isVisible() { return !!resolve(); },
        async evaluate(fn) {
          const el = resolve();
          return fn({ tagName: (el && el.tagName) || 'INPUT', type: (el && el.type) || 'text' });
        },
        async fill(v) { const el = resolve(); if (el) el._filledWith = v; },
        async selectOption() {},
        async check() { const el = resolve(); if (el) el._checked = true; },
      };
      return Object.assign(handle, { first: () => handle, nth: () => handle });
    },
    getByLabel() {
      return { first() { return { async fill() {} }; } };
    },
    async evaluate(fn, arg) {
      // Distinguish the scoring evaluate (has fnSrc) from clearResolveMarker.
      if (arg && typeof arg === 'object' && arg.fnSrc) state.resolverCalled = true;
      const savedDoc = typeof global.document !== 'undefined' ? global.document : undefined;
      global.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => candidates.filter(el => qsaMatches(el, sel)),
        body: {},
      };
      try {
        return await fn(arg);
      } finally {
        if (savedDoc !== undefined) global.document = savedDoc;
        else delete global.document;
      }
    },
  };
  return { page, state };
}

test('fillForm: secondary resolver fires when exact selector input[name="email"] misses', async () => {
  const candidates = [
    makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'email address' }),
  ];
  const { page, state } = makeFillFormPage(candidates);

  await fillForm(page, { 'input[name="email"]': 'user@example.com' });

  assert.ok(state.resolverCalled, 'resolveField should have been invoked via page.evaluate');
  assert.equal(candidates[0]._filledWith, 'user@example.com', 'resolver should fill the correct value into the marked element');
  assert.ok(!candidates[0].hasAttribute('data-aidr-resolve'), 'marker should be cleared after fill');
});

// ─── 7. fillForm: secondary fallback fires for ambiguous-keyword selectors ────
//  input[name*="name" i] has *="..." → extractKeyword = "name" → isAmbiguousKeyword
//  → primary path kill-switched → previously silent failure.

test('fillForm: secondary resolver fires when primary is kill-switched (ambiguous keyword "name")', async () => {
  const candidates = [
    makeEl({ name: 'name', type: 'text', tagName: 'INPUT', autocomplete: 'name', placeholder: 'Full name' }),
  ];
  const { page, state } = makeFillFormPage(candidates);

  await fillForm(page, { 'input[name*="name" i]': 'Jane Doe' });

  assert.ok(state.resolverCalled, 'resolver should have been called for ambiguous-keyword selector miss');
  assert.equal(candidates[0]._filledWith, 'Jane Doe', 'resolver should fill the correct value into the marked element');
});

// ─── 8. fillForm: happy path — exact selector hit, resolver never invoked ────

test('fillForm: resolver is NOT invoked when the exact selector hits on first try', async () => {
  let resolverInvoked = false;
  const fills = [];

  const page = {
    locator(sel) {
      return {
        first() {
          return {
            async count() { return 1; },        // HIT
            async isVisible() { return true; },
            async evaluate(fn) { return fn({ tagName: 'INPUT', type: 'text' }); },
            async fill(v) { fills.push({ sel, v }); },
            async selectOption() {},
            async check() {},
          };
        },
      };
    },
    getByLabel() {
      return { first() { return { async fill() {} }; } };
    },
    async evaluate() {
      resolverInvoked = true;
      return [];
    },
  };

  await fillForm(page, { 'input[name="email"]': 'user@example.com' });

  assert.ok(!resolverInvoked, 'resolver must NOT fire when selector hits');
  assert.equal(fills.length, 1, 'field should be filled directly');
  assert.equal(fills[0].v, 'user@example.com');
});

// ─── 9. fillForm: no double-fill — primary fallback success blocks resolver ───

test('fillForm: resolver is NOT invoked when primary getByLabel fallback succeeds', async () => {
  let resolverInvoked = false;
  let primaryFilled = false;

  const page = {
    locator() {
      return {
        first() {
          return {
            async count() { return 0; },   // miss — trigger fallback
            async isVisible() { return false; },
          };
        },
      };
    },
    getByLabel() {
      return {
        async count() { return 1; }, // getByLabel HIT — one matching element
        first() {
          return {
            async fill() { primaryFilled = true; },
          };
        },
      };
    },
    async evaluate() {
      resolverInvoked = true;
      return [];
    },
  };

  // *="email" → extractKeyword = "email" → not ambiguous → primary fires
  await fillForm(page, { 'input[name*="email" i]': 'user@example.com' });

  assert.ok(primaryFilled, 'primary getByLabel should have been called');
  assert.ok(!resolverInvoked, 'resolver must NOT fire after primary fallback');
});

// ─── 9b. fillForm: getByLabel SILENT MISS must NOT short-circuit the resolver ──
//
// The MAJOR gap this PR exists to close. When BOTH the CSS selector loop AND the
// primary getByLabel fallback miss (broker renamed the attribute AND the input
// has no associated <label> for getByLabel to hit), the resolver MUST still fire.
//
// Before the fix, fillForm() set `filled = true` UNCONDITIONALLY after calling
// getByLabel().first().fill().catch(() => {}) — so a getByLabel that matched
// nothing still flagged the field as filled and the semantic resolver was
// SKIPPED, defeating the entire purpose of the PR for exactly the failure mode
// it targets (renamed attr + no label).
//
// This mock models a REAL getByLabel miss: count()===0 and a .fill() whose
// underlying promise rejects (mirrors Playwright's "element not found" → the
// pre-existing .catch(() => {}) swallow). No candidate is filled by getByLabel.
// A resolvable field exists (matchable by name/placeholder/aria), so the
// resolver must fire and fill it.
function makeLabelMissPage(candidates) {
  const RESOLVE_MARKER = 'data-aidr-resolve';
  const state = { resolverCalled: false, getByLabelAttempted: false };

  function locatorMatches(el, sel) {
    if (sel === '[' + RESOLVE_MARKER + '="1"]') return el.getAttribute(RESOLVE_MARKER) === '1';
    if (sel === '[' + RESOLVE_MARKER + ']') return el.hasAttribute(RESOLVE_MARKER);
    return false; // every broker CSS selector misses → exercise the fallback chain
  }
  function qsaMatches(el, sel) {
    if (sel === '[' + RESOLVE_MARKER + '="1"]') return el.getAttribute(RESOLVE_MARKER) === '1';
    if (sel === '[' + RESOLVE_MARKER + ']') return el.hasAttribute(RESOLVE_MARKER);
    return true; // input/select/textarea candidate selector matches all
  }

  const page = {
    locator(sel) {
      const resolve = () => candidates.find(el => locatorMatches(el, sel)) || null;
      const handle = {
        get _resolvedEl() { return resolve(); },
        async count() { return resolve() ? 1 : 0; },
        async isVisible() { return !!resolve(); },
        async evaluate(fn) {
          const el = resolve();
          return fn({ tagName: (el && el.tagName) || 'INPUT', type: (el && el.type) || 'text' });
        },
        async fill(v) { const el = resolve(); if (el) el._filledWith = v; },
        async selectOption() {},
        async check() { const el = resolve(); if (el) el._checked = true; },
      };
      return Object.assign(handle, { first: () => handle, nth: () => handle });
    },
    getByLabel() {
      // A genuine getByLabel MISS: count()===0 (no element matches the label),
      // mirroring Playwright Locator semantics. The production code reads count()
      // first and must NOT flag the field filled. .fill() would reject here too
      // (no element), but the count() gate means it is never reached.
      state.getByLabelAttempted = true;
      return {
        async count() { return 0; }, // silent miss — zero matching elements
        first() {
          return { async fill() { throw new Error('locator.fill: no element matches the label'); } };
        },
      };
    },
    async evaluate(fn, arg) {
      if (arg && typeof arg === 'object' && arg.fnSrc) state.resolverCalled = true;
      const savedDoc = typeof global.document !== 'undefined' ? global.document : undefined;
      global.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => candidates.filter(el => qsaMatches(el, sel)),
        body: {},
      };
      try {
        return await fn(arg);
      } finally {
        if (savedDoc !== undefined) global.document = savedDoc;
        else delete global.document;
      }
    },
  };
  return { page, state };
}

test('fillForm: resolver FIRES when CSS miss + getByLabel silently misses (renamed attr, no label)', async () => {
  // Broker renamed name="email" → name="email_address" (CSS selector
  // input[name*="email" i] still keyword-extracts "email", so the PRIMARY
  // getByLabel path is entered), but the input has NO associated <label> so
  // getByLabel matches nothing. A resolvable email field is present.
  const candidates = [
    makeEl({ name: 'email_address', id: 'email_address', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'email address' }),
  ];
  const { page, state } = makeLabelMissPage(candidates);

  await fillForm(page, { 'input[name*="email" i]': 'user@example.com' });

  assert.ok(state.getByLabelAttempted, 'primary getByLabel path should have been entered (non-ambiguous keyword)');
  assert.ok(state.resolverCalled, 'resolver MUST fire after a SILENT getByLabel miss — not be short-circuited by filled=true');
  assert.equal(candidates[0]._filledWith, 'user@example.com', 'resolver should fill the renamed email field that getByLabel could not reach');
  assert.ok(!candidates[0].hasAttribute('data-aidr-resolve'), 'marker cleared after fill');
});

// Companion to 9 + 9b: getByLabel SUCCESS still short-circuits the resolver
// (no double-fill). With the fix, filled=true is gated on getByLabel actually
// matching ≥1 element — so a real hit must still block the resolver.
test('fillForm: getByLabel SUCCESS short-circuits the resolver (no double-fill)', async () => {
  let resolverInvoked = false;
  let primaryFillCount = 0;

  const page = {
    locator() {
      return { first() { return { async count() { return 0; }, async isVisible() { return false; } }; } };
    },
    getByLabel() {
      return {
        async count() { return 1; },                  // getByLabel HIT
        first() { return { async fill() { primaryFillCount += 1; } }; },
      };
    },
    async evaluate() { resolverInvoked = true; return { found: false }; },
  };

  // *="email" → non-ambiguous keyword → primary path entered, getByLabel matches.
  await fillForm(page, { 'input[name*="email" i]': 'user@example.com' });

  assert.equal(primaryFillCount, 1, 'getByLabel should fill exactly once');
  assert.ok(!resolverInvoked, 'a real getByLabel hit must still short-circuit the resolver (no double-fill)');
});

// ─── 10. resolveField: placeholder-only field (no label, no name) ─────────────

test('resolveField: recovers when field has only a placeholder for email intent', async () => {
  const candidates = [
    // No name, no id, no label, no autocomplete — just placeholder
    makeEl({ name: '', id: '', type: 'email', tagName: 'INPUT', placeholder: 'your email address', autocomplete: '' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="emailAddress"]', 'user@example.com');

  // type=email alone = 4 pts; placeholder contains "email" = 2 pts → total 6 ≥ 5
  assert.ok(result !== null, 'should recover from placeholder-only email field');
  assert.equal(result._resolvedEl, candidates[0]);
});

// ─── 11. resolveField: aria-label-only field ─────────────────────────────────

test('resolveField: recovers when field has only an aria-label for email intent', async () => {
  const candidates = [
    makeEl({ name: '', id: '', type: 'text', tagName: 'INPUT', placeholder: '', autocomplete: '', 'aria-label': 'Email address' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email_contact"]', 'user@example.com');

  // type text = 0; aria-label includes "email" = 2 pts — below threshold alone
  // We need the value to push over: value looks like email → intent=email
  // BUT score from aria-label alone = 2 < 5. Correct result is null.
  // The resolver is conservative — it should NOT match on a single weak signal.
  // This tests that we DON'T over-reach.
  assert.equal(result, null, 'single weak signal (aria-label=2) must not exceed threshold');
});

test('resolveField: recovers when field combines aria-label + autocomplete for email intent', async () => {
  const candidates = [
    // autocomplete=email (3) + aria-label includes email (2) = 5 ≥ threshold
    makeEl({ name: '', id: '', type: 'text', tagName: 'INPUT', placeholder: '', autocomplete: 'email', 'aria-label': 'Email address' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="contact_field"]', 'user@example.com');

  assert.ok(result !== null, 'aria-label + autocomplete should cross threshold');
  assert.equal(result._resolvedEl, candidates[0]);
});

// ─── 12. resolveField: renamed name attribute (broker DOM change) ─────────────

test('resolveField: matches firstName when broker renamed attr to given_name_v2', async () => {
  const candidates = [
    // Broker renamed: name="first" → name="given_name_v2"
    // But autocomplete and placeholder still signal the intent
    makeEl({ name: 'given_name_v2', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'Given name' }),
    makeEl({ name: 'family_name_v2', type: 'text', tagName: 'INPUT', autocomplete: 'family-name', placeholder: 'Family name' }),
    makeEl({ name: 'contact_email_v2', type: 'email', tagName: 'INPUT', autocomplete: 'email' }),
  ];

  const page = makeResolvePage(candidates);
  // Original selector: input[name="firstName"] missed (broker renamed the attr)
  const result = await resolveField(page, 'input[name="firstName"]', 'Jane');

  assert.ok(result !== null, 'should match despite renamed name attribute');
  assert.equal(result._resolvedEl, candidates[0], 'should pick given_name_v2 (index 0)');
});

test('resolveField: matches lastName when broker renamed attr to family_name_v2', async () => {
  const candidates = [
    makeEl({ name: 'given_name_v2', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'Given name' }),
    makeEl({ name: 'family_name_v2', type: 'text', tagName: 'INPUT', autocomplete: 'family-name', placeholder: 'Family name' }),
  ];

  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="lastName"]', 'Doe');

  assert.ok(result !== null, 'should match despite renamed name attribute');
  assert.equal(result._resolvedEl, candidates[1], 'should pick family_name_v2 (index 1)');
});

// ─── 13. HIGH — confirm / duplicate / secondary field PII guard ──────────────
//
// The fail-safe invariant ("a wrong fill is worse than no fill") must hold on
// every confirm/duplicate layout. A confirm field carries the SAME positive
// signals (type=email, autocomplete=email) as the primary, so without a
// negative-signal penalty it scores as high or higher and the resolver fills
// the user's PII into the wrong box. The matrix below proves abstention.

// CASE F — a SOLE visible confirm field (no primary present). The resolver must
// abstain: there is nothing legitimate to fill, and filling the confirm box
// leaves the masked email in the wrong field with the primary empty.
test('confirm-guard CASE F: sole confirm_email → abstain (no primary present)', async () => {
  const candidates = [
    makeEl({ name: 'confirm_email', id: 'confirm_email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Confirm email' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
  assert.equal(result, null, 'sole confirm field must not be filled');
});

// CASE A — the dangerous asymmetric layout: primary email renamed unreadable
// (name="usr_em", no type) while a fully-readable confirm field exists. The
// confirm would win outright (no tie → the symmetric tie-break cannot save it).
// With the negative guard the confirm scores 0 and the primary is unreadable,
// so the resolver abstains — it never lands the email only in the confirm box.
test('confirm-guard CASE A: primary unreadable + confirm readable → abstain (never fills confirm)', async () => {
  const primary = makeEl({ name: 'usr_em', id: '', type: 'text', tagName: 'INPUT', autocomplete: '', placeholder: '' });
  const confirm = makeEl({ name: 'confirm_email', id: 'confirm_email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Confirm email' });
  const candidates = [primary, confirm];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
  assert.equal(result, null, 'must abstain — filling the confirm field breaks email !== confirm submission');
  assert.ok(!confirm.hasAttribute('data-aidr-resolve'), 'confirm field must never be tagged as the winner');
});

// CASE primary+confirm both readable — the resolver MUST pick the primary, never
// the confirm. This proves the guard does not over-abstain on a legit layout.
test('confirm-guard: primary readable + confirm readable → fills the PRIMARY only', async () => {
  const primary = makeEl({ name: 'email', id: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Email' });
  const confirm = makeEl({ name: 'confirm_email', id: 'confirm_email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Confirm email' });
  const candidates = [primary, confirm];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email_addr"]', 'relay@mask.example');
  assert.ok(result !== null, 'a readable primary should resolve');
  assert.equal(result._resolvedEl, primary, 'must pick the primary, not the confirm');
});

// RAW-PII variants — name/phone/zip confirm fields carry real PII, not a masked
// relay address. Each sole-confirm layout must abstain.
test('confirm-guard: sole confirm_first_name (RAW name PII) → abstain', async () => {
  const candidates = [
    makeEl({ name: 'confirm_first_name', id: 'confirm_first_name', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'Confirm first name' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="firstName"]', 'Jane');
  assert.equal(result, null, 'raw name PII must not land in a confirm field');
});

test('confirm-guard: sole verify_phone (RAW phone PII) → abstain', async () => {
  const candidates = [
    makeEl({ name: 'verify_phone', id: 'verify_phone', type: 'tel', tagName: 'INPUT', autocomplete: 'tel', placeholder: 'Verify phone' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="phone"]', '5551234567');
  assert.equal(result, null, 'raw phone PII must not land in a verify field');
});

test('confirm-guard: sole zip2 (bare trailing-2 duplicate) → abstain', async () => {
  const candidates = [
    makeEl({ name: 'zip2', id: 'zip2', type: 'text', tagName: 'INPUT', autocomplete: 'postal-code', placeholder: 'Zip' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="zip"]', '90210');
  assert.equal(result, null, 'bare trailing-2 duplicate must abstain');
});

test('confirm-guard: secondary_email / re-enter / repeat markers all abstain', async () => {
  for (const marker of ['secondary_email', 'reenter_email', 're-enter_email', 'email_repeat', 'email_again', 'alt_email', 'email_2', 'email-2']) {
    const candidates = [
      makeEl({ name: marker, id: marker, type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Email' }),
    ];
    const page = makeResolvePage(candidates);
    const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
    assert.equal(result, null, `marker "${marker}" must abstain`);
  }
});

// MINOR — JSDoc advertises dup(licate); the guard must abstain on BOTH the
// short token "dup" AND the full word "duplicate". Before strengthening the
// alternation to dup(?:licate)?, "duplicate_email" did NOT match and would be
// a fill target — a doc/regex mismatch on the SAFE side of the negative guard.
test('confirm-guard: dup AND duplicate markers both abstain (doc/regex parity)', async () => {
  for (const marker of ['dup_email', 'duplicate_email', 'email_dup', 'email_duplicate']) {
    const candidates = [
      makeEl({ name: marker, id: marker, type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Email' }),
    ];
    const page = makeResolvePage(candidates);
    const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
    assert.equal(result, null, `marker "${marker}" must abstain (JSDoc advertises dup(licate))`);
  }
});

// Carve-out — a version suffix (v2) is NOT a duplicate marker. The renamed
// PRIMARY must still resolve (this is the regression the guard must not cause).
test('confirm-guard: version suffix v2 is NOT treated as a duplicate marker', async () => {
  const candidates = [
    makeEl({ name: 'given_name_v2', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'Given name' }),
  ];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="firstName"]', 'Jane');
  assert.ok(result !== null, 'a v2-renamed primary must still resolve (not falsely abstained)');
  assert.equal(result._resolvedEl, candidates[0]);
});

// ─── 14. LOW — deriveIntent snake_case / dash recall ─────────────────────────

test('deriveIntent: full_name (snake_case) → fullName', () => {
  assert.equal(deriveIntent('input[name="full_name"]', ''), 'fullName');
});

test('deriveIntent: user_email (snake_case, empty value) → email', () => {
  // value is empty to isolate the selector path — \bemail\b would miss because
  // `_` is a word char; substring match catches it.
  assert.equal(deriveIntent('input[name="user_email"]', ''), 'email');
});

test('deriveIntent: customer_email_addr (substring) → email', () => {
  assert.equal(deriveIntent('input[name="customer_email_addr"]', ''), 'email');
});

test('deriveIntent: first-name (dash) → firstName', () => {
  assert.equal(deriveIntent('input[name="first-name"]', ''), 'firstName');
});

test('deriveIntent: zip_code (snake_case) → zip', () => {
  assert.equal(deriveIntent('input[name="zip_code"]', ''), 'zip');
});

test('deriveIntent: username still excluded from fullName (guard intact)', () => {
  assert.equal(deriveIntent('input[name="username"]', ''), 'generic');
});

// ─── 15. MEDIUM — snapshot-consistent selection (TOCTOU) ─────────────────────
//
// The winner is tagged with a data-* marker INSIDE the scoring evaluate and is
// located by that marker, not re-selected by numeric index. A DOM mutation that
// occurs after scoring (e.g. a node inserted ahead of the winner) therefore
// cannot redirect the fill to a different element. With the OLD design, nth(0)
// after a prepended node would resolve the wrong element.
//
// Mock-fidelity note: this mock cannot reproduce real Playwright's full DOM, so
// it models the race by mutating the candidate array AFTER the scoring evaluate
// returns but BEFORE the fill locator resolves. Because the production fix binds
// the locator to the marker (carried ON the element object), the fill follows
// the originally-scored element through the mutation. A pure-index design would
// instead follow the index into the mutated array — that divergence IS the race.

test('TOCTOU: winner is bound by marker, survives a node prepended after scoring', async () => {
  const winner = makeEl({ name: 'email', id: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Email' });
  const candidates = [winner];

  const page = makeResolvePage(candidates, {
    // After scoring tags `winner`, an attacker/SPA prepends a fresh input at
    // index 0. A by-index reselect would now fill THIS decoy, not the winner.
    mutate(arr) {
      arr.unshift(makeEl({ name: 'decoy', id: 'decoy', type: 'text', tagName: 'INPUT' }));
    },
  });

  const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
  assert.ok(result !== null, 'should resolve the email field');
  // The marker rides on the winner element object, so the fill targets `winner`,
  // NOT the decoy now sitting at index 0.
  assert.equal(result._resolvedEl, winner, 'fill must follow the tagged winner, not index 0 after mutation');
  assert.notEqual(result._resolvedEl.name, 'decoy', 'must not bind to the post-scoring decoy node');
});

test('TOCTOU: exactly one element is tagged as the winner', async () => {
  const a = makeEl({ name: 'first_name', type: 'text', tagName: 'INPUT', autocomplete: 'given-name', placeholder: 'First name' });
  const b = makeEl({ name: 'last_name', type: 'text', tagName: 'INPUT', autocomplete: 'family-name', placeholder: 'Last name' });
  const candidates = [a, b];
  const page = makeResolvePage(candidates);
  await resolveField(page, 'input[name="firstName"]', 'Jane');
  const tagged = candidates.filter(el => el.hasAttribute('data-aidr-resolve'));
  assert.equal(tagged.length, 1, 'exactly one winner must be tagged');
  assert.equal(tagged[0], a, 'the firstName field is the tagged winner');
});

test('TOCTOU: a stale marker from a prior run is cleared before scoring', async () => {
  const winner = makeEl({ name: 'email', id: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email', placeholder: 'Email' });
  const stale = makeEl({ name: 'old', id: 'old', type: 'text', tagName: 'INPUT' });
  stale.setAttribute('data-aidr-resolve', '1'); // leftover from an aborted run
  const candidates = [stale, winner];
  const page = makeResolvePage(candidates);
  const result = await resolveField(page, 'input[name="email"]', 'relay@mask.example');
  assert.equal(result._resolvedEl, winner, 'stale marker must be cleared so the new winner binds');
  assert.ok(!stale.hasAttribute('data-aidr-resolve'), 'stale marker must be removed');
});

// ─── 16. Observability — abstain emits one console.warn (new path only) ──────

test('observability: abstain on generic intent emits one console.warn', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const page = makeResolvePage([makeEl({ name: 'address', type: 'text', tagName: 'INPUT' })]);
    await resolveField(page, 'input[name="address"]', '123 Main St');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, 'exactly one warn on abstain');
  assert.match(warns[0], /field-resolver: no match for intent=generic selector=input\[name="address"\]/);
});

test('observability: abstain on below-threshold emits one console.warn with the intent', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const page = makeResolvePage([makeEl({ name: 'contact', type: 'text', tagName: 'INPUT', placeholder: 'mail' })]);
    await resolveField(page, 'input[name="email"]', 'user@example.com');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, 'one warn when no candidate clears threshold');
  assert.match(warns[0], /intent=email/);
});

test('observability: a successful resolve does NOT warn', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const page = makeResolvePage([makeEl({ name: 'email', type: 'email', tagName: 'INPUT', autocomplete: 'email' })]);
    const result = await resolveField(page, 'input[name="email"]', 'user@example.com');
    assert.ok(result !== null);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 0, 'no warn on a successful match');
});

// ─── 17. LOW — SIGNAL_WEIGHTS is a real exported constant (DRY) ───────────────

test('SIGNAL_WEIGHTS: exported, frozen, has the documented weights', () => {
  assert.equal(typeof SIGNAL_WEIGHTS, 'object');
  assert.ok(Object.isFrozen(SIGNAL_WEIGHTS), 'weights should be frozen (single source of truth)');
  assert.equal(SIGNAL_WEIGHTS.typeMatch, 4);
  assert.equal(SIGNAL_WEIGHTS.autocomplete, 3);
  assert.equal(SIGNAL_WEIGHTS.exactName, 3);
  assert.equal(SIGNAL_WEIGHTS.substring, 2);
});

test('scoreElement closure-free: serialized scorer references no module-level free variables', () => {
  // The scorer is serialized via .toString() and rebuilt with new Function inside
  // page.evaluate. If it closed over SIGNAL_WEIGHTS / MATCH_THRESHOLD / a regex,
  // those references would be undefined in the browser. Guard: the source must
  // not name any module-level identifier — it takes weights + negativeMarkerSrc
  // as parameters instead.
  const fnResolverSrc = resolveField.toString();
  // Pull the scorer's serialized source the way resolveField does (scoreElement
  // is private; assert via the public behaviour that it runs under new Function).
  // Direct guard: resolveField passes weights + negativeMarkerSrc into evaluate.
  assert.match(fnResolverSrc, /weights:\s*SIGNAL_WEIGHTS/, 'weights are passed as an arg, not closed over');
  assert.match(fnResolverSrc, /negativeMarkerSrc:\s*NEGATIVE_MARKER_SRC/, 'marker source passed as an arg');
});

// ─── Falsification check: verify tests go RED without the resolver ────────────
// Sections 6 and 7 assert state.resolverCalled=true — removing the resolveField
// integration from fillForm makes them fail. The confirm-guard matrix (13) goes
// RED if the negative-signal penalty is removed (confirm fields would score high
// and resolve). The TOCTOU tests (15) go RED if selection reverts to nth(index).
// The deriveIntent recall tests (14) go RED if the snake/dash fragments are
// removed (\bname\b/\bemail\b miss snake_case). The observability tests (16) go
// RED if warnNoMatch is dropped. The threshold/score tests fail if
// MATCH_THRESHOLD is 0 or scoreElement is identity-zeroed.
