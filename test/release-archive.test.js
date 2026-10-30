/**
 * test/release-archive.test.js
 *
 * scripts/release-archive.sh builds the file attached to a GitHub Release. GitHub
 * only counts downloads of attached files (`assets[].download_count`), never
 * `git clone` and never the auto-generated "Source code" archives, so this
 * tarball is how the maintainer learns whether anyone installs the tool.
 *
 * What a user gets from it has to work on its own. The README tells them to
 * unpack it and run `bash install.sh`, which runs `npm ci` (so package-lock.json
 * has to be inside) and `cd dashboard && npm ci`. Anything missing here is a
 * broken first install, and the first anyone hears of it is an issue.
 *
 * What it must not carry is just as important. The archive is built from the
 * committed HEAD with `git archive`, so a maintainer's config.json and
 * state.json (PII) cannot get in even when they sit in the working tree. The
 * temp-repo test below proves that with files that really are there.
 *
 * The script archives HEAD of the repo it lives in, so the first group checks the
 * committed state of this checkout; run it after committing.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-archive.sh');
const TARBALL = 'auto-identity-remove.tar.gz';
const CHECKSUM = `${TARBALL}.sha256`;
const PREFIX = 'auto-identity-remove/';

const skip = process.platform === 'win32' ? 'bash, tar and git archive are exercised on POSIX CI' : false;

const pkg = require(path.join(ROOT, 'package.json'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function mktmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aidr-${label}-`));
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

function git(cwd, args) {
  const r = run('git', args, { cwd });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** Every entry in the tarball, with the leading `auto-identity-remove/` kept. */
