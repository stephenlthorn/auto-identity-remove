/**
 * test/forms-field-safety.test.js
 *
 * BRK-8 and the primary-path half of BRK-15: the person's data landing in a
 * field it does not belong in.
 *
 *   - Six brokers mapped the full name to input[name*="name" i], which also
 *     matches firstname, lastname, company_name and username. fillForm took the
 *     first DOM match, so a "Jane Doe" could land in company_name.
 *   - Experian mapped the city to input[name*="addr" i]; with no such input the
 *     label fallback getByLabel(/addr/i) typed "Austin" into "Email address".
 *   - A bot trap parked at left:-9999px counts as "visible" to Playwright, so the
 *     primary selector path filled the trap instead of the real field.
 *
 * The page below is a small fake DOM: a CSS attribute-selector matcher that
 * understands the selectors brokers.js uses (including :not()), plus enough of
 * the Element API for fillForm and the semantic resolver to run unmodified.
 * Every assertion is on what ended up in which field.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fillForm, isAmbiguousKeyword } = require('../lib/forms');
const { RESOLVE_MARKER } = require('../lib/field-resolver');

const PERSON = {
  firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe',
  email: 'jane@example.com', city: 'Austin', state: 'TX', zip: '73301', country: 'US',
};

// ── fake DOM ──────────────────────────────────────────────────────────────────

const ON_SCREEN = { left: 20, top: 10, right: 220, bottom: 40, width: 200, height: 30 };

function makeNode(spec) {
  const tag = spec.tag || 'input';
  return {
    spec,
    tagName: tag.toUpperCase(),
    type: spec.type || (tag === 'select' ? 'select-one' : 'text'),
    name: spec.name || '',
    id: spec.id || '',
    placeholder: spec.placeholder || '',
    hidden: false,
    parentElement: null,
    ownerDocument: null,
    labels: spec.label ? [{ textContent: spec.label }] : [],
    value: '',
    _attrs: { ...(spec.attrs || {}) },
    getBoundingClientRect() { return spec.rect || ON_SCREEN; },
    getAttribute(k) {
      if (Object.prototype.hasOwnProperty.call(this._attrs, k)) return this._attrs[k];
      return k === 'autocomplete' ? '' : null;
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
  };
}

function attrOf(node, attr) {
  if (attr === 'name') return node.name;
  if (attr === 'id') return node.id;
  if (attr === 'type') return node.type;
  if (attr === 'placeholder') return node.placeholder;
  return node.getAttribute(attr);
}

const TOKEN = /(:not\()?\[([\w-]+)(?:([*^$|~]?)="([^"]*)")?(?:\s+(i))?\]\)?|#([\w-]+)/g;

/** Matches `tag[attr op "v" i]` / `#id` / `:not([attr op "v" i])` compounds. */
function matches(node, selector) {
  const head = selector.trim().match(/^([a-z]*)(.*)$/i);
  const tag = head[1].toLowerCase();
  if (tag && node.tagName.toLowerCase() !== tag) return false;
  const tokens = [...head[2].matchAll(TOKEN)];
  if (tokens.reduce((n, t) => n + t[0].length, 0) !== head[2].length) {
    throw new Error(`fake DOM cannot parse selector: ${selector}`);
  }
  for (const t of tokens) {
    if (t[6]) { if (node.id !== t[6]) return false; continue; }
    const [, negated, attr, op, want, ci] = t;
    const raw = attrOf(node, attr);
    let ok;
    if (want === undefined) {
      ok = raw !== null && raw !== undefined;
    } else {
      const have = String(raw == null ? '' : raw);
      const h = ci ? have.toLowerCase() : have;
      const w = ci ? want.toLowerCase() : want;
      ok = op === '*' ? h.includes(w) : op === '^' ? h.startsWith(w) : op === '$' ? h.endsWith(w) : h === w;
    }
    if (negated ? ok : !ok) return false;
  }
  return true;
}

