/**
 * test/runtime-files-not-shipped.test.js
 *
 * Every durable file this tool writes at the repo root holds either PII or a
 * record of which brokers hold PII about you, so none of them may ever be
 * committable. .gitignore covered config.json and the state trio but missed
 * state.json.checkpoint (the resume marker, written on every broker) and its
 * atomic-write temp file - so a contributor working from a checkout could push
 * their own run history. Spotted in PR #9.
 *
 * Rather than reading .gitignore and trusting it, this asks git itself, and
 * derives the paths from lib/config.js so a new runtime file cannot be added
 * without either ignoring it or failing here.
 *
 * Git is only half of it. The Dockerfile does `COPY . .`, so a path missing
 * from .dockerignore is baked into an image layer and travels with the image
 * to any registry it is pushed to. The first version of this file checked git
 * alone and shipped that exact gap: state.json.checkpoint was kept out of the
 * repo and copied straight into the image. Found by the cross-model review of
 * a3bcbe1 and reproduced with a real `docker build`.
 *
 * The parity test below is structural. Its behavioural counterpart is the
 * "Image must not contain PII or secrets" step in .github/workflows/test.yml,
 * which builds the image and looks inside it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CONFIG_PATH, CONFIG_ENC_PATH, STATE_PATH } = require('../lib/config');

const ROOT = path.resolve(__dirname, '..');

/** Paths the tool writes at the repo root during a normal run. */
const RUNTIME_PATHS = [
  CONFIG_PATH,
  CONFIG_ENC_PATH,
  STATE_PATH,
  STATE_PATH + '.bak',
  STATE_PATH + '.tmp',
  STATE_PATH + '.lock',
  STATE_PATH + '.checkpoint',
  STATE_PATH + '.checkpoint.tmp',
];

/** @returns {boolean} true when git would ignore the path. */
function isIgnored(abs) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', abs], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

test('git check-ignore is actually answering, not failing open', () => {
  assert.equal(isIgnored(path.join(ROOT, 'node_modules', 'anything')), true);
  assert.equal(isIgnored(path.join(ROOT, 'README.md')), false);
});

test('every runtime file written at the repo root is git-ignored', () => {
  const leaks = RUNTIME_PATHS.filter(p => !isIgnored(p)).map(p => path.relative(ROOT, p));
  assert.deepEqual(leaks, [], `these runtime files are committable: ${leaks.join(', ')}`);
});

/**
 * Lines of .dockerignore, comments and blanks dropped.
 * @returns {string[]}
 */
function dockerignorePatterns() {
  return fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

test('.dockerignore is readable and non-trivial', () => {
  const patterns = dockerignorePatterns();
  assert.ok(patterns.length > 5, `expected a populated .dockerignore, got ${patterns.length} patterns`);
  assert.ok(patterns.includes('config.json'), 'config.json should already be excluded');
});

test('every runtime file kept out of git is also kept out of the image', () => {
  // Deliberately literal: .dockerignore lists these by name, and matching a
  // real dockerignore pattern set would mean reimplementing Docker's matcher
  // and trusting that instead. A trailing-* form of the same path counts.
  const patterns = new Set(dockerignorePatterns());
  const excluded = rel => patterns.has(rel) || patterns.has(rel + '*');

  const leaks = RUNTIME_PATHS
    .map(p => path.relative(ROOT, p))
    .filter(rel => !excluded(rel));

  assert.deepEqual(
    leaks,
    [],
    'COPY . . will bake these into the image; add them to .dockerignore: ' + leaks.join(', ')
  );
});
