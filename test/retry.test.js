/**
 * test/retry.test.js
 *
 * Tests for lib/retry.js — withRetry(fn, opts)
 *
 * withRetry retries fn() on transient errors:
 *   - Error message includes 'Timeout'
 *   - Error message includes 'net::ERR_'
 *   - Error message includes 'status 502', 'status 503', 'status 504'
 *
 * Non-retriable errors (selector misses, CAPTCHA failures, etc.) are thrown
 * immediately on first failure.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withRetry } = require('../lib/retry');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSleep() {
  const calls = [];
  return {
    sleep: async (ms) => { calls.push(ms); },
    calls,
  };
}

function makeCounter(failTimes, error, successValue = 'ok') {
  let attempts = 0;
  return async () => {
    attempts++;
    if (attempts <= failTimes) throw error;
    return successValue;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('returns immediately on first success — no sleep called', async () => {
  const { sleep, calls } = makeSleep();
  const fn = async () => 'result';
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'result');
  assert.equal(calls.length, 0);
});

test('retries twice then succeeds — sleep called with 500 then 1000', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('net::ERR_CONNECTION_RESET');
  const fn = makeCounter(2, err, 'success');
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'success');
  assert.deepEqual(calls, [500, 1000]);
});

test('throws original error after 3 consecutive failures', async () => {
  const { sleep } = makeSleep();
  const err = new Error('Timeout exceeded');
  const fn = makeCounter(99, err);
  await assert.rejects(
    () => withRetry(fn, { sleep }),
    (thrown) => thrown === err
  );
});

test('non-retriable error (selector miss) throws immediately — no retries', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('Selector not found: button#submit');
  const fn = makeCounter(3, err);
  await assert.rejects(
    () => withRetry(fn, { sleep }),
    (thrown) => thrown === err
  );
  assert.equal(calls.length, 0);
});

test('non-retriable CAPTCHA failure throws immediately', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('captcha_failed: recaptcha not solved');
  const fn = makeCounter(3, err);
  await assert.rejects(
    () => withRetry(fn, { sleep }),
    (thrown) => thrown === err
  );
  assert.equal(calls.length, 0);
});

test('retries on net::ERR_ prefixed errors', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('net::ERR_NETWORK_CHANGED');
  const fn = makeCounter(1, err, 'done');
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'done');
  assert.deepEqual(calls, [500]);
});

test('retries on 502 status error', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('status 502 received');
  const fn = makeCounter(1, err, 'done');
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'done');
  assert.deepEqual(calls, [500]);
});

test('retries on 503 status error', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('Request failed with status 503');
  const fn = makeCounter(1, err, 'done');
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'done');
  assert.deepEqual(calls, [500]);
});

test('retries on 504 status error', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('Gateway Timeout — status 504');
  const fn = makeCounter(1, err, 'done');
  const result = await withRetry(fn, { sleep });
  assert.equal(result, 'done');
  assert.deepEqual(calls, [500]);
});

test('does NOT retry on 400/404 errors', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('status 404 not found');
  const fn = makeCounter(3, err);
  await assert.rejects(
    () => withRetry(fn, { sleep }),
    (thrown) => thrown === err
  );
  assert.equal(calls.length, 0);
});

test('custom attempts: 5 honored — retries up to 4 times before throwing', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('Timeout waiting for selector');
  const fn = makeCounter(99, err);
  await assert.rejects(
    () => withRetry(fn, { attempts: 5, sleep }),
    (thrown) => thrown === err
  );
  // 4 retries means 4 sleep calls with backoff: 500, 1000, 2000, 4000
  assert.deepEqual(calls, [500, 1000, 2000, 4000]);
});

test('custom baseMs honored — backoff uses provided base', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('net::ERR_TIMED_OUT');
  const fn = makeCounter(2, err, 'ok');
  await withRetry(fn, { baseMs: 100, sleep });
  assert.deepEqual(calls, [100, 200]);
});

test('default attempts is 3 — exactly 2 sleep calls on total failure', async () => {
  const { sleep, calls } = makeSleep();
  const err = new Error('Timeout');
  const fn = makeCounter(99, err);
  await assert.rejects(() => withRetry(fn, { sleep }));
  assert.equal(calls.length, 2);
});
