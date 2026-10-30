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
const { resolvePaths } = require('../lib/paths');

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
  // The --confirm-emails ledger of already-clicked messages lives beside state.json.
  path.join(path.dirname(STATE_PATH), 'confirm-processed.json'),
  // The dashboard backs the config up next to itself on every save.
  CONFIG_PATH + '.bak',
  CONFIG_ENC_PATH + '.bak',
  // R4: the run heartbeat sits beside state.json (counts only, but it is a record of
  // when this tool ran for a particular person, so it does not ship either).
  path.join(path.dirname(STATE_PATH), 'last-run.json'),
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
  // config.json, not node_modules: a worktree symlinks node_modules, and git
  // refuses to check a path "beyond a symbolic link", which made this probe
  // throw on a perfectly healthy checkout.
  assert.equal(isIgnored(path.join(ROOT, 'config.json')), true);
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

// ── Temp, quarantine and secret files (CFG-15a) ──────────────────────────────
//
// The atomic writers leave config.json.tmp, config.json.enc.tmp and
// state.json.bak.tmp behind when killed mid-write; a corrupt state.json is
// quarantined as state.json.corrupt-<ts>; the dashboard keeps its generated
// credentials in dashboard/.auth.json; and the documented unattended-run recipe
// puts the encrypted config's passphrase in aidr-home/aidr.passphrase. Every one
// of them is PII or a secret, and the Docker recipe's aidr-home/ directory holds
// the whole lot.

const EXTRA_RUNTIME_PATHS = [
  'config.json.tmp',
  'config.json.enc.tmp',
  'state.json.bak.tmp',
  'state.json.corrupt-2026-10-29T09-00-00-000Z',
  'state.json.bak.corrupt-2026-10-29T09-00-00-000Z',
  'confirm-processed.json.12345.tmp',
  'last-run.json.12345.tmp',
  'config.json.unreadable-2026-10-29T09-00-00-000Z.bak',
  'config.json.enc.unreadable-2026-10-29T09-00-00-000Z.bak',
  'data/breach-result.json',
  'data/breach-result.json.tmp',
  'dashboard/.auth.json',
  // CFG2-12: the dashboard's temp files carry a random suffix (safe-write.js) and
  // private-fs.js names its temps <target>.<pid>.<hex>.tmp. A write killed midway
  // leaves one behind with a full copy of what it was writing; npm pack shipped
  // dashboard/.auth.json.tmp-abcd1234.
  'config.json.tmp-ab12cd34',
  'config.json.enc.tmp-ab12cd34',
  'config.json.bak.tmp-ab12cd34',
  'state.json.tmp-ab12cd34',
  'dashboard/.auth.json.tmp-abcd1234',
  'data/serp-history.json.4242.ab12cd34.tmp',
  'data/exposure-history.json.4242.ab12cd34.tmp',
  'logs/run-2026-10-29T09-00-00.json.4242.ab12cd34.tmp',
  'aidr.passphrase',
  'aidr-home/config.json',
  'aidr-home/state.json',
  'aidr-home/aidr.passphrase',
  'aidr-home/logs/run-2026-10-29T09-00-00.json',
].map(rel => path.join(ROOT, rel));

test('every temp, quarantine and secret file is git-ignored', () => {
  const leaks = EXTRA_RUNTIME_PATHS.filter(p => !isIgnored(p)).map(p => path.relative(ROOT, p));
  assert.deepEqual(leaks, [], `these are committable: ${leaks.join(', ')}`);
});

/**
 * Minimal .dockerignore matcher for the shapes this repo uses: literal paths,
 * a directory name (matches everything under it), and `*` / `**` globs.
 * Docker's own matcher is not reimplemented in full; this covers what the
 * entries below need.
 */
function dockerignoreCovers(rel, patterns) {
  return patterns.some(raw => {
    const pat = raw.replace(/\/$/, '');
    const re = new RegExp(
      '^' + pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0001')
        .replace(/\*\*/g, '\u0002')
        .replace(/\*/g, '\u0003')
        .replace(/\u0001/g, '(?:.*/)?')
        .replace(/\u0002/g, '.*')
        .replace(/\u0003/g, '[^/]*') + '(?:/.*)?$',
    );
    return re.test(rel);
  });
}

test('the dockerignore matcher is not failing open', () => {
  assert.equal(dockerignoreCovers('config.json', ['config.json']), true);
  assert.equal(dockerignoreCovers('aidr-home/x/y', ['aidr-home/']), true);
  assert.equal(dockerignoreCovers('a/b/k.passphrase', ['**/*.passphrase']), true);
  assert.equal(dockerignoreCovers('k.passphrase', ['**/*.passphrase']), true);
  assert.equal(dockerignoreCovers('lib/config.js', ['config.json']), false);
  assert.equal(dockerignoreCovers('state.json.bak.tmp', ['state.json.bak']), false);
});

