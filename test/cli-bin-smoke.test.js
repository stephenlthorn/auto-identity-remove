/**
 * test/cli-bin-smoke.test.js
 *
 * Hermetic smoke test for the bin/aidr.js dispatcher. Only exercises the
 * non-spawning paths (--help, --version, unknown command) by running the bin
 * as a child process and asserting its exit code + output. No network, no
 * real opt-out run, no dashboard boot.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'aidr.js');

function runBin(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('aidr --help exits 0 and lists subcommands', () => {
  const r = runBin(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: aidr/);
  assert.match(r.stdout, /\bsetup\b/);
  assert.match(r.stdout, /\bdashboard\b/);
});

test('aidr with no args prints help and exits 0', () => {
  const r = runBin([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: aidr/);
});

test('aidr --version prints the package version and exits 0', () => {
  const r = runBin(['--version']);
  assert.equal(r.code, 0);
  const pkg = require('../package.json');
  assert.match(r.stdout, new RegExp(pkg.version.replace(/\./g, '\\.')));
});

test('aidr unknown-command prints help and exits non-zero', () => {
  const r = runBin(['frobnicate']);
  assert.notEqual(r.code, 0);
  const combined = r.stdout + (r.stderr || '');
  assert.match(combined, /unknown command: frobnicate/);
});
