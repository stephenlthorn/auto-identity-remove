/**
 * test/generic-runner-phone.test.js
 *
 * The generic runner never typed the phone number into the ~490 registry
 * brokers' deletion forms, so a broker could remove the name and keep the
 * number. It now fills a phone field when the form has one.
 *
 * The phone field is supplementary: filling it alone must not count as "a form
 * was filled". Plenty of these sites put a reverse-phone SEARCH box on the page,
 * and treating that as an opt-out form would submit a lookup of the user's own
 * number and record it as a removal.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processGenericUrl, _setConfig } = require('../generic-runner');
const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

const PHONE_SELECTORS = new Set(['input[type="tel"]', 'input[name*="phone" i]', 'input[placeholder*="phone" i]']);

// One opt-out form on the page, with or without an email box and a phone box.
function makeStubPage({ hasEmail, hasPhone }) {
  const fields = [hasEmail && 'email', hasPhone && 'phone'].filter(Boolean);
  const page = makeFakePage({
    forms: [optOutForm({ fields, afterSubmit: { body: 'Your request has been received.' } })],
  });
  // Older assertions read {sel, v}; keep that shape over the shared fake.
  return Object.defineProperties(page, {
    filledPairs: { get: () => page.filled.map(f => ({ sel: f.sel, v: f.value })) },
    clickedSels: { get: () => page.clicked.map(c => c.sel) },
  });
}

const BROKER = { name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'markup' };

test.before(() => {
  _setConfig({
    person: {
      firstName: 'Test', lastName: 'User', fullName: 'Test User',
      email: 'test@example.com', state: 'TX', zip: '73301',
      phone: '5125550000', phoneFormatted: '(512) 555-0000',
    },
  });
});

test('a deletion form with a phone field gets the phone number', async () => {
  const page = makeStubPage({ hasEmail: true, hasPhone: true });
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set());

  assert.equal(result.status, 'success');
  assert.ok(page.filledPairs.some(f => PHONE_SELECTORS.has(f.sel) && f.v === '(512) 555-0000'),
    `phone should be filled, got ${JSON.stringify(page.filledPairs)}`);
});

test('a page with only a phone box is not submitted as an opt-out', async () => {
  const page = makeStubPage({ hasEmail: false, hasPhone: true });
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set());

  assert.notEqual(result.status, 'success', 'a lone phone box is a search, not a removal form');
  assert.ok(!page.clickedSels.some(s => s.includes('button[type="submit"]')), 'nothing may be submitted');
  assert.deepEqual(page.filledPairs, [], 'the number is not even typed into a lone search box');
});
