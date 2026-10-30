/**
 * test/generic-privacy-manager.test.js
 *
 * BRK-2: Strategy 2 ("privacy manager") used to treat ANY button reading "Save" or
 * "Confirm" as a OneTrust / TrustArc preference centre: it checked only count() > 0
 * (no visibility), swallowed the click error, and returned true, which became
 * "Privacy manager opted out" and a 90-day cooldown. A "Save job" button on a
 * careers page was enough, and it pre-empted the real form strategy.
 *
 * BRK-12 (generic part): hidden .ot-tgl toggles were clicked unconditionally, 30 s
 * each.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001',
};
const BROKER = { name: 'PM Broker', url: 'https://broker.example/privacy', source: 'markup' };

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-pm-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (page, opts = {}) =>
  gr.processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });

test('BRK-2: a lone "Save job" button is not a privacy manager and is not an opt-out', async () => {
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel.includes('button:has-text("Save")'),
  });
  const result = await run(page);
  assert.notEqual(result.status, 'success', 'a "Save job" button must never be reported as an opt-out');
  assert.equal(page.clicked.length, 0, 'and it must not be clicked at all');
});

test('BRK-2: a lone "Confirm" button is not a privacy manager either', async () => {
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel.includes('button:has-text("Confirm")'),
  });
  const result = await run(page);
  assert.notEqual(result.status, 'success');
  assert.equal(page.clicked.length, 0);
});

test('BRK-2: with no privacy manager the run falls through to the form strategy', async () => {
  const page = makeFakePage({
    pageSelectors: (sel) => sel.includes('button:has-text("Save")'),
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page);
  assert.equal(result.status, 'success', 'the form strategy must still run when Strategy 2 does not apply');
  assert.ok(page.filled.length > 0);
});

test('BRK-2: a real OneTrust container is handled and its Confirm My Choices button is clicked', async () => {
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '.save-preference-btn-handler',
  });
  await run(page);
  assert.ok(
    page.clicked.some(c => c.sel === '.save-preference-btn-handler'),
    'the container is present and visible, so its save button is clicked',
  );
});

test('BRK-2: the OneTrust "Allow All" button is never what gets clicked', async () => {
  // #accept-recommended-btn-handler is the preference centre's "Allow All". The
  // old selector list clicked it after switching the toggles off, undoing them.
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '#accept-recommended-btn-handler' || sel === '.save-preference-btn-handler',
  });
  await run(page);
  assert.ok(!page.clicked.some(c => c.sel.includes('accept-recommended-btn-handler')), 'must not click Allow All');
});

test('BRK-2: when the privacy manager click fails, the run falls through instead of claiming success', async () => {
  const page = makeFakePage({
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '.save-preference-btn-handler',
    onPageClick: () => { throw new Error('click intercepted'); },
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page);
  assert.ok(page.filled.length > 0, 'Strategy 3 must still get its turn after a failed privacy manager click');
  assert.equal(result.status, 'success');
});

test('BRK-2: a container that exists but is not visible does not count', async () => {
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '.save-preference-btn-handler',
    hidden: (sel) => sel === '#onetrust-pc-sdk',
  });
  const result = await run(page);
  assert.notEqual(result.status, 'success');
  assert.equal(page.clicked.length, 0, 'nothing inside a hidden container may be clicked');
});

test('BRK-12: hidden OneTrust toggles are not clicked, visible ones are', async () => {
  const clicks = [];
  const toggle = (name, visible) => ({
    isVisible: async () => visible,
    click: async () => { clicks.push(name); },
  });
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => sel === '#onetrust-pc-sdk' || sel === '.save-preference-btn-handler' || sel.includes('.ot-tgl'),
    toggles: () => [toggle('hidden-one', false), toggle('visible-one', true), toggle('hidden-two', false)],
  });
  await run(page);
  assert.deepEqual(clicks, ['visible-one'], 'only visible toggles are worth a click');
});

test('BRK-12: always-on (disabled) toggles are not even queried', async () => {
  const queried = [];
  const page = makeFakePage({
    pageScope: false,
    pageSelectors: (sel) => { queried.push(sel); return sel === '#onetrust-pc-sdk'; },
  });
  await run(page);
  const toggleQuery = queried.find(s => s.includes('.ot-tgl'));
  assert.ok(toggleQuery, 'precondition: toggles were looked up');
  assert.match(toggleQuery, /:not\(\[disabled\]\)/, 'strictly-necessary toggles are disabled and cannot be clicked');
});
