/**
 * test/forms-alias-by-value.test.js
 *
 * BRK2-8: the relay alias was swapped in by sniffing the SELECTOR for the word
 * "email". '#emailAddress', 'input[name="user_email"]', 'input[name*="mail"]',
 * '#txtEmail', '[name="e-mail"]' all slipped through, so the person's real address
 * was typed into a broker's form while the relay was on. The swap now follows the
 * VALUE: whatever would have received the person's own address gets the alias.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm } = require('../lib/forms');

function makeStubPage(fills) {
  return {
    locator(selector) {
      return {
        first() {
          return {
            async count() { return 1; },
            async isVisible() { return true; },
            async evaluate(fn) { return fn({ tagName: 'INPUT', type: 'text' }); },
            async fill(value) { fills.push({ selector, value }); },
            async selectOption() {},
            async check() {},
          };
        },
      };
    },
    getByLabel() { return { count: async () => 0, first() { return { async fill() {} }; } }; },
  };
}

const PERSON = { firstName: 'Jane', lastName: 'Doe', email: 'Jane.Doe@Example.com', country: 'US' };
const ALIAS = 'hide.abc@aliases.example';

for (const selector of ['#emailAddress', 'input[name="user_email"]', 'input[name*="mail" i]', '#txtEmail', 'input[name="e-mail"]', 'input.contact-addr', '[data-field="notify"]']) {
  test(`BRK2-8: ${selector} receives the alias, not the real address`, async () => {
    const fills = [];
    await fillForm(makeStubPage(fills), { [selector]: 'jane.doe@example.com' }, PERSON, ALIAS);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].value, ALIAS);
  });
}

test('BRK2-8: the comparison ignores case and surrounding blanks', async () => {
  const fills = [];
  await fillForm(makeStubPage(fills), { '#a': ' JANE.DOE@EXAMPLE.COM ' }, PERSON, ALIAS);
  assert.equal(fills[0].value, ALIAS);
});

test('BRK2-8: a value that is not the person\'s address is left alone, whatever the selector says', async () => {
  const fills = [];
  await fillForm(makeStubPage(fills), { 'input[name="email_confirm_note"]': 'please confirm', '#city': 'Austin' }, PERSON, ALIAS);
  assert.deepEqual(fills.map((f) => f.value), ['please confirm', 'Austin'].map((v) => v));
});

test('BRK2-8: without a person the old selector rule still swaps an email field', async () => {
  const fills = [];
  await fillForm(makeStubPage(fills), { 'input[name="email"]': 'x@y.example' }, undefined, ALIAS);
  assert.equal(fills[0].value, ALIAS);
});

test('BRK2-8: no alias, no change: the real address is filled as configured', async () => {
  const fills = [];
  await fillForm(makeStubPage(fills), { '#emailAddress': 'jane.doe@example.com' }, PERSON, undefined);
  assert.equal(fills[0].value, 'jane.doe@example.com');
});