function makePage(specs) {
  const nodes = specs.map(makeNode);

  const handleFor = (list) => {
    const first = list[0];
    const handle = {
      first: () => handle,
      async count() { return first ? 1 : 0; },
      async isVisible() { return Boolean(first) && first.spec.visible !== false; },
      async evaluate(fn) { return fn(first); },
      async fill(v) { first.value = v; },
      async selectOption() {},
      async check() {},
    };
    return handle;
  };

  return {
    nodes,
    valueOf: (name) => nodes.find(n => n.name === name || n.id === name).value,
    filled: () => Object.fromEntries(nodes.filter(n => n.value !== '').map(n => [n.name || n.id, n.value])),
    locator(sel) {
      if (sel === '[' + RESOLVE_MARKER + '="1"]') {
        return handleFor(nodes.filter(n => n.getAttribute(RESOLVE_MARKER) === '1'));
      }
      return handleFor(nodes.filter(n => matches(n, sel)));
    },
    getByLabel(re) {
      return handleFor(nodes.filter(n => n.labels.some(l => re.test(l.textContent))));
    },
    // The resolver's scoring callback runs for real against the fake document.
    async evaluate(fn, arg) {
      const saved = global.document;
      global.document = {
        querySelector: () => null,
        querySelectorAll: (sel) => (
          sel.startsWith('[' + RESOLVE_MARKER)
            ? nodes.filter(n => n.hasAttribute(RESOLVE_MARKER))
            : nodes
        ),
        body: {},
      };
      try { return await fn(arg); } finally {
        if (saved === undefined) delete global.document; else global.document = saved;
      }
    },
  };
}

async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

