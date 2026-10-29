/**
 * test/dashboard-banner.test.js
 *
 * DASH-12 helpers: the banner text, where saved credentials live, and the
 * "is express installed" probe. The end-to-end behaviour is covered by
 * test/cli-dashboard-banner.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  formatBanner,
  resolveAuthFile,
  hasSavedCredentials,
  findExpress,
  expressMissingMessage,
} = require('../lib/dashboard-creds');

test('banner with generated credentials shows URL, user and password once', () => {
  const out = formatBanner({ host: '127.0.0.1', port: 8080, generated: { user: 'admin', pass: 'p4ss' } });
  assert.match(out, /URL:\s+http:\/\/127\.0\.0\.1:8080/);
  assert.match(out, /Username: admin/);
  assert.match(out, /Password: p4ss/);
  assert.match(out, /shown once/);
});

test('DASH-12: with saved credentials the banner prints no password', () => {
  // dashboard/.auth.json overrides AIDR_USER/AIDR_PASS, so any generated password
  // printed next to it would 401. The banner must say to use the saved login.
  const out = formatBanner({ host: '127.0.0.1', port: 8080, savedCredentials: true });
  assert.doesNotMatch(out, /Password:/);
  assert.doesNotMatch(out, /Username:/);
  assert.match(out, /saved credentials/);
});

test('banner for env credentials names the variables and prints no secret', () => {
  const out = formatBanner({ host: '127.0.0.1', port: 9000, envCredentials: true });
  assert.match(out, /AIDR_USER/);
  assert.doesNotMatch(out, /Password:/);
});

test('wildcard and IPv6 binds are shown as something a browser can open', () => {
  assert.match(formatBanner({ host: '0.0.0.0', port: 1 }), /http:\/\/localhost:1/);
  assert.match(formatBanner({ host: '::', port: 1 }), /http:\/\/localhost:1/);
  assert.match(formatBanner({ host: '::1', port: 1 }), /http:\/\/\[::1\]:1/);
});

test('resolveAuthFile defaults to dashboard/.auth.json and honours AIDR_AUTH_FILE', () => {
  assert.equal(resolveAuthFile({}, '/srv/aidr/dashboard'), path.join('/srv/aidr/dashboard', '.auth.json'));
  assert.equal(resolveAuthFile({ AIDR_AUTH_FILE: '/etc/aidr/auth.json' }, '/x'), '/etc/aidr/auth.json');
});

test('hasSavedCredentials reflects whether the file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-banner-'));
  const file = path.join(dir, 'auth.json');
  assert.equal(hasSavedCredentials(file), false);
  fs.writeFileSync(file, '{}');
  assert.equal(hasSavedCredentials(file), true);
});

test('findExpress is false for a directory with no express anywhere above it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-no-express-'));
  assert.equal(findExpress(dir), false);
});

test('findExpress is true when the directory has express installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-has-express-'));
  const pkg = path.join(dir, 'node_modules', 'express');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"express","main":"index.js"}');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = {};');
  assert.equal(findExpress(dir), true);
});

test('the missing-express message says how to install it', () => {
  assert.match(expressMissingMessage(), /npm install/);
  assert.match(expressMissingMessage(), /dashboard/);
});
