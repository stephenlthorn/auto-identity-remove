/**
 * test/drop-config.test.js
 *
 * The drop block of config.json: `aidr config check` warns about a value that would be
 * silently ignored, and config.example.json documents the key.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkConfig } = require('../lib/config-check');
const h = require('./config-check-helpers');
const example = require('../config.example.json');

function check(extra) {
  const root = h.makeRoot();
  try {
    h.writePlain(root, h.goodConfig(extra));
    return checkConfig({ env: {}, root });
  } finally {
    h.cleanup(root);
  }
}

test('drop.alsoSubmit true, false or absent is clean', () => {
  for (const drop of [undefined, { alsoSubmit: true }, { alsoSubmit: false }, { _comment: 'x' }]) {
    const result = check(drop === undefined ? {} : { drop });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.filter(w => /drop/i.test(w)), [], JSON.stringify(drop));
  }
});

test('a non-boolean drop.alsoSubmit is a warning, not a failure', () => {
  const result = check({ drop: { alsoSubmit: 'yes' } });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /drop\.alsoSubmit must be true or false/.test(w)), result.warnings.join('\n'));
});

test('config.example.json documents drop.alsoSubmit, off by default', () => {
  assert.equal(example.drop.alsoSubmit, false);
  assert.match(example.drop._comment, /DROP/);
  assert.match(example.drop._comment, /aidr drop/);
});
