/**
 * test/watcher-encrypt-cli.test.js
 *
 * End-to-end test of the --encrypt-config / --decrypt-config migration CLI.
 * Hermetic: runs in a temp copy of the repo's lib/ + watcher.js with a temp
 * config.json; never touches the repo's real config.json. AIDR_PASSPHRASE is
 * passed via the child env.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const PASS = 'cli-test-passphrase';
const PLAIN = { person: { firstName: 'Alan', lastName: 'Turing' }, capsolver: { apiKey: 'CAP-1' } };

// Build a minimal temp "repo" so the run is hermetic. watcher.js + lib/ resolve
// their paths from __dirname, so copying them into a temp dir (with a temp
// config.json) means the real repo's config.json/state.json are never touched.
// node_modules is symlinked so Playwright etc. resolve if any require touches them.
function buildTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-watcher-'));
  fs.copyFileSync(path.join(REPO, 'watcher.js'), path.join(dir, 'watcher.js'));
  // Copy the whole lib/ directory (watcher's requires resolve relative to dir).
  fs.cpSync(path.join(REPO, 'lib'), path.join(dir, 'lib'), { recursive: true });
  // brokers.js is required by some modes but NOT by --encrypt-config; copy it
  // anyway so any require at load time resolves.
  fs.copyFileSync(path.join(REPO, 'brokers.js'), path.join(dir, 'brokers.js'));
  // node_modules: symlink to the real one so playwright etc. resolve if touched.
  // The worktree may not have its own node_modules; walk up to find the real one.
  const realNodeModules = (() => {
    let d = REPO;
    for (let i = 0; i < 5; i++) {
      const nm = path.join(d, 'node_modules');
      if (fs.existsSync(nm)) return nm;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return null;
  })();
  if (realNodeModules) {
    try {
      fs.symlinkSync(realNodeModules, path.join(dir, 'node_modules'), 'dir');
    } catch (_) { /* best effort; --encrypt-config exits before playwright */ }
  }
  return dir;
}

function runWatcher(dir, args, env) {
  // timeout + HEADLESS guard: in the RED state the flags do not exist yet, so
  // watcher would fall through to main() and try to launch a real browser. The
  // timeout bounds that so the test suite can never hang; HEADLESS=1 keeps any
  // accidental launch off-screen.
  return execFileSync('node', ['watcher.js', ...args], {
    cwd: dir,
    env: { ...process.env, AIDR_PASSPHRASE: PASS, HEADLESS: '1', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('--encrypt-config writes config.json.enc and shreds plaintext by default', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));

  runWatcher(dir, ['--encrypt-config']);

  const encPath = path.join(dir, 'config.json.enc');
  assert.ok(fs.existsSync(encPath), 'config.json.enc should be written');
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'plaintext should be shredded');

  const secrets = require('../lib/secrets');
  const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.deepEqual(secrets.decryptConfig(env, PASS), PLAIN);
});

test('--encrypt-config --keep-plaintext keeps config.json', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));

  runWatcher(dir, ['--encrypt-config', '--keep-plaintext']);

  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'plaintext should be kept');
  assert.ok(fs.existsSync(path.join(dir, 'config.json.enc')), 'envelope should be written');
});

test('--decrypt-config restores plaintext config.json and removes the envelope', () => {
  const dir = buildTempRepo();
  const secrets = require('../lib/secrets');
  fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));

  runWatcher(dir, ['--decrypt-config']);

  const cfgPath = path.join(dir, 'config.json');
  assert.ok(fs.existsSync(cfgPath), 'config.json should be restored');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), PLAIN);
  assert.equal(fs.existsSync(path.join(dir, 'config.json.enc')), false, 'envelope should be removed');
});

test('--encrypt-config without a passphrase exits non-zero', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));
  assert.throws(
    () => execFileSync('node', ['watcher.js', '--encrypt-config'], {
      cwd: dir,
      env: { ...process.env, AIDR_PASSPHRASE: '', HEADLESS: '1' },
      encoding: 'utf8',
      timeout: 30000,
    }),
    /Command failed/
  );
});
