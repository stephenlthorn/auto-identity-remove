/**
 * test/drop-record-validates-day.test.js
 *
 * The 90-day clock hangs on the recorded day, so recordDropRequest refuses anything that is
 * not a real YYYY-MM-DD day, before it touches the state or the state file.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recordDropRequest, getDropRequest } = require('../lib/drop');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', country: 'US', email: 'jane@sample.example' };

test('a day that is not a real calendar day is refused and nothing is written or saved', () => {
  for (const bad of ['garbage', '2026-02-30', '2026-13-01', '17/11/2026', '', undefined, null]) {
    const state = {};
    let saves = 0;
    assert.throws(() => recordDropRequest(state, JANE, bad, { save: () => { saves += 1; } }), /YYYY-MM-DD/, String(bad));
    assert.equal(saves, 0);
    assert.equal(getDropRequest(state, JANE), null);
    assert.deepEqual(state, {});
  }
});
