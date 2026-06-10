/**
 * test/hibp.test.js
 *
 * Hermetic unit tests for lib/hibp.js (Have I Been Pwned breach integration).
 * No live network: every HTTP call goes through an injected fetchImpl stub.
 * No real config/state writes.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  runBreachCheck,
  formatBreachReport,
} = require('../lib/hibp');

// ─── Fake fetch factory ──────────────────────────────────────────────────────
// Returns a fetchImpl that records calls and yields a queued Response-like
// object. Each entry is { status, json } where json is the parsed body.
function makeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      async json() {
        if (next.json === undefined) throw new Error('no json body');
        return next.json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

// ─── severityOf ──────────────────────────────────────────────────────────────

test('severityOf returns high when SSN present', () => {
  assert.equal(severityOf(['Email addresses', 'SSN']), 'high');
});

test('severityOf returns high for "Social security numbers" label', () => {
  assert.equal(severityOf(['Social security numbers']), 'high');
});

test('severityOf returns high when Passwords present', () => {
  assert.equal(severityOf(['Email addresses', 'Passwords']), 'high');
});

test('severityOf returns high when Physical addresses present', () => {
  assert.equal(severityOf(['Names', 'Physical addresses']), 'high');
});

test('severityOf is case-insensitive for high triggers', () => {
  assert.equal(severityOf(['passwords']), 'high');
  assert.equal(severityOf(['social security numbers']), 'high');
});

test('severityOf returns medium for phone numbers / dates of birth', () => {
  assert.equal(severityOf(['Email addresses', 'Phone numbers']), 'medium');
  assert.equal(severityOf(['Dates of birth']), 'medium');
});

test('severityOf returns low for email-only / usernames', () => {
  assert.equal(severityOf(['Email addresses']), 'low');
  assert.equal(severityOf(['Usernames']), 'low');
});

test('severityOf returns low for empty / missing dataClasses', () => {
  assert.equal(severityOf([]), 'low');
  assert.equal(severityOf(undefined), 'low');
  assert.equal(severityOf(null), 'low');
});
