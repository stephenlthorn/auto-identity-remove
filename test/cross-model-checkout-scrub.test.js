/**
 * test/cross-model-checkout-scrub.test.js
 *
 * scripts/cross-model-review.sh builds the directory it hands to an external
 * model from "tracked files plus untracked-but-not-ignored files", and called
 * that scrubbed by construction because config.json, state.json and inbox/ are
 * gitignored. That reasoning only covers paths someone thought to ignore. An
 * untracked scratch file - notes.txt, a CSV of addresses, a draft complaint -
 * is neither tracked nor ignored, so it was copied and uploaded.
 *
 * On a tool whose entire purpose is keeping the maintainer's name and address
 * off other people's servers, that is the wrong default. Found by the
 * cross-model review of 1994125.
 *
 * Untracked files are still reviewed when they are review targets, because
 * reviewing brand-new code before it is committed is the point. Untracked files
 * that are not review targets never leave the machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'cross-model-review.sh'), 'utf8');

test('the checkout builder filters untracked files rather than copying them wholesale', () => {
  // The old builder piped `git ls-files --others` straight into the copy loop.
  // Anything that still does that ships the hole.
  const buildsFromRawOthers = /ls-files -z --others --exclude-standard\s*\n\s*\}\s*\|\s*sort -zu\s*\|\s*while/.test(SCRIPT);
  assert.equal(
    buildsFromRawOthers,
    false,
    'untracked files are copied into the review checkout without being filtered'
  );
});

test('the review script names a reviewable-target filter it can apply to untracked files', () => {
  assert.match(
    SCRIPT,
    /is_reviewable\(\)/,
    'expected a single predicate deciding what may be uploaded'
  );
});

test('the reviewable predicate accepts code and rejects scratch files', () => {
  const { execFileSync } = require('node:child_process');
  // Source the script's predicate in isolation: everything up to the marker is
  // definitions only, so this cannot start a review.
  const probe = `
    set -uo pipefail
    ${SCRIPT.split('# ---- end predicates ----')[0]}
    for f in lib/config.js package.json scripts/x.sh Dockerfile docker-compose.yml \
             notes.txt addresses.csv resume.pdf secret.env .env.local; do
      if is_reviewable "$f"; then echo "YES $f"; else echo "NO $f"; fi
    done
  `;
  const out = execFileSync('bash', ['-c', probe], { cwd: ROOT, encoding: 'utf8' });

  for (const f of ['lib/config.js', 'package.json', 'scripts/x.sh', 'Dockerfile', 'docker-compose.yml']) {
    assert.match(out, new RegExp(`YES ${f.replace(/[.]/g, '\\.')}`), `${f} should be reviewable`);
  }
  for (const f of ['notes.txt', 'addresses.csv', 'resume.pdf', 'secret.env', '.env.local']) {
    assert.match(out, new RegExp(`NO ${f.replace(/[.]/g, '\\.')}`), `${f} must never be uploaded`);
  }
});

test('untracked JSON is not uploaded unless it is a manifest', () => {
  const { execFileSync } = require('node:child_process');
  // is_reviewable accepts *.json because package.json and the schema are worth
  // reviewing. For an UNTRACKED file that is too loose: a config.backup.json or
  // an addresses.json is exactly the PII this repo exists to keep off other
  // people's servers, and "not gitignored" does not make it safe to upload.
  const probe = `
    set -uo pipefail
    ${SCRIPT.split('# ---- end predicates ----')[0]}
    for f in package.json package-lock.json lib/config.js scripts/x.sh \
             config.backup.json addresses.json state.json.old data/people.json; do
      if may_upload_untracked "$f"; then echo "YES $f"; else echo "NO $f"; fi
    done
  `;
  const out = execFileSync('bash', ['-c', probe], { cwd: ROOT, encoding: 'utf8' });

  for (const f of ['package.json', 'package-lock.json', 'lib/config.js', 'scripts/x.sh']) {
    assert.match(out, new RegExp(`YES ${f.replace(/[.]/g, '\\.')}`), `${f} should be uploadable`);
  }
  for (const f of ['config.backup.json', 'addresses.json', 'state.json.old', 'data/people.json']) {
    assert.match(out, new RegExp(`NO ${f.replace(/[.]/g, '\\.')}`), `${f} must never be uploaded`);
  }
});
