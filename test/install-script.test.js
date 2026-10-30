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
  assert.match(src, /\b20\b/, 'must reference the Node 20 minimum');
});

test('install.sh runs npm ci', () => {
  const src = read();
  assert.match(src, /npm ci/);
});

test('install.sh installs the Playwright Chromium browser', () => {
  const src = read();
  assert.match(src, /npx playwright install chromium/);
});

test('install.sh prints the next step, as a command that actually runs', () => {
  // This used to assert the literal string "aidr setup", which install.sh
  // satisfied with `./node_modules/.bin/aidr setup` - a path npm never creates
  // for a package's own bin entry. The test passed; the documented command did
  // not exist. Assert the working invocation instead.
  const src = read();
  assert.match(src, /node bin\/aidr\.js setup/, 'the printed next step must be a runnable command');
  assert.doesNotMatch(
    src,
    /node_modules\/\.bin\/aidr/,
    'npm does not create a .bin shim for the root package, so this path never exists',
  );
});

test('install.sh installs the dashboard dependencies too', () => {
  // express is declared only in dashboard/package.json, so a documented install
  // that skips this leaves `aidr dashboard` unable to start.
  assert.match(read(), /cd dashboard && npm ci/);
});
