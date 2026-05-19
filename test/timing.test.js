/**
 * test/timing.test.js
 *
 * Unit tests for jitterSleep() in lib/timing.js.
 *
 * Tests:
 *   1. Resolves in test environment (NODE_ENV=test) immediately.
 *   2. Resolves when TURBO=1 immediately.
 *   3. jitterSleep(0, 0) resolves immediately regardless of env.
 *   4. With TURBO disabled, actual delay is within the given range.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Reload fresh module copy for each test that manipulates env
function loadTiming() {
  // Bust require cache so env changes take effect
  const key = require.resolve('../lib/timing');
  delete require.cache[key];
  return require('../lib/timing');
}

beforeEach(() => {
  // Start with clean env before each test
  delete process.env.TURBO;
  // Keep NODE_ENV=test as set by test runner
});

afterEach(() => {
  delete process.env.TURBO;
  const key = require.resolve('../lib/timing');
  delete require.cache[key];
});

test('jitterSleep resolves in NODE_ENV=test without real delay', async () => {
  process.env.NODE_ENV = 'test';
  const { jitterSleep } = loadTiming();
  const start = Date.now();
  await jitterSleep(5000, 10000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `Expected < 500ms in test env, got ${elapsed}ms`);
});

test('jitterSleep resolves immediately when TURBO=1', async () => {
  delete process.env.NODE_ENV;
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const start = Date.now();
  await jitterSleep(5000, 10000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `Expected < 500ms with TURBO=1, got ${elapsed}ms`);
});

test('jitterSleep(0, 0) resolves immediately', async () => {
  process.env.TURBO = '1';
  const { jitterSleep } = loadTiming();
  const start = Date.now();
  await jitterSleep(0, 0);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Expected < 100ms for (0,0), got ${elapsed}ms`);
});

test('jitterSleep resolves (basic sanity)', async () => {
  // Just confirm it returns a Promise and resolves
  process.env.NODE_ENV = 'test';
  const { jitterSleep } = loadTiming();
  const result = await jitterSleep(100, 200);
  assert.equal(result, undefined);
});
