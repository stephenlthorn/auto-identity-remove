/**
 * test/docs-cfg2.test.js
 *
 * The round-2 config findings change what a person has to know: the old Docker recipe
 * is ignored, a login is required even on loopback (with one documented opt-out),
 * --encrypt-config never empties a file it cannot delete. These are static checks that
 * the places people read say so.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('README: the Docker section explains the single-file recipe is ignored and what to copy', () => {
  const readme = read('README.md');
  const docker = readme.slice(readme.indexOf('## Running with Docker'), readme.indexOf('### Webhook notifications'));
  assert.match(docker, /Upgrading from the single-file recipe/);
  assert.match(docker, /cp state\.json aidr-home\/state\.json/);
  assert.match(docker, /re-submits every broker/);
});

test('README: encrypting never empties a file it cannot delete, and says what to do instead', () => {
  const readme = read('README.md');
  assert.match(readme, /If `config\.json` cannot be deleted/);
  assert.match(readme, /never emptied/i);
});

test('README: the fingerprint no longer lists the phone number', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /name, ZIP, email and phone digits/);
  assert.match(readme, /phone number is not part of it/);
});

test('the dashboard README documents the login requirement and the one opt-out', () => {
  const doc = read('dashboard/README.md');
  assert.match(doc, /AIDR_DASHBOARD_NO_AUTH/);
  assert.match(doc, /refuses to start/);
  assert.doesNotMatch(doc, /runs \*\*unauthenticated\*\* \(and logs a/);
});

test('SYNOLOGY.md, the Dockerfile and compose all carry the migration note', () => {
  assert.match(read('docs/SYNOLOGY.md'), /config\.json not found" right after an upgrade/);
  assert.match(read('Dockerfile'), /Coming from the first recipe/);
  assert.match(read('docker-compose.yml'), /Upgrading from the first recipe/);
});