function listEntries(tarball) {
  const r = run('tar', ['tzf', tarball]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

/** Build into a fresh temp dir with the real script from the real checkout. */
function buildArchive() {
  const out = mktmp('release-out');
  const r = run('bash', [SCRIPT, out], { cwd: ROOT });
  assert.equal(r.status, 0, `release-archive.sh failed:\n${r.stdout}\n${r.stderr}`);
  return { out, tarball: path.join(out, TARBALL), entries: listEntries(path.join(out, TARBALL)) };
}

/** Local files the README links to: they have to ship, or the doc has dead links. */
function localReadmeLinks() {
  const targets = [...readme.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map(m => m[1]);
  return [...new Set(targets)]
    .filter(t => !/^[a-z][a-z0-9+.-]*:/i.test(t))
    .filter(t => fs.existsSync(path.join(ROOT, t)));
}

test('the script prints its usage and exits 64 when no output directory is given', { skip }, () => {
  const r = run('bash', [SCRIPT], { cwd: ROOT });

  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: .*release-archive\.sh <out-dir>/);
});

test('it writes the two fixed-name assets, and nothing else, creating the directory if needed', { skip }, () => {
  const parent = mktmp('release-nested');
  try {
    const out = path.join(parent, 'does', 'not', 'exist');
    const r = run('bash', [SCRIPT, out], { cwd: ROOT });

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), [TARBALL, CHECKSUM].sort());
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('every entry sits under auto-identity-remove/, so unpacking never scatters files', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const strays = entries.filter(e => !e.startsWith(PREFIX));

    assert.ok(entries.length > 50, `expected a populated archive, got ${entries.length} entries`);
    assert.deepEqual(strays, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the archive holds everything needed to install and run', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const have = new Set(entries.map(e => e.slice(PREFIX.length)));
    const required = [
      'install.sh', 'package.json', 'package-lock.json',
      'bin/aidr.js', 'lib/config.js', 'lib/paths.js',
      'dashboard/package.json', 'dashboard/package-lock.json', 'dashboard/server.js', 'dashboard/public/index.html',
      'watcher.js', 'setup.js', 'brokers.js', 'generic-runner.js', 'run.sh', 'config.example.json',
      'data/markup-parsed.json', 'data/badbool-extra.json', 'data/dead-urls.json',
      'Dockerfile', 'docker-compose.yml', 'LICENSE', 'README.md',
      // A Docker build from the unpacked folder reads .dockerignore; without it
      // `COPY . .` would bake whatever sits in the folder into an image layer.
      '.dockerignore',
    ];

    const missing = required.filter(f => !have.has(f));

    assert.deepEqual(missing, [], `missing from the archive: ${missing.join(', ')}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('everything package.json ships is in the archive', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const have = entries.map(e => e.slice(PREFIX.length));
    const missing = pkg.files.filter(f => (f.endsWith('/') ? !have.some(h => h.startsWith(f)) : !have.includes(f)));

    assert.deepEqual(missing, [], `package.json "files" entries missing from the archive: ${missing.join(', ')}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('every file the README links to is in the archive', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const have = new Set(entries.map(e => e.slice(PREFIX.length)));
    const linked = localReadmeLinks();

    // Guard against passing vacuously if the link scan stops matching.
    for (const doc of ['docs/PRIVACY.md', 'docs/SYNOLOGY.md', 'docs/relay.md', 'docs/CROSS_MODEL_REVIEW.md', 'SECURITY.md', 'LICENSE']) {
      assert.ok(linked.includes(doc), `precondition: the README links to ${doc}`);
    }
    const missing = linked.filter(f => !have.has(f));

    assert.deepEqual(missing, [], `linked from the README but not in the archive: ${missing.join(', ')}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the archive is lean: no test/ and no .github/ at any depth', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const leaked = entries.filter(e => e.split('/').some(seg => seg === 'test' || seg === '.github'));

    assert.deepEqual(leaked, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the archive carries no config, state, secrets, logs or installed modules', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const forbiddenNames = new Set([
      'config.json', 'config.json.enc', 'state.json', 'state.json.bak', 'state.json.checkpoint',
      'last-run.json', 'confirm-processed.json', '.env', '.claude',
    ]);
    const forbiddenDirs = new Set(['node_modules', 'logs', 'inbox', 'aidr-home']);
    const leaked = entries.filter(e => {
      const segments = e.split('/').filter(Boolean);
      return segments.some(seg => forbiddenDirs.has(seg))
        || forbiddenNames.has(segments[segments.length - 1])
        || /\.(log|pem|passphrase|tmp)$/.test(e);
    });

    assert.deepEqual(leaked, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('nothing in the archive is a path the repo ignore file excludes', { skip }, () => {
  const { out, entries } = buildArchive();
  try {
    const paths = entries.map(e => e.slice(PREFIX.length)).filter(Boolean);
    const r = run('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: ROOT, input: paths.join('\0') });

    assert.equal(r.status, 1, `git ignores these archived paths: ${r.stdout.split('\0').join(', ')}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the .sha256 file is in sha256sum format and matches the tarball', { skip }, () => {
  const { out, tarball } = buildArchive();
  try {
    const line = fs.readFileSync(path.join(out, CHECKSUM), 'utf8');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

    assert.equal(line, `${actual}  ${TARBALL}\n`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the real checksum tools accept the .sha256 file as downloaded, next to the tarball', { skip }, () => {
  const { out } = buildArchive();
  try {
    const tool = run('sha256sum', ['--version']).error ? ['shasum', '-a', '256'] : ['sha256sum'];
    const r = run(tool[0], [...tool.slice(1), '-c', CHECKSUM], { cwd: out });

    assert.equal(r.status, 0, `${tool.join(' ')} -c failed: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`${TARBALL.replace(/\./g, '\\.')}: OK`));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('it archives the committed HEAD, so untracked and ignored files in the working tree stay out', { skip }, () => {
  const repo = mktmp('release-repo');
  const out = mktmp('release-repo-out');
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'release@example.com']);
    git(repo, ['config', 'user.name', 'Release Test']);
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'release-archive.sh'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo, '.gitattributes'));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'config.json\nstate.json\nnode_modules/\n');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    fs.mkdirSync(path.join(repo, 'test'));
    fs.writeFileSync(path.join(repo, 'test', 'a.test.js'), '// a test\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'release candidate']);

    // What a used working tree contains: PII that must never leave the machine.
    fs.writeFileSync(path.join(repo, 'config.json'), '{"person":{"fullName":"Pat Example"}}\n');
    fs.writeFileSync(path.join(repo, 'state.json'), '{"optOuts":{}}\n');
    fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), '');
    fs.writeFileSync(path.join(repo, 'notes-not-committed.txt'), 'scratch\n');

    const r = run('bash', [path.join(repo, 'scripts', 'release-archive.sh'), out], { cwd: repo });
    assert.equal(r.status, 0, r.stderr);

    const entries = listEntries(path.join(out, TARBALL)).map(e => e.slice(PREFIX.length)).filter(Boolean);
    assert.deepEqual(entries.sort(), ['.gitattributes', '.gitignore', 'package.json', 'scripts/', 'scripts/release-archive.sh']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
