/**
 * test/allowlist-cli-args.test.js
 *
 * Covers the pure argv parsing for the --allow / --unallow subcommands.
 * The disk-writing wrapper in watcher.js is intentionally not unit-tested
 * (it touches the real config.json); the pure edit it calls is covered by
 * test/allowlist.test.js, and the atomic write mirrors lib/config.js saveState.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAllowlistArgs } = require('../lib/allowlist-edit');

test('parseAllowlistArgs: detects --allow with its value', () => {
  const r = parseAllowlistArgs(['node', 'watcher.js', '--allow', 'Spokeo']);
  assert.deepEqual(r, { action: 'allow', name: 'Spokeo' });
});

test('parseAllowlistArgs: detects --unallow with its value', () => {
  const r = parseAllowlistArgs(['node', 'watcher.js', '--unallow', 'BeenVerified']);
  assert.deepEqual(r, { action: 'unallow', name: 'BeenVerified' });
});

test('parseAllowlistArgs: returns null when neither flag present', () => {
  assert.equal(parseAllowlistArgs(['node', 'watcher.js', '--list']), null);
});

test('parseAllowlistArgs: returns an error marker when value missing', () => {
  assert.deepEqual(
    parseAllowlistArgs(['node', 'watcher.js', '--allow']),
    { action: 'allow', name: null, error: 'missing broker name' }
  );
});

test('parseAllowlistArgs: rejects a flag-looking value (e.g. --allow --serp-scan)', () => {
  assert.deepEqual(
    parseAllowlistArgs(['node', 'watcher.js', '--allow', '--serp-scan']),
    { action: 'allow', name: null, error: 'missing broker name' }
  );
});
