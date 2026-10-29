/**
 * test/docs-docker-recipes.test.js
 *
 * The README and docs/SYNOLOGY.md Docker recipes are what people copy. For a
 * long time they could not work: they mounted the project over /app/data (which
 * hides the shipped broker datasets), mounted state.json as a single file (lock,
 * .bak and resume checkpoint stayed in the throwaway container layer), never
 * said where config.json lives, and ignored that the container runs as uid 1001
 * while the files they tell you to create are 0600 and owned by you (CFG-3,
 * CFG-4, CORE-14). Nothing tested the docs, so none of it was noticed.
 *
 * These are static checks on the recipe text: they cannot prove a recipe works,
 * only that it no longer contains the shapes known not to.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const readme = read('README.md');
const synology = read('docs/SYNOLOGY.md');
const dockerSection = readme.slice(
  readme.indexOf('## Running with Docker'),
  readme.indexOf('### Webhook notifications'),
);

const DOCS = [
  ['README.md Docker section', dockerSection],
  ['docs/SYNOLOGY.md', synology],
];

test('the README Docker section was located', () => {
  assert.ok(dockerSection.length > 500, 'precondition: found the Docker section');
});

test('no doc recipe mounts anything over /app/data', () => {
  for (const [name, text] of DOCS) {
    const bad = text.split('\n').filter(l => /(-v\s|^\s*-\s)\S*:\/app\/data\b/.test(l));
    assert.deepEqual(bad, [], `${name} mounts over /app/data, hiding the shipped broker datasets:\n${bad.join('\n')}`);
  }
});

test('no doc recipe mounts state.json or config.json as a single file', () => {
  for (const [name, text] of DOCS) {
    const bad = text.split('\n').filter(l => /(-v\s|^\s*-\s)\S*:\/app\/(state|config)\.json(\.enc)?\b/.test(l));
    assert.deepEqual(bad, [], `${name} uses a single-file mount (EBUSY on rename; lock, .bak and checkpoint are lost):\n${bad.join('\n')}`);
  }
});

test('every doc recipe tells the container where its config and state live', () => {
  for (const [name, text] of DOCS) {
    assert.match(text, /AIDR_CONFIG_PATH=\/home\/aidr\//, `${name} must set AIDR_CONFIG_PATH inside the mounted directory`);
    assert.match(text, /AIDR_STATE_PATH=\/home\/aidr\//, `${name} must set AIDR_STATE_PATH inside the mounted directory`);
  }
});

test('every doc explains the uid mismatch with chown 1001 or a user: override', () => {
  for (const [name, text] of DOCS) {
    assert.match(
      text,
      /chown -R 1001:1001|--user\b|user:\s*"?\$\{AIDR_UID/,
      `${name} must say how to make the 0600 files readable by the container user (uid 1001)`,
    );
  }
});

test('every doc mentions AIDR_PASSPHRASE_FILE for unattended encrypted runs', () => {
  for (const [name, text] of [...DOCS, ['SECURITY.md', read('SECURITY.md')]]) {
    assert.match(text, /AIDR_PASSPHRASE_FILE/, `${name} must document the passphrase file for scheduled runs`);
  }
});

test('the docs name everything that does and does not persist in a container', () => {
  assert.match(dockerSection, /\/app\/logs/);
  assert.match(dockerSection, /serp-history|exposure-history|feeds-brokers/,
    'SERP/exposure history and the registry cache are not persisted in Docker today; the section must say so');
});

test('the README says what --verify really does: it saves state and writes no report file', () => {
  const verify = readme.slice(
    readme.indexOf('### Verifying removals'),
    readme.indexOf('### Continuous SERP monitoring'),
  );
  assert.ok(verify.length > 200, 'precondition: found the --verify section');
  assert.doesNotMatch(verify, /nothing is written to `state\.json`/, '--verify calls saveState()');
  assert.doesNotMatch(verify, /logs\/verify-/, '--verify writes no logs/verify-*.json report');
  assert.match(verify, /state\.json/, 'say that the outcome is recorded in state.json');
});

test('PRIVACY.md does not call --verify free of state changes', () => {
  assert.doesNotMatch(read('docs/PRIVACY.md'), /no form submissions, no state changes/);
});
