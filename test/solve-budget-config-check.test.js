/**
 * test/solve-budget-config-check.test.js
 *
 * Q2: `aidr config check` reports a bad capsolver.maxSolvesPerRun as a warning
 * (the run still starts, but allows no paid solve), and a good or absent one is clean.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkConfig, formatConfigCheck } = require('../lib/config-check');
const h = require('./config-check-helpers');

function check(extra) {
  const root = h.makeRoot();
  try {
    h.writePlain(root, h.goodConfig(extra));
    const result = checkConfig({ env: {}, root });
    return { result, text: h.everything(result, formatConfigCheck) };
  } finally {
    h.cleanup(root);
  }
}

test('a usable or absent capsolver.maxSolvesPerRun is clean', () => {
  for (const capsolver of [undefined, { apiKey: 'CAP-REALKEY12345678' }, { apiKey: 'CAP-REALKEY12345678', maxSolvesPerRun: 5 }]) {
    const { result } = check(capsolver === undefined ? {} : { capsolver });
    assert.deepEqual(result.warnings.filter(w => /maxSolvesPerRun/.test(w)), [], JSON.stringify(capsolver));
  }
});

test('a bad capsolver.maxSolvesPerRun is a warning that says no paid solve is allowed, without the key', () => {
  for (const bad of [0, -2, 2.5, '3']) {
    const { result, text } = check({ capsolver: { apiKey: 'CAP-REALKEY12345678', maxSolvesPerRun: bad } });
    assert.equal(result.ok, true, 'it runs, so it is a warning and not a problem');
    const warning = result.warnings.find(w => /maxSolvesPerRun/.test(w));
    assert.ok(warning, `${JSON.stringify(bad)}: ${result.warnings.join('|')}`);
    assert.match(warning, /no paid solve/);
    assert.ok(!text.includes('CAP-REALKEY12345678'));
  }
});
