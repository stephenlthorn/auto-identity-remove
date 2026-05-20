const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStealthScript } = require('../lib/stealth');

test('buildStealthScript returns a non-empty string', () => {
  const script = buildStealthScript();
  assert.ok(typeof script === 'string' && script.length > 0);
});
test('buildStealthScript contains webdriver override', () => {
  assert.ok(buildStealthScript().includes('webdriver'));
});
test('buildStealthScript contains plugins stub', () => {
  assert.ok(buildStealthScript().includes('plugins'));
});
test('buildStealthScript contains navigator.languages', () => {
  assert.ok(buildStealthScript().includes('languages'));
});
test('buildStealthScript does not throw when called twice (pure function)', () => {
  const a = buildStealthScript();
  const b = buildStealthScript();
  assert.equal(a, b);
});
