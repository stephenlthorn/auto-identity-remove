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

const WORKING = `#!/bin/sh
case "$1" in
  "login") echo "Logged in using ChatGPT"; exit 0 ;;
  "exec")  echo "CODEX_PROBE_OK"; exit 0 ;;
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
