/**
 * test/config-check-state-unreadable.test.js
 *
 * CFG2-2 follow-through: a state.json this user cannot read used to be a warning
 * ("a run would start with empty history"). Saving over it is now refused, so the
 * run cannot record anything: that is a problem, and `aidr config check` must say
 * so before a scheduled run finds out.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkConfig } = require('../lib/config-check');
const h = require('./config-check-helpers');

const skipReason = process.platform === 'win32' || (process.getuid && process.getuid() === 0)
  ? 'needs a non-root POSIX user'
  : false;

test('an unreadable state file is a problem, not a warning', { skip: skipReason }, () => {
  const root = h.makeRoot();
  try {
    h.writePlain(root);
    const state = path.join(root, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ optOuts: { Spokeo: {} } }));
    fs.chmodSync(state, 0o000);
    const r = checkConfig({ env: {}, root });
    fs.chmodSync(state, 0o600);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes(state) && /cannot be read \(EACCES\)/.test(p) && /chown|chmod/.test(p)), r.problems.join('\n'));
  } finally {
    h.cleanup(root);
  }
});