test('every temp, quarantine and secret file is also kept out of the image', () => {
  const patterns = dockerignorePatterns();
  const leaks = EXTRA_RUNTIME_PATHS
    .map(p => path.relative(ROOT, p))
    .filter(rel => !dockerignoreCovers(rel, patterns));
  assert.deepEqual(leaks, [], 'COPY . . will bake these into the image; add them to .dockerignore: ' + leaks.join(', '));
});

// ── One home directory (R0) ──────────────────────────────────────────────────
//
// AIDR_HOME moves config, state, logs, snapshots, reports, complaints, the
// history caches and the confirmation inbox into one directory. Two things must
// stay true wherever that directory is:
//   1. At the default location (the app directory), every one of those paths is
//      git-ignored, and, when it holds PII, docker-ignored.
//   2. When AIDR_HOME is the recommended in-repo `aidr-home/`, EVERY path
//      resolvePaths() can produce is covered by the two ignore files. The list
//      is derived from resolvePaths(), so a new runtime path cannot be added
//      there without either being covered or failing here.

/** A file inside each directory resolvePaths() names, or the file itself. */
function sampleFiles(paths) {
  const files = [paths.config, paths.configEnc, paths.state, paths.state + '.lock', paths.state + '.checkpoint',
    path.join(path.dirname(paths.state), 'confirm-processed.json')];
  // data/ is deliberately not a whole-directory sample: at the default location
  // it also holds the datasets that SHIP with the app, so only the named history
  // and cache files inside it are ignored.
  const dirs = [paths.logs, paths.snapshots, paths.reports, paths.complaints, paths.inbox];
  for (const dir of dirs) files.push(path.join(dir, 'sample-file'));
  for (const name of ['serp-history.json', 'exposure-history.json', 'breach-result.json', 'feeds-brokers.json']) {
    files.push(path.join(paths.data, name));
  }
  files.push(path.join(paths.inbox, 'confirms', 'message.eml'));
  files.push(path.join(paths.logs, 'run-2026-10-29T09-00-00.json'));
  files.push(path.join(paths.snapshots, 'Spokeo-2026-10-29T09-00-00-000Z.png'));
  files.push(path.join(paths.reports, 'report-2026-10-29.pdf'));
  return files;
}

test('every path resolvePaths() produces at the default location is git-ignored', () => {
  const leaks = sampleFiles(resolvePaths({}, ROOT)).filter(p => !isIgnored(p)).map(p => path.relative(ROOT, p));
  assert.deepEqual(leaks, [], `these runtime files are committable: ${leaks.join(', ')}`);
});

test('the PII-bearing paths at the default location are kept out of the image', () => {
  const p = resolvePaths({}, ROOT);
  const patterns = dockerignorePatterns();
  const pii = [
    path.join(p.logs, 'run-2026-10-29T09-00-00.json'),
    path.join(p.snapshots, 'Spokeo-2026-10-29T09-00-00-000Z.png'),
    path.join(p.reports, 'report-2026-10-29.pdf'),
    path.join(p.complaints, 'complaint.txt'),
    path.join(p.inbox, 'confirms', 'message.eml'),
    path.join(p.data, 'serp-history.json'),
    path.join(p.data, 'exposure-history.json'),
    path.join(p.data, 'breach-result.json'),
  ].map(f => path.relative(ROOT, f));
  const leaks = pii.filter(rel => !dockerignoreCovers(rel, patterns));
  assert.deepEqual(leaks, [], 'COPY . . will bake these into the image; add them to .dockerignore: ' + leaks.join(', '));
});

test('an in-repo AIDR_HOME (aidr-home/) is git-ignored for every path resolvePaths() produces', () => {
  const home = path.join(ROOT, 'aidr-home');
  const leaks = sampleFiles(resolvePaths({ AIDR_HOME: home }, ROOT)).filter(p => !isIgnored(p)).map(p => path.relative(ROOT, p));
  assert.deepEqual(leaks, [], `these would be committable under aidr-home/: ${leaks.join(', ')}`);
});

test('an in-repo AIDR_HOME (aidr-home/) is kept out of the image for every path resolvePaths() produces', () => {
  const home = path.join(ROOT, 'aidr-home');
  const patterns = dockerignorePatterns();
  const leaks = sampleFiles(resolvePaths({ AIDR_HOME: home }, ROOT))
    .map(p => path.relative(ROOT, p))
    .filter(rel => !dockerignoreCovers(rel, patterns));
  assert.deepEqual(leaks, [], 'COPY . . will bake these into the image: ' + leaks.join(', '));
});

test('the sample list really exercises the AIDR_HOME relocation', () => {
  const home = path.join(ROOT, 'aidr-home');
  const files = sampleFiles(resolvePaths({ AIDR_HOME: home }, ROOT));
  assert.ok(files.length > 15);
  assert.ok(files.every(f => f.startsWith(home + path.sep)), 'every sample must sit inside AIDR_HOME');
});
