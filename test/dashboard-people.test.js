/**
 * test/dashboard-people.test.js
 *
 * R8: the dashboard shows one status column per person once the config has more
 * than one, with names reduced to initials. dashboard/people.js decides who the
 * people are and what their initials are; it must agree with the writer's
 * stateKey() about the "Broker|First Last" key.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stateKey } = require('../lib/config');
const { initialsOf, assignInitials, personKeyName, peopleFromConfig, peopleFromState, ownedOptOuts } = require('../dashboard/people');

test('initialsOf takes the first letter of the first and last word, upper-cased', () => {
  assert.equal(initialsOf('Alice Smith'), 'AS');
  assert.equal(initialsOf('mary ann jones'), 'MJ');
  assert.equal(initialsOf('Zed '), 'Z');
  assert.equal(initialsOf('  '), '?');
  assert.equal(initialsOf(undefined), '?');
});

test('assignInitials keeps initials unique inside one list', () => {
  const got = assignInitials(['Alice Smith', 'Adam Stone', 'Bob Jones', 'Anna Stein']);
  assert.deepEqual(got, { 'Alice Smith': 'AS', 'Adam Stone': 'AS2', 'Bob Jones': 'BJ', 'Anna Stein': 'AS3' });
});

test('assignInitials gives a repeated name one entry, not a collision with itself', () => {
  assert.deepEqual(assignInitials(['Alice Smith', 'Alice Smith']), { 'Alice Smith': 'AS' });
});

test('personKeyName is exactly the person half of the state key the runner writes', () => {
  const person = { firstName: 'Mary Ann', lastName: 'Jones' };
  assert.equal(`Spokeo|${personKeyName(person)}`, stateKey('Spokeo', person, 2));
  const blankLast = { firstName: 'Zed', lastName: '' };
  assert.equal(`Spokeo|${personKeyName(blankLast)}`, stateKey('Spokeo', blankLast, 2));
});

test('peopleFromConfig lists persons[] in order with unique initials', () => {
  const cfg = { persons: [{ firstName: 'Alice', lastName: 'Smith' }, { firstName: 'Adam', lastName: 'Stone' }] };
  assert.deepEqual(peopleFromConfig(cfg), [
    { name: 'Alice Smith', initials: 'AS' },
    { name: 'Adam Stone', initials: 'AS2' },
  ]);
});

test('peopleFromConfig reads the single person key and ignores a missing config', () => {
  assert.deepEqual(peopleFromConfig({ person: { firstName: 'Jane', lastName: 'Doe' } }), [{ name: 'Jane Doe', initials: 'JD' }]);
  assert.deepEqual(peopleFromConfig(null), []);
  assert.deepEqual(peopleFromConfig({}), []);
  assert.deepEqual(peopleFromConfig({ persons: 'nope' }), []);
});

test('peopleFromConfig skips persons with no name and hostile shapes', () => {
  const cfg = { persons: [null, 7, { firstName: '', lastName: '' }, { firstName: 'Bob', lastName: 'Jones' }] };
  assert.deepEqual(peopleFromConfig(cfg), [{ name: 'Bob Jones', initials: 'BJ' }]);
});

test('persons[] takes precedence over person, as getPersonsFromConfig does', () => {
  const cfg = { person: { firstName: 'Old', lastName: 'One' }, persons: [{ firstName: 'New', lastName: 'Two' }] };
  assert.deepEqual(peopleFromConfig(cfg).map(p => p.name), ['New Two']);
});

test('peopleFromState finds the people multi-person state keys name, in first-seen order', () => {
  const optOuts = { 'Spokeo|Bob Jones': {}, Intelius: {}, 'Spokeo|Alice Smith': {}, 'MyLife|Bob Jones': {} };
  assert.deepEqual(peopleFromState(optOuts), [{ name: 'Bob Jones', initials: 'BJ' }, { name: 'Alice Smith', initials: 'AS' }]);
  assert.deepEqual(peopleFromState(null), []);
  assert.deepEqual(peopleFromState([]), []);
});

test('ownedOptOuts drops only entries stamped for an identity nobody configured has (CFG2-7)', () => {
  const { personFingerprint } = require('../lib/config');
  const ann = { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' };
  const optOuts = {
    Kept: { history: ['success'], fp: personFingerprint(ann) },
    Unstamped: { history: ['success'] },
    Old: { history: ['success'], fp: personFingerprint({ ...ann, zip: '99999' }) },
    'Composite|Ann Probe': { fp: personFingerprint(ann) },
  };
  const before = JSON.stringify(optOuts);
  const out = ownedOptOuts(optOuts, { person: ann });
  assert.deepEqual(Object.keys(out).sort(), ['Composite|Ann Probe', 'Kept', 'Unstamped']);
  assert.equal(JSON.stringify(optOuts), before, 'the input is not changed');
  assert.deepEqual(Object.keys(ownedOptOuts(optOuts, { persons: [ann, { ...ann, zip: '99999' }] })).sort(), Object.keys(optOuts).sort(), 'any configured person owns it');
  assert.equal(ownedOptOuts(optOuts, null), optOuts, 'no config: nothing to compare against');
  assert.equal(ownedOptOuts(optOuts, {}), optOuts);
  assert.equal(ownedOptOuts(undefined, { person: ann }), undefined);
});
