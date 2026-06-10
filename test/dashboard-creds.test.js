/**
 * test/dashboard-creds.test.js
 *
 * Unit tests for the dashboard credential generator used by `aidr dashboard`.
 * Pure (uses crypto.randomBytes) - no network, no filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateDashboardCreds } = require('../lib/dashboard-creds');

test('generateDashboardCreds returns a user and pass', () => {
  const c = generateDashboardCreds();
  assert.equal(typeof c.user, 'string');
  assert.equal(typeof c.pass, 'string');
  assert.ok(c.user.length > 0, 'user must be non-empty');
});

test('generated password is long enough to be secure', () => {
  const c = generateDashboardCreds();
  assert.ok(c.pass.length >= 16, `password length ${c.pass.length} must be >= 16`);
});

test('generated password is URL-safe (no characters that break Basic auth or URLs)', () => {
  const c = generateDashboardCreds();
  assert.match(c.pass, /^[A-Za-z0-9_-]+$/, 'password must be URL-safe base64url chars only');
});

test('two successive calls produce different passwords (randomness)', () => {
  const a = generateDashboardCreds();
  const b = generateDashboardCreds();
  assert.notEqual(a.pass, b.pass, 'passwords must differ across calls');
});

test('default username is "admin"', () => {
  const c = generateDashboardCreds();
  assert.equal(c.user, 'admin');
});
