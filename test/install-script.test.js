/**
 * test/install-script.test.js
 *
 * Static checks on install.sh. We do NOT execute the installer (it would run
 * npm ci and download a browser) - we assert the script contains the required
 * steps and safety guards so the install flow can't silently regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'install.sh');

function read() {
  return fs.readFileSync(SCRIPT, 'utf8');
}

test('install.sh exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'install.sh must exist at repo root');
});

test('install.sh has a sh/bash shebang and set -e', () => {
  const src = read();
  assert.match(src.split('\n')[0], /^#!\/usr\/bin\/env (bash|sh)|^#!\/bin\/(bash|sh)/);
  assert.match(src, /set -e/);
});

test('install.sh checks for node and a minimum major version', () => {
  const src = read();
  assert.match(src, /command -v node/);
  assert.match(src, /\b18\b/, 'must reference the Node 18 minimum');
});

test('install.sh runs npm ci', () => {
  const src = read();
  assert.match(src, /npm ci/);
});

test('install.sh installs the Playwright Chromium browser', () => {
  const src = read();
  assert.match(src, /npx playwright install chromium/);
});

test('install.sh prints the next step (aidr setup)', () => {
  const src = read();
  assert.match(src, /aidr setup/);
});
