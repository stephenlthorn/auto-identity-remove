/**
 * test/image-compose.test.js
 *
 * docker-compose.yml runs the prebuilt image from
 * ghcr.io/stephenlthorn/auto-identity-remove by default, and building from source
 * is a separate, explicit file (docker-compose.build.yml). The reason for two
 * files and not one `image:` + `build:` service is pinned below.
 *
 * Static checks on the text, plus `docker compose config` for real when Docker is
 * installed (the `docker` job in test.yml has it). test/docker-build-contract.test.js
 * keeps guarding the run settings (mounts, init, shm_size, uid).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = rel => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '');

const IMAGE = 'ghcr.io/stephenlthorn/auto-identity-remove';

const compose = read('docker-compose.yml');
const composeBuild = read('docker-compose.build.yml');


test('docker-compose.yml runs the prebuilt image, and AIDR_VERSION pins a release', () => {
  assert.match(compose, new RegExp(`^ {4}image: ${IMAGE.replace(/[./]/g, '\\$&')}:\\$\\{AIDR_VERSION:-latest\\}$`, 'm'));
});

test('docker-compose.yml has no build: of its own, so a pull that fails is an error and not a surprise build on the NAS', () => {
  // Verified with Compose v2.34: with both `image:` and `build:` a failed pull is
  // only a warning, and compose then builds the image from source. That is the
  // 940 MB build on a Celeron this change exists to remove, started silently from
  // a scheduled task. Building is a separate, explicit file.
  assert.doesNotMatch(compose, /^\s+build:/m);
});

test('docker-compose.build.yml adds the build to the same service, and nothing else', () => {
  assert.ok(composeBuild.length > 0, 'docker-compose.build.yml exists');
  assert.match(composeBuild, /^services:\n {2}watcher:\n {4}build: \.\n/m);
  assert.doesNotMatch(composeBuild, /^\s+(image|volumes|user|environment|init|shm_size):/m, 'run settings live in docker-compose.yml only, so the two cannot drift');
});

test('the compose header documents pull by default and how to build from source', () => {
  const header = compose.split(/^services:/m)[0];

  assert.match(header, /pull/i);
  assert.match(header, /AIDR_VERSION/);
  assert.match(header, /docker compose pull/);
  assert.match(header, /-f docker-compose\.yml -f docker-compose\.build\.yml build/);
  assert.match(header, /docker-compose\.build\.yml/);
  assert.match(header, /Synology|docs\/SYNOLOGY\.md/);
});

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const skipCompose = dockerCompose.status === 0 ? false : 'docker compose is not installed here; the docker job in test.yml runs this';

function composeConfig(files, env = {}) {
  const args = ['compose', ...files.flatMap(f => ['-f', f]), 'config'];
  return spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

test('docker compose config accepts docker-compose.yml, pulls the latest image and has nothing to build', { skip: skipCompose }, () => {
  const r = composeConfig(['docker-compose.yml']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`image: ${IMAGE.replace(/[./]/g, '\\$&')}:latest`));
  assert.doesNotMatch(r.stdout, /^\s+build:/m);
});

test('docker compose config pins the image to AIDR_VERSION when it is set', { skip: skipCompose }, () => {
  const r = composeConfig(['docker-compose.yml'], { AIDR_VERSION: '2.0.1' });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`image: ${IMAGE.replace(/[./]/g, '\\$&')}:2\\.0\\.1`));
});

test('docker compose config with the build file adds a build from this directory and keeps every run setting', { skip: skipCompose }, () => {
  const plain = composeConfig(['docker-compose.yml']);
  const built = composeConfig(['docker-compose.yml', 'docker-compose.build.yml']);

  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^\s+build:\n\s+context: .+\n\s+dockerfile: Dockerfile$/m);
  for (const needle of ['init: true', 'shm_size:', 'AIDR_HOME: /home/aidr', '/home/aidr']) {
    assert.ok(built.stdout.includes(needle), `the merged config still has ${needle}`);
    assert.ok(plain.stdout.includes(needle), `and so does the default one`);
  }
});
