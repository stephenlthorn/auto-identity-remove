'use strict';

/**
 * test/forms-typed-report.test.js - Q4: fillForm says what it typed.
 *
 * The field report must list exactly the fields the runner typed into, so
 * fillForm returns one record per field it really filled: the selector, the
 * value, and whether the value was swapped for the relay alias. A field that was
 * skipped (nothing to say, not on the page, option not found) is not listed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fillForm } = require('../lib/forms');

const PERSON = { firstName: 'Jane', lastName: 'Sample', email: 'jane.sample@example.com', country: 'US' };

function makePage({ present, tags = {} }) {
  const fills = [];
  const page = {
    fills,
    locator(selector) {
      return {
        first() {
          return {
            async count() { return present.includes(selector) ? 1 : 0; },
            async isVisible() { return present.includes(selector); },
            async evaluate(fn) { return fn({ tagName: (tags[selector] || 'INPUT'), type: 'text' }); },
            async fill(value) { fills.push({ selector, value }); },
            async selectOption() { return []; },
            async check() {},
          };
        },
      };
    },
    getByLabel() { return { count: async () => 0, first() { return {}; } }; },
  };
  return page;
}

test('fillForm returns a record for every field it typed into', async () => {
  const page = makePage({ present: ['#first', '#email'] });
  const typed = await fillForm(page, { '#first': 'Jane', '#email': 'jane.sample@example.com' }, PERSON);
  assert.deepEqual(typed.map(t => t.selector), ['#first', '#email']);
  assert.deepEqual(typed.map(t => t.value), ['Jane', 'jane.sample@example.com']);
  assert.ok(typed.every(t => t.masked === false));
});

test('a field that is not on the page, or has nothing to say, is not listed', async () => {
  const page = makePage({ present: ['#first'] });
  const typed = await fillForm(page, { '#first': 'Jane', '#missing': 'Sample', '#blank': '' }, PERSON);
  assert.deepEqual(typed.map(t => t.selector), ['#first']);
  assert.deepEqual(page.fills.map(f => f.selector), ['#first']);
});

test('a relay alias is typed and marked masked', async () => {
  const page = makePage({ present: ['#email'] });
  const typed = await fillForm(page, { '#email': 'jane.sample@example.com' }, PERSON, 'alias@relay.example');
  assert.deepEqual(typed, [{ selector: '#email', value: 'alias@relay.example', masked: true }]);
});

test('an unmatched dropdown option is not reported as typed', async () => {
  const page = makePage({ present: ['select[name="state"]'], tags: { 'select[name="state"]': 'SELECT' } });
  // selectBounded cannot find the option in this stub, so nothing was selected
  page.locator = ((orig) => (sel) => {
    const l = orig(sel);
    const first = l.first;
    l.first = () => ({ ...first(), async selectOption() { throw new Error('no such option'); } });
    return l;
  })(page.locator);
  const typed = await fillForm(page, { 'select[name="state"]': 'IL' }, PERSON);
  assert.deepEqual(typed, []);
});
