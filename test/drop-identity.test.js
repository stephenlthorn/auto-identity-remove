/**
 * test/drop-identity.test.js
 *
 * D3 of the 2.1 review: a DROP record belongs to one identity, not to a name. It
 * carries the same fingerprint the rest of the state uses (lib/identity.js), so a
 * namesake or a replaced config person does not inherit someone else's request.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const drop = require('../lib/drop');
const { personFingerprint } = require('../lib/identity');

const SR = { firstName: 'John', lastName: 'Smith', state: 'CA', zip: '93701', email: 'john.sr@sample-test.example' };
const JR = { firstName: 'John', lastName: 'Smith', state: 'CA', zip: '94105', email: 'john.jr@sample-test.example' };
const save = () => {};

test('recording stamps the identity fingerprint on the record', () => {
  const state = {};
  drop.recordDropRequest(state, SR, '2026-09-01', { save });
  assert.deepEqual(state.drop['John Smith'], { submittedAt: '2026-09-01', fp: personFingerprint(SR) });
});

test('a namesake does not read the record: Sr filed, Jr has none', () => {
  const state = {};
  drop.recordDropRequest(state, SR, '2026-09-01', { save });
  assert.deepEqual(drop.getDropRequest(state, SR), { submittedAt: '2026-09-01' });
  assert.equal(drop.getDropRequest(state, JR), null);
  assert.deepEqual(drop.dropStatus({ state, person: JR, today: '2026-11-17' }), { kind: 'none' });
  assert.equal(drop.makeCoveredByDrop({ person: JR, state, config: {}, registryHosts: { 'acme.example': ['CA'] } }), null);
});

test('a config person replaced by another of the same name does not inherit the record', () => {
  const state = {};
  drop.recordDropRequest(state, SR, '2026-09-01', { save });
  assert.equal(drop.getDropRequest(state, { ...SR, email: 'someone.else@sample-test.example' }), null);
});

test('an edit that does not change identity (phone, city) keeps the record', () => {
  const state = {};
  drop.recordDropRequest(state, SR, '2026-09-01', { save });
  assert.deepEqual(drop.getDropRequest(state, { ...SR, phone: '5595550101', city: 'Fresno' }), { submittedAt: '2026-09-01' });
});

test('a record with no fingerprint (written before 2.1 shipped, development only) is still read', () => {
  const state = { drop: { 'John Smith': { submittedAt: '2026-09-01' } } };
  assert.deepEqual(drop.getDropRequest(state, SR), { submittedAt: '2026-09-01' });
});

test('a record whose fingerprint is not a string is treated as not matching', () => {
  const state = { drop: { 'John Smith': { submittedAt: '2026-09-01', fp: 42 } } };
  assert.equal(drop.getDropRequest(state, SR), null);
});

const run = (options, persons = [SR, JR]) => {
  const state = { optOuts: {} };
  const result = drop.runDrop({ persons, state, options, registryCount: 0, today: '2026-11-17', save });
  return { ...result, state, text: result.lines.join('\n') };
};

test('--person that matches two configured people is refused for --done and --clear, naming what differs', () => {
  for (const options of [{ done: true, person: 'John Smith' }, { clear: true, person: 'john smith' }]) {
    const r = run(options);
    assert.equal(r.code, 2);
    assert.match(r.text, /more than one/);
    assert.match(r.text, /zip/);
    assert.match(r.text, /email/);
    assert.doesNotMatch(r.text, /93701|94105|sample-test/, 'no detail values are printed');
    assert.equal(r.state.drop, undefined);
  }
});

test('--person that matches one person works as before', () => {
  const other = { firstName: 'Janet', lastName: 'Smith', state: 'CA', zip: '93701', email: 'janet@sample-test.example' };
  const r = run({ done: true, person: 'Janet Smith' }, [SR, other]);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.state.drop), ['Janet Smith']);
});
