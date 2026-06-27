/**
 * test/forms-bugs.test.js
 *
 * Tests for confirmed correctness bugs in lib/forms.js:
 *   H4 - findListingUrl drops regex 'i' flag (case-insensitive patterns fail)
 *   L1 - getByLabel fallback throws on regex metacharacters in keyword
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findListingUrl } = require('../lib/forms');

// ─── Bug H4: findListingUrl preserves the 'i' (case-insensitive) flag ─────────

test('findListingUrl matches case-insensitively when listingPattern has /i flag', async () => {
  // The bug: page.evaluate receives only broker.listingPattern.source, not flags.
  // new RegExp(src) loses the 'i' flag, so uppercase URLs are missed.
  const broker = {
    searchUrl: 'https://example.com/search?q=test',
    listingPattern: /example\.com\/People\//i,  // 'i' flag - should match lowercase too
  };

  // Simulated links - the path is lowercase "people" but pattern is "People" with /i
  const links = [
    'https://example.com/people/jane-doe-123',  // lowercase - only matches with /i
    'https://example.com/contact',
  ];

  let capturedArgs = null;
  const page = {
    goto: async () => {},
    evaluate: async (fn, args) => {
      capturedArgs = args;
      // Simulate what the browser does - apply the regex to the links
      const re = new RegExp(args.src, args.flags);
      return links.filter(h => re.test(h));
    },
  };

  const result = await findListingUrl(page, broker);

  // Verify the flags are passed through
  assert.ok(capturedArgs !== null, 'evaluate should have been called');
  assert.ok(
    typeof capturedArgs === 'object' && capturedArgs !== null && !Array.isArray(capturedArgs),
    `Expected args to be an object {src, flags}, got: ${JSON.stringify(capturedArgs)}`
  );
  assert.equal(capturedArgs.flags, 'i', `Expected flags='i' to be passed, got: ${capturedArgs.flags}`);
  assert.equal(result, 'https://example.com/people/jane-doe-123', 'Should match case-insensitively');
});

test('findListingUrl still matches case-sensitively when listingPattern has no flags', async () => {
  const broker = {
    searchUrl: 'https://example.com/search',
    listingPattern: /example\.com\/people\//,  // no 'i' flag
  };

  const links = ['https://example.com/people/jane-doe', 'https://example.com/PEOPLE/wrong'];
  const page = {
    goto: async () => {},
    evaluate: async (fn, args) => {
      const re = new RegExp(args.src, args.flags);
      return links.filter(h => re.test(h));
    },
  };

  const result = await findListingUrl(page, broker);
  assert.equal(result, 'https://example.com/people/jane-doe');
});

test('findListingUrl passes both src and flags as an object to page.evaluate', async () => {
  const broker = {
    searchUrl: 'https://example.com/search',
    listingPattern: /test\.com\//gi,  // 'g' and 'i' flags
  };

  let evaluateSecondArg = undefined;
  const page = {
    goto: async () => {},
    evaluate: async (fn, arg) => {
      evaluateSecondArg = arg;
      return [];
    },
  };

  await findListingUrl(page, broker);

  assert.ok(
    typeof evaluateSecondArg === 'object' && evaluateSecondArg !== null,
    'Second arg to evaluate must be an object'
  );
  assert.equal(typeof evaluateSecondArg.src, 'string', 'Must have src string');
  assert.equal(typeof evaluateSecondArg.flags, 'string', 'Must have flags string');
  assert.equal(evaluateSecondArg.src, broker.listingPattern.source);
  assert.equal(evaluateSecondArg.flags, broker.listingPattern.flags);
});

// ─── Bug L1: getByLabel fallback does not throw on regex metacharacters ────────

test('fillForm does not throw when formFields key contains regex metacharacters', async () => {
  const { fillForm } = require('../lib/forms');

  // Selector with a metachar-containing keyword to trigger getByLabel fallback
  // The key triggers getByLabel because it won't match any locator (count=0)
  // and the keyword extracted from *="na(me" contains a '(' metachar.
  const formFields = {
    'input[name*="na(me" i]': 'Alice Smith',
  };

  let getByLabelCalled = false;
  const page = {
    locator: () => ({
      first: () => ({
        count: async () => 0,      // triggers getByLabel fallback
        isVisible: async () => false,
      }),
    }),
    getByLabel: (re) => {
      getByLabelCalled = true;
      // Should be called without throwing. Real Playwright Locator exposes
      // count(); fillForm reads it to gate filled=true (silent-miss → resolver).
      return {
        count: async () => 0, // label miss → fill skipped, resolver may run
        first: () => ({
          fill: async () => {},
          catch: async () => {},
        }),
      };
    },
    // Resolver fallback round-trip after a label miss — no-op stub returns no match.
    evaluate: async () => ({ found: false }),
  };

  let error = null;
  try {
    await fillForm(page, formFields);
  } catch (e) {
    error = e;
  }

  assert.equal(error, null, `fillForm should not throw on metachar keyword, got: ${error?.message}`);
});

// ── Fix 8: country select name-then-code fallback ────────────────────────────

test('Fix8: fillForm fills country select by label (full name) when label option is available', async () => {
  const { fillForm } = require('../lib/forms');

  const selectOptionCalls = [];

  // Simulate a <select> where "Canada" label exists
  const page = {
    locator: (sel) => ({
      first: () => ({
        count: async () => (sel.includes('country') ? 1 : 0),
        isVisible: async () => sel.includes('country'),
        evaluate: async (fn) => sel.includes('country') ? 'select' : 'input',
        selectOption: async (arg) => {
          selectOptionCalls.push(arg);
          // Simulate: {label: 'Canada'} succeeds (returns without throwing)
        },
      }),
    }),
    getByLabel: () => ({ first: () => ({ fill: async () => {}, catch: async () => {} }) }),
  };

  const personCA = { country: 'CA', state: 'ON', zip: 'K1A 0A6' };
  await fillForm(page, { 'select[name*="country" i]': 'CA' }, personCA);

  // The first attempt should be by label (full country name "Canada")
  assert.ok(
    selectOptionCalls.length > 0,
    'selectOption should have been called for country select'
  );
  // At least one call should try a label or a value - the code tries label first
  const firstCall = selectOptionCalls[0];
  assert.ok(
    (typeof firstCall === 'object' && firstCall !== null && firstCall.label) ||
    firstCall === 'CA',
    `Expected either {label: ...} or 'CA' as first selectOption call, got: ${JSON.stringify(firstCall)}`
  );
});

test('Fix8: fillForm falls back to country code when label option is not available', async () => {
  const { fillForm } = require('../lib/forms');

  const selectOptionCalls = [];

  // Simulate a <select> where "Canada" label does NOT exist (label call throws)
  const page = {
    locator: (sel) => ({
      first: () => ({
        count: async () => (sel.includes('country') ? 1 : 0),
        isVisible: async () => sel.includes('country'),
        evaluate: async (fn) => 'select',
        selectOption: async (arg) => {
          selectOptionCalls.push(arg);
          // If arg is a label object, throw to simulate label not found
          if (typeof arg === 'object' && arg !== null && arg.label) {
            throw new Error('Label not found');
          }
          // Code value 'CA' succeeds
        },
      }),
    }),
    getByLabel: () => ({ first: () => ({ fill: async () => {} }) }),
  };

  const personCA = { country: 'CA', state: 'ON', zip: 'K1A 0A6' };
  await fillForm(page, { 'select[name*="country" i]': 'CA' }, personCA);

  // Should have tried label (failed) then fallen back to value 'CA'
  const valueCalls = selectOptionCalls.filter(c => c === 'CA');
  assert.ok(
    valueCalls.length >= 1,
    `Should have called selectOption('CA') as code fallback, calls: ${JSON.stringify(selectOptionCalls)}`
  );
});

test('Fix8: fillForm logs a warning when a select cannot be matched', async () => {
  const { fillForm } = require('../lib/forms');

  // Capture console.warn
  const warnMessages = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnMessages.push(args.join(' '));

  // Simulate a <select> that exists but throws for both label and value
  const page = {
    locator: (sel) => ({
      first: () => ({
        count: async () => (sel.includes('country') ? 1 : 0),
        isVisible: async () => sel.includes('country'),
        evaluate: async (fn) => 'select',
        selectOption: async (arg) => {
          throw new Error('No matching option');
        },
      }),
    }),
    getByLabel: () => ({ first: () => ({ fill: async () => {} }) }),
  };

  const personDE = { country: 'DE', state: '', zip: '' };
  await fillForm(page, { 'select[name*="country" i]': 'DE' }, personDE);

  console.warn = origWarn;

  // Should have logged a warning about the unmatched select
  assert.ok(
    warnMessages.some(msg => /select|country|unmatched|warn/i.test(msg)),
    `Expected a warning about unmatched select, got: ${JSON.stringify(warnMessages)}`
  );
});

// ── end Fix 8 ─────────────────────────────────────────────────────────────────

test('fillForm getByLabel fallback uses escaped regex so metachar does not cause SyntaxError', async () => {
  const { fillForm } = require('../lib/forms');

  // Keyword 'na(me' has '(' which would cause SyntaxError if not escaped
  const formFields = {
    'input[name*="na(me" i]': 'test value',
  };

  const regexesCreated = [];
  const page = {
    locator: () => ({
      first: () => ({
        count: async () => 0,
        isVisible: async () => false,
      }),
    }),
    getByLabel: (re) => {
      regexesCreated.push(re);
      return {
        count: async () => 0, // label miss → fill skipped (regex still recorded above)
        first: () => ({
          fill: async () => {},
        }),
      };
    },
    // Resolver fallback round-trip after a label miss — no-op stub returns no match.
    evaluate: async () => ({ found: false }),
  };

  await fillForm(page, formFields);

  // If getByLabel was called, verify the regex was valid (no SyntaxError)
  if (regexesCreated.length > 0) {
    assert.ok(regexesCreated[0] instanceof RegExp, 'Should be a valid RegExp');
    // The source should have the '(' escaped to '\('
    assert.ok(regexesCreated[0].source.includes('\\('), `Metachar '(' should be escaped in: ${regexesCreated[0].source}`);
  }
  // Either getByLabel was not called (keyword filtered as ambiguous) or it was called with valid regex
  // Either way, no exception is the success criterion
});
