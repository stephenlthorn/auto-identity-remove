/**
 * test/generic-opts-contract.test.js
 *
 * The cross-package options contract for runGenericBrokers / processGenericUrl:
 *
 *   opts.include         (CORE-4)  (brokerName) => boolean. Excluded brokers are
 *                                  skipped before anything else: no navigation,
 *                                  no log line, no state write.
 *   opts.submissionEmail (CORE-1 / BRK-3) every email field the generic runner
 *                                  fills gets this value, never person.email.
 *   page default timeout (BRK-12)  hidden toggles / missing controls must not
 *                                  cost the Playwright 30 s default each.
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
  firstName: 'Real', lastName: 'Person', fullName: 'Real Person',
  email: 'real.person@home.example', state: 'CA', zip: '90001',
};
const ALIAS = 'alias-123@relay.example';

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-opts-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── CORE-4: opts.include ─────────────────────────────────────────────────────

test('CORE-4: runGenericBrokers skips brokers the include predicate rejects, before anything else', async () => {
  const seen = [];
  const logged = [];
  const brokers = [
    { name: 'Spokeo', url: 'https://spokeo.example/optout', source: 'test' },
    { name: 'Other One', url: 'https://one.example/optout', source: 'test' },
    { name: 'Other Two', url: 'https://two.example/optout', source: 'test' },
  ];
  const page = makeFakePage();
  const result = await gr.runGenericBrokers(
    makeContext(page), new Set(), { optOuts: {} },
    (name, status) => logged.push({ name, status }),
    () => {},
    {
      injectedBrokers: brokers,
      injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: broker.url }; },
      include: (name) => name === 'Spokeo',
    },
  );
  assert.deepEqual(seen, ['Spokeo'], 'only the included broker may be processed');
  assert.deepEqual(logged.map(l => l.name), ['Spokeo'], 'excluded brokers must not even be logged');
  assert.equal(result.genericStats.attempted, 1);
  assert.equal(result.count, 1, 'the reported count is the number of brokers that will run');
});

test('CORE-4: an excluded broker is never navigated to (real processGenericUrl)', async () => {
  const page = makeFakePage({ forms: [optOutForm()] });
  await gr.runGenericBrokers(
    makeContext(page), new Set(), { optOuts: {} },
    () => {}, () => {},
    {
      injectedBrokers: [{ name: 'Excluded Co', url: 'https://excluded.example/optout', source: 'test' }],
      injectedDeadSet: new Set(),
      include: () => false,
    },
  );
  assert.deepEqual(page.gotos, [], 'no navigation for an excluded broker');
  assert.deepEqual(page.filled, [], 'and no PII typed anywhere');
});

test('CORE-4: with no include predicate every broker runs (backward compatible)', async () => {
  const seen = [];
  await gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} },
    () => {}, () => {},
    {
      injectedBrokers: [
        { name: 'A', url: 'https://a.example/x', source: 'test' },
        { name: 'B', url: 'https://b.example/x', source: 'test' },
      ],
      injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
    },
  );
  assert.deepEqual(seen, ['A', 'B']);
});

// ── CORE-1 / BRK-3: opts.submissionEmail ─────────────────────────────────────

test('BRK-3: processGenericUrl fills the relay alias, never person.email', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ fields: ['email', 'firstName', 'lastName'], afterSubmit: { body: 'Your request has been received.' } })],
  });
  await gr.processGenericUrl(
    page,
    { name: 'RelayBroker', url: 'https://broker.example/opt-out', source: 'test' },
    { optOuts: {} }, false, new Set(),
    { person: PERSON, submissionEmail: ALIAS },
  );
  const emailFills = page.filled.filter(f => f.sel.includes('email'));
  assert.ok(emailFills.length > 0, 'precondition: an email field was filled');
  assert.ok(emailFills.every(f => f.value === ALIAS), 'every email field gets the alias');
  assert.ok(
    page.filled.every(f => f.value !== PERSON.email),
    'person.email must never be typed into any field when a relay alias is set',
  );
});

test('BRK-3: without submissionEmail the person email is used as before', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  await gr.processGenericUrl(
    page,
    { name: 'PlainBroker', url: 'https://broker.example/opt-out', source: 'test' },
    { optOuts: {} }, false, new Set(),
    { person: PERSON },
  );
  assert.ok(page.filled.some(f => f.value === PERSON.email));
});

test('CORE-1: runGenericBrokers hands opts.submissionEmail to every broker it processes', async () => {
  const handed = [];
  await gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} },
    () => {}, () => {},
    {
      injectedBrokers: [{ name: 'A', url: 'https://a.example/x', source: 'test' }],
      injectedProcessFn: async (_p, _b, _s, _d, _dead, o) => { handed.push(o.submissionEmail); return { status: 'manual', detail: '' }; },
      submissionEmail: ALIAS,
    },
  );
  assert.deepEqual(handed, [ALIAS]);
});

test('BRK-3: getFieldMap uses the alias for the email entry', () => {
  const map = gr.getFieldMap(PERSON, { submissionEmail: ALIAS });
  const emailEntry = map.find(f => f.selectors.includes('input[type="email"]'));
  assert.equal(emailEntry.value, ALIAS);
  const plain = gr.getFieldMap(PERSON, {});
  assert.equal(plain.find(f => f.selectors.includes('input[type="email"]')).value, PERSON.email);
});

// ── BRK-12: page default timeout ─────────────────────────────────────────────

test('BRK-12: the working page gets a short default action timeout', async () => {
  const page = makeFakePage();
  await gr.runGenericBrokers(
    makeContext(page), new Set(), { optOuts: {} },
    () => {}, () => {},
    {
      injectedBrokers: [{ name: 'A', url: 'https://a.example/x', source: 'test' }],
      injectedProcessFn: async () => ({ status: 'manual', detail: '' }),
    },
  );
  assert.ok(page.timeouts.length >= 1, 'setDefaultTimeout must be called on the working page');
  assert.ok(page.timeouts.every(ms => ms <= 5000), `default timeout must be at most 5 s, got ${page.timeouts}`);
});

test('BRK-12: a replacement page (recycle after 25 brokers) also gets the short default timeout', async () => {
  const pages = [];
  const context = {
    newPage: async () => { const p = makeFakePage(); pages.push(p); return p; },
    pages: () => pages,
  };
  const brokers = Array.from({ length: 26 }, (_, i) => ({ name: `B${i}`, url: `https://b${i}.example/x`, source: 'test' }));
  await gr.runGenericBrokers(
    context, new Set(), { optOuts: {} }, () => {}, () => {},
    { injectedBrokers: brokers, injectedProcessFn: async () => ({ status: 'manual', detail: '' }) },
  );
  assert.ok(pages.length >= 2, 'precondition: the page was recycled');
  for (const p of pages) assert.ok(p.timeouts.length >= 1, 'every page the runner works on gets the default timeout');
});
