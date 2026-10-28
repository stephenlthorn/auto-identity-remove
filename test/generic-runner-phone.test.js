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

const PHONE_SELECTORS = new Set(['input[type="tel"]', 'input[name*="phone" i]', 'input[placeholder*="phone" i]']);
const EMAIL_SELECTORS = new Set(['input[type="email"]', 'input[name*="email" i]', 'input[placeholder*="email" i]']);

function makeStubPage({ hasEmail, hasPhone }) {
  const filled = [];
  const clicked = [];
  const locator = (sel) => {
    const isSubmitSel = sel.includes('button[type="submit"]');
    const present = isSubmitSel
      || (hasEmail && EMAIL_SELECTORS.has(sel))
      || (hasPhone && PHONE_SELECTORS.has(sel));
    const self = {
      first: () => self,
      all: async () => [],
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'text' }),
      fill: async (v) => { filled.push({ sel, v }); },
      selectOption: async () => {},
      click: async () => { clicked.push(sel); },
      locator: () => self,
      allTextContents: async () => [],
    };
    return self;
  };
  return {
    filled,
    clicked,
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    content: async () => '<html><body>thanks</body></html>',
    locator,
    url: () => 'https://broker.example/opt-out',
  };
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
  assert.ok(page.filled.some(f => PHONE_SELECTORS.has(f.sel) && f.v === '(512) 555-0000'),
    `phone should be filled, got ${JSON.stringify(page.filled)}`);
});

test('a page with only a phone box is not submitted as an opt-out', async () => {
  const page = makeStubPage({ hasEmail: false, hasPhone: true });
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set());

  assert.notEqual(result.status, 'success', 'a lone phone box is a search, not a removal form');
  assert.ok(!page.clicked.some(s => s.includes('button[type="submit"]')), 'nothing may be submitted');
  assert.deepEqual(page.filled, [], 'the number is not even typed into a lone search box');
});
