'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanSettings, scanConfigProblems, SCAN_DEFAULTS } = require('../lib/scan-config');
const { validateRunnableConfig } = require('../lib/config');

test('scanSettings: defaults are submit and 30 days', () => {
  assert.deepEqual(scanSettings({}), { unknown: 'submit', maxAgeDays: 30 });
  assert.deepEqual(scanSettings(null), { unknown: 'submit', maxAgeDays: 30 });
  assert.deepEqual(SCAN_DEFAULTS, { unknown: 'submit', maxAgeDays: 30 });
});

test('scanSettings: reads valid values, ignoring case and spaces on the word', () => {
  assert.deepEqual(scanSettings({ scan: { unknown: ' Skip ', maxAgeDays: 7 } }), { unknown: 'skip', maxAgeDays: 7 });
});

test('scanSettings: an invalid value falls back to the default', () => {
  assert.deepEqual(scanSettings({ scan: { unknown: 'maybe', maxAgeDays: 0 } }), { unknown: 'submit', maxAgeDays: 30 });
});

test('scanConfigProblems: a valid or absent section has none', () => {
  assert.deepEqual(scanConfigProblems({}), []);
  assert.deepEqual(scanConfigProblems({ scan: {} }), []);
  assert.deepEqual(scanConfigProblems({ scan: { unknown: 'skip', maxAgeDays: 1 } }), []);
});

test('scanConfigProblems: names each bad value', () => {
  assert.match(scanConfigProblems({ scan: { unknown: 'maybe' } })[0], /scan\.unknown must be "submit" or "skip"/);
  for (const bad of [0, -3, 2.5, '30', NaN, null]) {
    const problems = scanConfigProblems({ scan: { maxAgeDays: bad } });
    assert.equal(problems.length, 1, `maxAgeDays ${String(bad)}`);
    assert.match(problems[0], /scan\.maxAgeDays must be a whole number of 1 or more/);
  }
  assert.match(scanConfigProblems({ scan: 'skip' })[0], /scan must be an object/);
  assert.match(scanConfigProblems({ scan: [] })[0], /scan must be an object/);
});

test('validateRunnableConfig reports a bad scan section', () => {
  const cfg = { person: { firstName: 'Jane', lastName: 'Sample', email: 'jane@example.org', phone: '5550100', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', dob: '1990-01-01' }, scan: { unknown: 'nope' } };
  const problems = validateRunnableConfig(cfg, { examplePath: '/nonexistent' });
  assert.ok(problems.some(p => /scan\.unknown/.test(p)), problems.join('\n'));
});
