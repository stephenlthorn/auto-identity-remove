/**
 * test/paths-docker-recipes.test.js
 *
 * R0 collapsed the Docker and Synology recipes to one mount and one variable:
 * `-v ./aidr-home:/home/aidr` with AIDR_HOME=/home/aidr. These checks pin the
 * recipe text people copy, so it cannot drift back into a second `/app/logs`
 * mount, per-file path variables, or a "history does not persist" caveat that
 * stopped being true. test/docs-docker-recipes.test.js keeps guarding the older
 * hazards (single-file mounts, /app/data, uid mismatch); this file is the R0
 * half of the contract.
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

/** Container-side paths of every `-v src:dst` flag and `- src:dst` list entry in `text`. */
function mountTargets(text) {
  const targets = [];
  for (const line of text.split('\n')) {
    const m = line.match(/(?:^\s*-\s+|-v\s+)["']?([^\s"']+?):(\/[^\s"':]+)(?::[a-z,]+)?["']?\s*\\?\s*$/);
    if (m) targets.push(m[2]);
  }
  return targets;
}

test('the README Docker section was located', () => {
  assert.ok(dockerSection.length > 1000, 'precondition: found the Docker section');
});

test('every doc recipe mounts exactly one directory, at /home/aidr', () => {
  for (const [name, text] of DOCS) {
    const targets = mountTargets(text);
    assert.ok(targets.length > 0, `${name}: expected a docker run recipe with a mount`);
    assert.deepEqual([...new Set(targets)], ['/home/aidr'], `${name} must mount only /home/aidr, got ${targets.join(', ')}`);
  }
});

test('no doc recipe passes a per-file path variable with -e (AIDR_HOME replaces them)', () => {
  for (const [name, text] of DOCS) {
    const bad = text.split('\n').filter(l => /-e\s+AIDR_(CONFIG_PATH|CONFIG_ENC_PATH|STATE_PATH|LOG_DIR|DATA_DIR)=/.test(l));
    assert.deepEqual(bad, [], `${name} still teaches per-file variables:\n${bad.join('\n')}`);
  }
});

test('the docs tell the container where home is, with AIDR_HOME=/home/aidr', () => {
  for (const [name, text] of DOCS) {
    assert.match(text, /AIDR_HOME=\/home\/aidr/, `${name} must say AIDR_HOME=/home/aidr`);
  }
});

test('the README lists AIDR_HOME and every override that still wins over it', () => {
  for (const name of ['AIDR_HOME', 'AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR']) {
    assert.ok(dockerSection.includes(name), `the README Docker section must document ${name}`);
  }
  assert.match(dockerSection, /nothing moves/i, 'say that existing installs with no variable set are unchanged');
});

test('the README persistence table says the history and cache files now persist', () => {
  const row = dockerSection.split('\n').find(l => l.includes('/home/aidr/data/'));
  assert.ok(row, 'the table needs a row for /home/aidr/data/');
  assert.match(row, /serp-history/);
  assert.match(row, /exposure-history/);
  assert.match(row, /\|\s*yes\s*\|/, 'the history files persist in the mounted directory');
  assert.doesNotMatch(dockerSection, /do not survive a container|does not survive a container/);
});

test('the recipes no longer ask for a hand-made logs directory or a second logs mount', () => {
  for (const [name, text] of DOCS) {
    assert.doesNotMatch(text, /mkdir -p [^\n]*aidr-home\/logs/, `${name}: the app creates logs/ itself`);
    assert.ok(!mountTargets(text).includes('/app/logs'), `${name} must not mount /app/logs`);
  }
});

test('the docs explain the upgrade from the older multi-mount recipe', () => {
  for (const [name, text] of DOCS) {
    assert.match(text, /Upgrading from the older recipe/, `${name} must tell existing Docker users what changes`);
  }
});

test('the home directory is the confirmation inbox too', () => {
  assert.match(dockerSection, /inbox\/confirms/);
});
