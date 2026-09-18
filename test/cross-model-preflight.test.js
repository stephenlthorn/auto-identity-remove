/**
 * test/cross-model-preflight.test.js
 *
 * The cross-model review policy depends on a binary on the maintainer's
 * machine, and on 2026-09-18 that binary had been broken for an unknown length
 * of time: codex 0.137.0 died decoding the server's model list ("unknown
 * variant 'max'") before it could review anything. The policy was silently off,
 * and nothing surfaced it - the CI gate checks for a commit trailer, not
 * whether the reviewer runs.
 *
 * The old preflight asked two questions, and a broken-but-present codex
 * answered both correctly:
 *
 *   is it installed?      yes
 *   is it authenticated?  yes
 *   can it do the job?    never asked
 *
 * So the probe now makes a real round trip and requires a sentinel back. These
 * tests drive it with a stub `codex` on PATH, one per failure mode, because the
 * interesting cases are the ones where codex is present and still useless.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'cross-model-preflight.sh');

/**
 * Run the probe with a throwaway PATH containing only `body` as `codex`
 * (plus the real system paths, so the script's own tools still resolve).
 * @param {string|null} body shell source for the stub, or null for no codex
 */
function runProbe(body, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-probe-'));
  try {
    if (body !== null) {
      const stub = path.join(dir, 'codex');
      fs.writeFileSync(stub, body, { mode: 0o755 });
    }
    // A PATH that excludes the real codex: the stub dir plus the standard
    // system bins. If a real codex lives in /usr/local/bin this would still
    // find it, so the stub dir goes first and the stubs are total.
    const r = spawnSync('bash', [PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, ...extraEnv },
      timeout: 60000,
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// codex exec echoes the prompt into its own output (verified: a token asked for
// in the prompt comes back three times on a successful run). So the probe must
// not look for something the prompt already contains, and the stub answers the
// challenge rather than parroting it.
const WORKING = `#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  for a in "$@"; do echo "$a"; done; echo "PROBEOK-4"; exit 0 ;;
esac
exit 1
`;

test('the probe script exists and is runnable', () => {
  assert.ok(fs.existsSync(PROBE), 'scripts/cross-model-preflight.sh should exist');
});

test('a fully working codex passes', () => {
  const r = runProbe(WORKING);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok/i);
});

test('a missing codex exits 3', () => {
  const r = runProbe(null);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /not found|install/i);
});

test('an unauthenticated codex exits 4', () => {
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Not logged in"; exit 1 ;;
  "exec")  echo "CODEX_PROBE_OK"; exit 0 ;;
esac
exit 1
`);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /codex login/i);
});

test('an installed, authenticated codex that cannot complete a request exits 7', () => {
  // This is the 0.137.0 case exactly: present, logged in, and fatally broken
  // on the way to doing any work.
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  echo "ERROR codex_models_manager: unknown variant \\\`max\\\`" >&2; exit 1 ;;
esac
exit 1
`);
  assert.equal(r.code, 7, r.out);
  assert.match(r.out, /round trip|cannot complete|unusable/i);
});

test('a codex that exits 0 but returns nothing useful also exits 7', () => {
  // Silence is the dangerous case: exit 0 with no sentinel must not read as ok.
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  exit 0 ;;
esac
exit 1
`);
  assert.equal(r.code, 7, r.out);
});

test('a codex that hangs is killed and reported, not waited on forever', () => {
  // Two seconds rather than the 45s default: this asserts the bound is
  // enforced, not how long it is.
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  sleep 300 ;;
esac
exit 1
`, { CROSS_MODEL_PROBE_TIMEOUT: '2' });
  assert.equal(r.code, 7, r.out);
  assert.match(r.out, /timed out|timeout/i);
});

/**
 * The review script has to propagate the probe's verdict. The first version of
 * that wiring was `if ! bash preflight; then exit $?; fi`, where `$?` inside the
 * then-block is the status of the *negation* - always 0. So a dead reviewer made
 * the review exit 0, which in a git hook reads as "review passed". The guard
 * against a silently-clean review was itself silently clean. Caught by the
 * cross-model review of 1994125.
 */
test('the review script exits with the probe status, not 0, when the reviewer is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-review-'));
  try {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'cross-model-review.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      // No codex anywhere on PATH: the probe must fail with 3 and the review
      // script must surface that exact code.
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin` },
      timeout: 60000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, `a dead reviewer must never exit 0:\n${out}`);
    assert.equal(r.status, 3, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a codex that only echoes the prompt back does not count as alive', () => {
  // The failure this guards: `codex exec` prints the prompt before running, so
  // a probe that greps its own sentinel passes whenever codex got far enough to
  // print anything at all - including the 0.137.0 case it was written for. The
  // challenge answer must not appear in the challenge.
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  for a in "$@"; do echo "$a"; done; echo "ERROR: model list decode failed" >&2; exit 1 ;;
esac
exit 1
`);
  assert.equal(r.code, 7, r.out);
});

test('a codex that answers correctly but exits non-zero does not count as alive', () => {
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  echo "PROBEOK-4"; exit 1 ;;
esac
exit 1
`);
  assert.equal(r.code, 7, r.out);
});

test('"Not logged in" is not read as logged in', () => {
  // `grep -qi "logged in"` matches "Not logged in", so the auth check only ever
  // worked because the real CLI also exits non-zero when logged out. A stub
  // that reports logged-out on a zero exit walked straight past it.
  const r = runProbe(`#!/bin/sh
case "$1" in
  "login") echo "Not logged in"; exit 0 ;;
  "exec")  for a in "$@"; do echo "$a"; done; echo "PROBEOK-4"; exit 0 ;;
esac
exit 1
`);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /codex login/i);
});

test('a reviewer that exits non-zero is a failed review even if it wrote output', () => {
  // The renderer only checked whether the findings file was non-empty, so a
  // codex that died part-way through writing one still produced a report and a
  // clean exit. A truncated review must never read as a passing review.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-partial-'));
  try {
    fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "--version") echo "codex-cli stub"; exit 0 ;;
  "exec")
    # Answer the preflight challenge; for the real review, write a partial
    # findings file and then die, which is the case under test.
    out=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-o" ]; then out="$a"; fi
      prev="$a"
    done
    if [ -z "$out" ]; then echo "PROBEOK-4"; exit 0; fi
    echo '{"findings":[' > "$out"
    echo "stream ended unexpectedly" >&2
    exit 1 ;;
esac
exit 1
`, { mode: 0o755 });
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'cross-model-review.sh'), '--base', 'HEAD~1'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin` },
      timeout: 120000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, `a reviewer that died must not exit 0:\n${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
