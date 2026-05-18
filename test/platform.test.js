/**
 * test/platform.test.js
 *
 * Covers lib/platform.js getPlatform() mapping. The function takes an optional
 * platform string param (defaulting to process.platform) so we test the pure
 * mapping without stubbing globals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getPlatform } = require('../lib/platform');

test('getPlatform: darwin → macos', () => {
  assert.equal(getPlatform('darwin'), 'macos');
});

test('getPlatform: win32 → windows', () => {
  assert.equal(getPlatform('win32'), 'windows');
});

test('getPlatform: linux → linux', () => {
  assert.equal(getPlatform('linux'), 'linux');
});

test('getPlatform: unknown platform → linux (fallback)', () => {
  assert.equal(getPlatform('freebsd'), 'linux');
  assert.equal(getPlatform('sunos'), 'linux');
});

test('getPlatform: no arg uses process.platform and returns a known value', () => {
  assert.ok(['macos', 'linux', 'windows'].includes(getPlatform()));
});
