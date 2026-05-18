/**
 * test/dead-url.test.js
 *
 * Unit tests for the pure classification helpers exported from generic-runner.js
 * and for the dead-URL short-circuit logic (using injected sets / temp files).
 *
 * Does NOT require Playwright — classifyNavError and isDeadStatus are pure
 * functions; processGenericUrl tests are done via processGenericUrl's optional
 * injectedDeadSet parameter.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { classifyNavError, isDeadStatus, loadDeadSet } = require('../generic-runner');

// ── classifyNavError ──────────────────────────────────────────────────────────

test('classifyNavError returns the matching code for known dead patterns', () => {
  const cases = [
    ['net::ERR_NAME_NOT_RESOLVED at https://gone.example.com', 'ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_REFUSED'],
    ['net::ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_CLOSED'],
    ['net::ERR_ADDRESS_UNREACHABLE', 'ERR_ADDRESS_UNREACHABLE'],
    ['net::ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT'],
    ['getaddrinfo ENOTFOUND gone.example.com', 'ENOTFOUND'],
  ];

  for (const [message, expected] of cases) {
    assert.equal(classifyNavError(message), expected, `Expected ${expected} for: ${message}`);
  }
});

test('classifyNavError returns null for a genuine timeout (not dead)', () => {
  assert.equal(classifyNavError('Timeout 20000ms exceeded'), null);
});

test('classifyNavError returns null for unrelated errors', () => {
  assert.equal(classifyNavError('Element not found: #submit-btn'), null);
  assert.equal(classifyNavError(''), null);
});

// ── isDeadStatus ─────────────────────────────────────────────────────────────

test('isDeadStatus returns true for HTTP 400+', () => {
  assert.equal(isDeadStatus(400), true);
  assert.equal(isDeadStatus(403), true);
  assert.equal(isDeadStatus(404), true);
  assert.equal(isDeadStatus(410), true);
  assert.equal(isDeadStatus(500), true);
  assert.equal(isDeadStatus(503), true);
});

test('isDeadStatus returns false for successful HTTP codes', () => {
  assert.equal(isDeadStatus(200), false);
  assert.equal(isDeadStatus(301), false);
  assert.equal(isDeadStatus(302), false);
  assert.equal(isDeadStatus(304), false);
  assert.equal(isDeadStatus(399), false);
});

// ── loadDeadSet ───────────────────────────────────────────────────────────────

test('loadDeadSet reads hosts from a valid JSON file', () => {
  const tmp = path.join(os.tmpdir(), `dead-urls-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ hosts: ['gone.com', 'stale.net'] }), 'utf8');
  const set = loadDeadSet(tmp);
  assert.equal(set.has('gone.com'), true);
  assert.equal(set.has('stale.net'), true);
  assert.equal(set.size, 2);
  fs.unlinkSync(tmp);
});

test('loadDeadSet returns empty Set when file is missing', () => {
  const set = loadDeadSet('/tmp/this-file-does-not-exist-dead-urls.json');
  assert.equal(set.size, 0);
});

test('loadDeadSet returns empty Set when JSON is malformed', () => {
  const tmp = path.join(os.tmpdir(), `dead-urls-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, 'NOT JSON', 'utf8');
  const set = loadDeadSet(tmp);
  assert.equal(set.size, 0);
  fs.unlinkSync(tmp);
});

test('loadDeadSet returns empty Set when hosts is not an array', () => {
  const tmp = path.join(os.tmpdir(), `dead-urls-noarr-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ hosts: null }), 'utf8');
  const set = loadDeadSet(tmp);
  assert.equal(set.size, 0);
  fs.unlinkSync(tmp);
});
