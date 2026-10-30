/**
 * test/packaging-npm-pack.test.js
 *
 * CFG-11. Two ways the published package was wrong:
 *
 *  1. `"files": ["data/"]` ships the whole directory. A maintainer's working
 *     tree holds the user's own serp-history.json, exposure-history.json(.bak)
 *     and feeds-brokers.json there, so `npm publish` (or `npm pack` for a
 *     friend) would carry that history out. Only the datasets the code reads
 *     from a clean install may be listed, by name.
 *
 *  2. `express` was declared only in dashboard/package.json. A global install
 *     (`npm i -g .`) and the Docker image install the ROOT dependencies only,
 *     so `aidr dashboard` printed its banner and then crashed with
 *     MODULE_NOT_FOUND. Express is now a root dependency, at the same range as
 *     the dashboard's own manifest.
 *
 * The pack test runs the real `npm pack --dry-run` against a temp copy seeded
 * with the files a used working tree would contain.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const dashPkg = require(path.join(ROOT, 'dashboard', 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));

/** What `npm pack` would put in the tarball for a working tree that has been used. */
function packedFilesOfUsedTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-pack-'));
  try {
    fs.cpSync(ROOT, tmp, {
      recursive: true,
      filter: src => !['node_modules', '.git'].includes(path.basename(src)),
    });
    const seed = {
      'data/serp-history.json': '[]',
      'data/exposure-history.json': '[]',
      'data/exposure-history.json.bak': '[]',
      'data/feeds-brokers.json': '[]',
      'dashboard/.auth.json': '{}',
      'config.json': '{}',
      'config.json.enc': '{}',
      'state.json': '{}',
      'state.json.bak': '{}',
      // Temp files of the atomic writers, left by a write that was killed (CFG2-12).
      'dashboard/.auth.json.tmp-abcd1234': '{}',
      'config.json.tmp-ab12cd34': '{}',
      'data/serp-history.json.4242.ab12cd34.tmp': '[]',
    };
    for (const [rel, body] of Object.entries(seed)) fs.writeFileSync(path.join(tmp, rel), body);
    fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'logs', 'run-x.json'), '{}');

    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out)[0].files.map(f => f.path);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let cached;
const packed = () => (cached = cached || packedFilesOfUsedTree());

test('npm pack leaves out the user\'s own history and runtime files', () => {
  const leaked = [
    'data/serp-history.json',
    'data/exposure-history.json',
    'data/exposure-history.json.bak',
    'data/feeds-brokers.json',
    'dashboard/.auth.json',
    'config.json',
    'config.json.enc',
    'state.json',
    'state.json.bak',
    'logs/run-x.json',
    'dashboard/.auth.json.tmp-abcd1234',
    'config.json.tmp-ab12cd34',
    'data/serp-history.json.4242.ab12cd34.tmp',
  ].filter(f => packed().includes(f));
  assert.deepEqual(leaked, [], `these would ship in the tarball: ${leaked.join(', ')}`);
});

test('npm pack still ships the datasets the generic runner reads on a clean install', () => {
  for (const f of ['data/markup-parsed.json', 'data/badbool-extra.json', 'data/dead-urls.json']) {
    assert.ok(packed().includes(f), `${f} must be in the package or the generic runner loses its broker list`);
  }
});

test('npm pack still ships the code and the dashboard', () => {
  for (const f of ['bin/aidr.js', 'lib/config.js', 'watcher.js', 'dashboard/server.js', 'dashboard/public/app.js']) {
    assert.ok(packed().includes(f), `${f} missing from the package`);
  }
});

test('package.json "files" never lists the whole data/ directory', () => {
  const wholeDir = (pkg.files || []).filter(f => /^data\/?$/.test(f));
  assert.deepEqual(wholeDir, [], 'list data files by name; data/ also holds per-user history files');
});

test('express is a root dependency at the same range the dashboard declares', () => {
  assert.ok(dashPkg.dependencies.express, 'precondition: the dashboard depends on express');
  assert.equal(
    pkg.dependencies.express,
    dashPkg.dependencies.express,
    'a global install and the Docker image install root dependencies only; without express here `aidr dashboard` is MODULE_NOT_FOUND',
  );
});

test('package-lock.json is in sync with package.json dependencies, so `npm ci` in the image succeeds', () => {
  const rootEntry = lock.packages[''];
  assert.deepEqual(rootEntry.dependencies, pkg.dependencies);
  assert.deepEqual(rootEntry.optionalDependencies, pkg.optionalDependencies);
  assert.ok(lock.packages['node_modules/express'], 'the lockfile must resolve express');
});