function brokersFor(person) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-fields-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ person }));
  const modPath = path.join(dir, 'brokers.js');
  try {
    return require(modPath).forPerson(person);
  } finally {
    for (const p of Object.keys(require.cache)) if (p.startsWith(dir)) delete require.cache[p];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const brokerNamed = (list, name) => list.find(b => b.name === name);

// ── BRK-8: the full name never lands in firstname / lastname / company / user ──

const FULL_NAME_BROKERS = [
  'FastPeopleSearch', 'TruePeopleSearch', 'ThatsThem',
  'SearchPeopleFree', 'PeopleSearchNow', 'SocialCatfish',
];

// DOM order is deliberate: every wrong match comes BEFORE the real field, which
// is the order that made `.first()` pick the wrong one.
const NAME_TRAPS = () => [
  { name: 'firstname', id: 'f' },
  { name: 'lastname', id: 'l' },
  { name: 'company_name', id: 'c' },
  { name: 'username', id: 'u' },
  { name: 'nickname', id: 'n' },
];

for (const brokerName of FULL_NAME_BROKERS) {
  test(`${brokerName}: the full name goes in the name field, not firstname/lastname/company_name/username`, async () => {
    const broker = brokerNamed(brokersFor(PERSON), brokerName);
    const page = makePage([
      ...NAME_TRAPS(),
      { name: 'name', id: 'optout_name', placeholder: 'Your name' },
      { name: 'email', type: 'email' },
    ]);

    await quietly(() => fillForm(page, broker.formFields, PERSON));

    assert.equal(page.valueOf('name'), 'Jane Doe');
    for (const trap of ['firstname', 'lastname', 'company_name', 'username', 'nickname']) {
      assert.equal(page.valueOf(trap), '', `${trap} must stay empty`);
    }
  });

  test(`${brokerName}: with no name field at all, nothing is typed into firstname/lastname/company_name/username`, async () => {
    const broker = brokerNamed(brokersFor(PERSON), brokerName);
    const page = makePage([...NAME_TRAPS(), { name: 'email', type: 'email' }]);

    await quietly(() => fillForm(page, broker.formFields, PERSON));

    const filled = page.filled();
    for (const trap of ['firstname', 'lastname', 'company_name', 'username', 'nickname']) {
      assert.equal(filled[trap], undefined, `${trap} must stay empty (got ${JSON.stringify(filled)})`);
    }
  });
}

test('a placeholder-keyed name selector (TruePeopleSearch) skips "Last name" and "Company name" boxes', async () => {
  const broker = brokerNamed(brokersFor(PERSON), 'TruePeopleSearch');
  const page = makePage([
    { name: 'a1', placeholder: 'Last name' },
    { name: 'a2', placeholder: 'Company name' },
    { name: 'a3', placeholder: 'Full name' },
  ]);

  await quietly(() => fillForm(page, broker.formFields, PERSON));

  assert.equal(page.valueOf('a1'), '');
  assert.equal(page.valueOf('a2'), '');
  assert.equal(page.valueOf('a3'), 'Jane Doe');
});

// ── BRK-8: Experian's city ────────────────────────────────────────────────────

test('Experian: the city is never typed into an "Email address" field', async () => {
  const broker = brokerNamed(brokersFor(PERSON), 'Experian (marketing)');
  const page = makePage([
    { name: 'first_name' },
    { name: 'last_name' },
    { name: 'contact', label: 'Email address', placeholder: 'you@example.com' },
    { name: 'zip' },
  ]);

  await quietly(() => fillForm(page, broker.formFields, PERSON));

  assert.equal(page.valueOf('contact'), '', 'the city must not land in the email box');
  assert.ok(!Object.values(page.filled()).includes('Austin'), 'no field on this page takes a city');
});

test('Experian: the city does go into a field that is actually a city field', async () => {
  const broker = brokerNamed(brokersFor(PERSON), 'Experian (marketing)');
  const page = makePage([
    { name: 'first_name' },
    { name: 'last_name' },
    { name: 'email_address', type: 'email' },
    { name: 'city' },
    { name: 'zip' },
  ]);

  await quietly(() => fillForm(page, broker.formFields, PERSON));

  assert.equal(page.valueOf('city'), 'Austin');
  assert.equal(page.valueOf('email_address'), '');
});

// ── BRK-8: email-like fields are never filled by a non-email selector ─────────

test('an address-style selector does not fill an email_addr field', async () => {
  const page = makePage([{ name: 'email_addr', type: 'text' }]);
  await quietly(() => fillForm(page, { 'input[name*="addr" i]': 'Austin' }));
  assert.equal(page.valueOf('email_addr'), '');
});

test('a non-email selector that reaches an email field through its label is refused', async () => {
  const page = makePage([{ name: 'contact_email', type: 'email', label: 'Contact' }]);
  await quietly(() => fillForm(page, { 'input[name*="contact" i]': 'Austin' }));
  assert.equal(page.valueOf('contact_email'), '');
});

test('a non-email selector may still fill a field when the VALUE is an email', async () => {
  const page = makePage([{ name: 'contact_email', type: 'email' }]);
  await quietly(() => fillForm(page, { 'input[name*="contact" i]': 'jane@example.com' }));
  assert.equal(page.valueOf('contact_email'), 'jane@example.com');
});

test('an email selector still fills an email field', async () => {
  const page = makePage([{ name: 'email', type: 'email' }]);
  await quietly(() => fillForm(page, { 'input[name="email"]': 'jane@example.com' }));
  assert.equal(page.valueOf('email'), 'jane@example.com');
});

test('"addr" is too generic for the label fallback (it matches "Email address")', () => {
  assert.equal(isAmbiguousKeyword('addr'), true);
});

// ── BRK-15 (primary path): bot traps are not filled ──────────────────────────

const OFF_SCREEN = { left: -9999, top: 10, right: -9799, bottom: 40, width: 200, height: 30 };

test('an off-screen honeypot that matches the selector is not filled, the real field is', async () => {
  const page = makePage([
    { name: 'email', id: 'trap', type: 'email', rect: OFF_SCREEN, attrs: { autocomplete: 'email' } },
    { name: 'email', id: 'real', type: 'email', attrs: { autocomplete: 'email' } },
  ]);

  await quietly(() => fillForm(page, { 'input[name="email"]': 'jane@example.com' }));

  assert.equal(page.valueOf('trap'), '', 'the bot trap must stay empty');
  assert.equal(page.valueOf('real'), 'jane@example.com');
});

test('an aria-hidden / tabindex=-1 text field matching the selector is not filled', async () => {
  const page = makePage([
    { name: 'address2', id: 'trap', attrs: { 'aria-hidden': 'true', tabindex: '-1' } },
  ]);
  await quietly(() => fillForm(page, { 'input[name="address2"]': 'Apt 4' }));
  assert.equal(page.valueOf('trap'), '');
});

test('a visible field on a normal page is still filled by the primary selector path', async () => {
  const page = makePage([{ name: 'zip' }]);
  await quietly(() => fillForm(page, { 'input[name="zip"]': '73301' }));
  assert.equal(page.valueOf('zip'), '73301');
});
