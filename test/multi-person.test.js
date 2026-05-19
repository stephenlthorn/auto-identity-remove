const { test } = require('node:test');
const assert = require('node:assert/strict');

// We'll test by passing config directly to a helper.
// loadConfig() reads from disk so we test the extraction logic instead.

const { getPersonsFromConfig } = require('../lib/config');

test('getPersonsFromConfig: single person config returns array of one', () => {
  const config = { person: { firstName: 'Jane', lastName: 'Doe' } };
  const result = getPersonsFromConfig(config);
  assert.equal(result.length, 1);
  assert.equal(result[0].firstName, 'Jane');
});

test('getPersonsFromConfig: persons array returns all entries', () => {
  const config = { persons: [
    { firstName: 'Jane', lastName: 'Doe' },
    { firstName: 'John', lastName: 'Doe' },
  ]};
  const result = getPersonsFromConfig(config);
  assert.equal(result.length, 2);
  assert.equal(result[1].firstName, 'John');
});

test('getPersonsFromConfig: empty persons array throws', () => {
  assert.throws(() => getPersonsFromConfig({ persons: [] }), /person/i);
});

test('getPersonsFromConfig: missing both person and persons throws', () => {
  assert.throws(() => getPersonsFromConfig({}), /person/i);
});

test('getPersonsFromConfig: persons array takes precedence over person', () => {
  const config = {
    person: { firstName: 'Old', lastName: 'Config' },
    persons: [{ firstName: 'Jane', lastName: 'Doe' }],
  };
  const result = getPersonsFromConfig(config);
  assert.equal(result.length, 1);
  assert.equal(result[0].firstName, 'Jane');
});
