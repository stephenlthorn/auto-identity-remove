/**
 * test/runtime-files-gitignored.test.js
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
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
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
