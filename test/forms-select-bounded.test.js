/**
 * test/forms-select-bounded.test.js
 *
 * BRK-12 (forms part): fillForm could stall a broker for minutes.
 *
 *   - selectOption({label}) then selectOption(value) each wait Playwright's
 *     default 30 s when the option is missing: 60 s per miss.
 *   - applyRegionAliases adds select[name*="country" i] = "CA" for every non-US
 *     person, and the code went to a LABEL match ("Canada" is the label, "CA" is
 *     the value), so a country select cost a 30 s miss on every broker form.
 *   - fill()/check() had no timeout either.
 *
 * The select stub below holds a real option list, reads it through the same
 * evaluate() call fillForm makes, and records every selectOption() call with its
 * options argument, so the tests can assert both WHAT is chosen and that every
 * wait is bounded.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm, matchSelectOption } = require('../lib/forms');

const CA = { country: 'CA', state: 'ON', zip: 'K1A 0A6' };

function selectPage(options, { name = 'country', readable = true } = {}) {
  const calls = [];
  const node = {
    tagName: 'SELECT',
    type: 'select-one',
    name,
    id: '',
    options: options.map(o => ({ value: o.value, label: o.label, textContent: o.label })),
  };
  const handle = {
    first: () => handle,
    count: async () => 1,
    isVisible: async () => true,
    // readable=false mimics the older stubs: every evaluate() answers 'select'.
    evaluate: async (fn) => (readable ? fn(node) : 'select'),
    selectOption: async (arg, opts) => { calls.push({ arg, opts }); },
  };
  const miss = { first: () => ({ count: async () => 0, isVisible: async () => false }) };
  return {
    calls,
    locator: (sel) => (sel.includes('country') ? handle : miss),
    getByLabel: () => ({ count: async () => 0, first: () => ({}) }),
    evaluate: async () => ({ found: false }),
  };
}

const withWarnings = async (fn) => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try { await fn(); } finally { console.warn = orig; }
  return warnings;
};

const COUNTRIES_BY_CODE = [
  { value: '', label: 'Select a country' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'GB', label: 'United Kingdom' },
];

// ── the country code is matched against option VALUES, not labels ─────────────

test('a country code picks the option whose VALUE is that code, with no label attempt', async () => {
  const page = selectPage(COUNTRIES_BY_CODE);
  await fillForm(page, { 'input[name*="first" i]': 'Jane' }, CA);

  assert.equal(page.calls.length, 1, 'one selectOption call, not a label miss followed by a value hit');
  assert.deepEqual(page.calls[0].arg, { index: 2 });
  assert.notDeepEqual(page.calls[0].arg, { label: 'CA' }, 'the bare code must never be sent to a label match');
});

test('a country select with numeric values is matched through the country NAME', async () => {
  const page = selectPage([
    { value: '840', label: 'United States of America' },
    { value: '124', label: 'Canada' },
  ]);
  await fillForm(page, { 'input[name*="first" i]': 'Jane' }, CA);

  assert.deepEqual(page.calls.map(c => c.arg), [{ index: 1 }]);
});

test('GB finds "United Kingdom" and the "UK" alias', async () => {
  const GB = { country: 'GB', state: '', zip: 'SW1A 1AA' };
  const byName = selectPage([{ value: '1', label: 'France' }, { value: '2', label: 'United Kingdom' }]);
  await fillForm(byName, { 'input[name*="first" i]': 'Jane' }, GB);
  assert.deepEqual(byName.calls.map(c => c.arg), [{ index: 1 }]);

  const byAlias = selectPage([{ value: '1', label: 'France' }, { value: '2', label: 'UK' }]);
  await fillForm(byAlias, { 'input[name*="first" i]': 'Jane' }, GB);
  assert.deepEqual(byAlias.calls.map(c => c.arg), [{ index: 1 }]);
});

// ── a value the select does not offer costs nothing ──────────────────────────

test('a country the select does not list makes no selectOption call at all (no 30 s wait)', async () => {
  const page = selectPage(COUNTRIES_BY_CODE);
  const warnings = await withWarnings(() =>
    fillForm(page, { 'input[name*="first" i]': 'Jane' }, { country: 'NZ', state: '', zip: '6011' }));

  assert.equal(page.calls.length, 0, 'nothing to select, so nothing to wait for');
  assert.ok(warnings.some(w => /select unmatched/.test(w)), 'the miss is still reported');
  assert.ok(!warnings.some(w => w.includes('NZ')), 'the value is never logged');
});

test('a state abbreviation is matched against option values and labels locally', async () => {
  const page = selectPage([
    { value: '', label: 'State' },
    { value: 'TX', label: 'Texas' },
    { value: 'WA', label: 'Washington' },
  ], { name: 'state' });
  page.locator = (sel) => (sel.includes('state') ? { first: () => ({
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn) => fn({
      tagName: 'SELECT', type: 'select-one', name: 'state', id: '',
      options: [
        { value: '', label: 'State', textContent: 'State' },
        { value: 'TX', label: 'Texas', textContent: 'Texas' },
        { value: 'WA', label: 'Washington', textContent: 'Washington' },
      ],
    }),
    selectOption: async (arg, opts) => { page.calls.push({ arg, opts }); },
  }) } : { first: () => ({ count: async () => 0 }) });

  await fillForm(page, { 'select[name="state"]': 'TX' });
  assert.deepEqual(page.calls.map(c => c.arg), [{ index: 1 }]);

  page.calls.length = 0;
  await fillForm(page, { 'select[name="state"]': 'Washington' });
  assert.deepEqual(page.calls.map(c => c.arg), [{ index: 2 }], 'an exact label also matches');
});

// ── every remaining wait carries a short timeout ──────────────────────────────

test('when options cannot be read, each selectOption attempt carries a short timeout', async () => {
  const page = selectPage([], { readable: false });
  await withWarnings(() => fillForm(page, { 'select[name*="country" i]': 'DE' }));

  assert.ok(page.calls.length >= 1 && page.calls.length <= 3, `bounded attempts, got ${page.calls.length}`);
  for (const c of page.calls) {
    assert.ok(c.opts && c.opts.timeout > 0 && c.opts.timeout <= 3000, `selectOption must pass a short timeout, got ${JSON.stringify(c.opts)}`);
  }
});

test('with unreadable options a country code is still tried as a VALUE first', async () => {
  const page = selectPage([], { readable: false });
  await fillForm(page, { 'select[name*="country" i]': 'CA' });
  assert.equal(page.calls[0].arg, 'CA');
});

test('fill() carries a short timeout', async () => {
  const seen = [];
  const handle = {
    first: () => handle,
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'text' }),
    fill: async (v, opts) => { seen.push(opts); },
  };
  await fillForm({ locator: () => handle }, { 'input[name="zip"]': '73301' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] && seen[0].timeout > 0 && seen[0].timeout <= 10000, `got ${JSON.stringify(seen[0])}`);
});

test('check() carries a short timeout', async () => {
  const seen = [];
  const handle = {
    first: () => handle,
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'checkbox' }),
    check: async (opts) => { seen.push(opts); },
  };
  await fillForm({ locator: () => handle }, { '#agreement': 'yes' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] && seen[0].timeout > 0 && seen[0].timeout <= 10000, `got ${JSON.stringify(seen[0])}`);
});

test('a label-fallback fill carries a short timeout', async () => {
  const seen = [];
  const page = {
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    getByLabel: () => ({
      count: async () => 1,
      first: () => ({ fill: async (v, opts) => { seen.push(opts); } }),
    }),
  };
  await fillForm(page, { 'input[name*="zip" i]': '73301' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] && seen[0].timeout > 0 && seen[0].timeout <= 10000, `got ${JSON.stringify(seen[0])}`);
});

// ── matchSelectOption (pure) ─────────────────────────────────────────────────

test('matchSelectOption: option value beats option label', () => {
  const options = [{ value: 'x', label: 'CA' }, { value: 'CA', label: 'Canada' }];
  assert.equal(matchSelectOption(options, 'CA'), 1);
});

test('matchSelectOption: match is case-insensitive and trims', () => {
  assert.equal(matchSelectOption([{ value: 'tx', label: 'Texas' }], ' TX '), 0);
  assert.equal(matchSelectOption([{ value: '48', label: 'Texas' }], 'texas'), 0);
});

test('matchSelectOption: a country code only expands to a name for a country select', () => {
  const options = [{ value: '1', label: 'Canada' }];
  assert.equal(matchSelectOption(options, 'CA', { countryHint: true }), 0);
  assert.equal(matchSelectOption(options, 'CA'), -1, 'CA on a state select is California, not Canada');
});

test('matchSelectOption: an ambiguous country-name prefix does not guess', () => {
  const options = [
    { value: '1', label: 'United States Minor Outlying Islands' },
    { value: '2', label: 'United States of America' },
  ];
  assert.equal(matchSelectOption(options, 'US', { countryHint: true }), 1, 'the USA alias is an exact label here');
  const two = [
    { value: '1', label: 'United States Minor Outlying Islands' },
    { value: '2', label: 'United States Virgin Islands' },
  ];
  assert.equal(matchSelectOption(two, 'US', { countryHint: true }), -1, 'two prefix matches and no exact one: abstain');
});

test('matchSelectOption: empty wanted value or no options never matches', () => {
  assert.equal(matchSelectOption([{ value: '', label: '' }], ''), -1);
  assert.equal(matchSelectOption([], 'TX'), -1);
  assert.equal(matchSelectOption(null, 'TX'), -1);
});
