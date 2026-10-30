/**
 * test/ghcr-image-docs.test.js
 *
 * Issue #8: the only way onto a Synology DS720+ (Celeron J4125, 2 GB) was to
 * download the source and `docker build` a 940 MB Playwright image on that CPU.
 * Every release now publishes a multi-arch image to
 * ghcr.io/stephenlthorn/auto-identity-remove (the `image` job in
 * .github/workflows/release.yml, pinned by test/image-workflow.test.js), and
 * these checks pin the text people copy so the prebuilt image stays the primary
 * path:
 *
 *  - docs/SYNOLOGY.md's setup has no source download and no `docker build`, and
 *    its DSM Task Scheduler line is a plain `docker run --rm ...` that does not
 *    need a compose file on the NAS. "Build from source" survives as a short
 *    alternative.
 *  - the README's Docker section leads with the prebuilt image and shows the
 *    build second.
 *
 * test/image-compose.test.js pins docker-compose.yml. These are static checks
 * on text, so they cannot prove a command works.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '');

const IMAGE = 'ghcr.io/stephenlthorn/auto-identity-remove';

const readme = read('README.md');
const synology = read('docs/SYNOLOGY.md');
const dockerfile = read('Dockerfile');

const section = (text, from, to) => {
  const start = text.indexOf(from);
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length);
  return start === -1 || end === -1 ? '' : text.slice(start, end);
};

const ALTERNATIVE = '## Alternative: build from source';
const setup = section(synology, '## Setup on DSM 7', ALTERNATIVE);
const alternative = section(synology, ALTERNATIVE, '## Settings that matter on a small box');
const dockerSection = section(readme, '## Running with Docker', '### Webhook notifications');

test('the sections these checks read were located', () => {
  assert.ok(setup.length > 1500, 'docs/SYNOLOGY.md needs "## Setup on DSM 7 ..." followed by "## Alternative: build from source"');
  assert.ok(alternative.length > 200, 'and the alternative section, before "## Settings that matter on a small box"');
  assert.ok(dockerSection.length > 1500, 'the README Docker section');
});

// ---------------------------------------------------------------------------
// docs/SYNOLOGY.md
// ---------------------------------------------------------------------------

test('the Synology setup needs no source download and no build', () => {
  assert.match(setup, new RegExp(IMAGE.replace(/[./]/g, '\\$&')), 'it names the published image');
  assert.doesNotMatch(setup, /docker build/, 'no `docker build` on the primary path: that is what issue #8 asked to get rid of');
  assert.doesNotMatch(setup, /docker compose|docker-compose/, 'and no compose file to get onto the NAS');
  assert.doesNotMatch(setup, /git clone|tar xzf|releases\/latest\/download|curl -L/, 'and no source to download');
});

test('the Synology setup gets the image in Container Manager or over SSH, and says to add ghcr.io to the registry list', () => {
  assert.match(setup, /Container Manager/);
  assert.match(setup, /Registry/);
  assert.match(setup, /https:\/\/ghcr\.io/, 'DSM may only list Docker Hub until https://ghcr.io is added');
  assert.match(setup, new RegExp(`docker pull ${IMAGE.replace(/[./]/g, '\\$&')}:latest`), 'and `docker pull` is the SSH route');
});

test('the Synology setup keeps the uid, the passphrase file and the one directory mount', () => {
  assert.match(setup, /aidr-home/);
  assert.match(setup, /chown -R 1001:1001/);
  assert.match(setup, /AIDR_UID/);
  assert.match(setup, /AIDR_PASSPHRASE_FILE/);
  assert.match(setup, /AIDR_HOME=\/home\/aidr/);
});

test('the Synology dry run is a plain docker run with the one mount, --init, TZ, low memory and a 1 GB cap', () => {
  const run = setup.match(/docker run --rm --init[^\n]*(?:\\\n[^\n]*)*--dry-run/);

  assert.ok(run, 'a `docker run --rm --init ... --dry-run` recipe');
  assert.match(run[0], /-e TZ=/);
  assert.match(run[0], /-e AIDR_LOW_MEMORY=1/);
  assert.match(run[0], /--memory=1g/);
  assert.match(run[0], /-v \/volume1\/[^\s:]*aidr-home:\/home\/aidr/);
  assert.match(run[0], /-e HOME=\/tmp/);
  assert.match(run[0], new RegExp(`${IMAGE.replace(/[./]/g, '\\$&')}(:\\S+)? node watcher\\.js --dry-run`));
});

test('the DSM Task Scheduler line is a plain docker run that needs no compose file', () => {
  const schedule = section(setup, '### 5. Schedule it', '### Updating');

  assert.ok(schedule.length > 200, 'precondition: found the scheduling step');
  assert.match(schedule, /Task Scheduler/);
  assert.match(schedule, /docker run --rm --init/);
  assert.match(schedule, new RegExp(IMAGE.replace(/[./]/g, '\\$&')));
  assert.match(schedule, /-v \/volume1\/[^\s:]*aidr-home:\/home\/aidr/);
  assert.doesNotMatch(schedule, /compose|docker build|\bcd \/volume1/, 'the scheduled command must not depend on a project directory or a compose file');
});

test('updating is a docker pull, or a pinned version tag', () => {
  const updating = section(setup, '### Updating');

  assert.ok(updating.length > 100, 'precondition: found an Updating subsection');
  assert.match(updating, new RegExp(`docker pull ${IMAGE.replace(/[./]/g, '\\$&')}:latest`));
  assert.match(updating, new RegExp(`${IMAGE.replace(/[./]/g, '\\$&')}:\\d+\\.\\d+\\.\\d+`), 'pinning a version tag');
});

test('building from source is still documented, as a short alternative that does the building', () => {
  assert.match(alternative, /docker build -t auto-identity-remove \./);
  assert.match(alternative, /releases\/latest\/download\/auto-identity-remove\.tar\.gz/, 'it fetches the release tarball ...');
  assert.match(alternative, /git clone/, '... with git as the alternative to that');
  assert.ok(alternative.indexOf('curl -L -O') < alternative.indexOf('git clone'), 'the release comes first');
  assert.ok(alternative.split('\n').length < 60, 'and it stays short; the primary path is the one above it');
  assert.match(alternative, /Prefer git|alternative|contributor|track(ing)? `?main/i, 'git clone says it is the alternative');
});

test('the Synology doc says plainly that the footprint numbers come from arm64 Docker Desktop', () => {
  const footprint = section(synology, '## Measured footprint', '## Setup on DSM 7');

  assert.ok(footprint.length > 500, 'precondition: the measured-footprint section is still there');
  assert.match(footprint, /Docker Desktop[^\n]*`linux\/arm64`|`linux\/arm64`[^\n]*Docker Desktop/);
  assert.match(footprint, /not measured it on the J4125|have not measured/i);
});

test('the Synology doc spells the config check as watcher.js takes it: --config-check, not a "config check" subcommand', () => {
  // `aidr config check` is the wrapper; node watcher.js only knows flags, and
  // answers "unexpected argument config" to the subcommand form.
  assert.doesNotMatch(synology, /watcher\.js config check/);
  assert.match(synology, /watcher\.js --config-check/);
});

test('the Synology doc opens by saying the NAS no longer builds the image', () => {
  const intro = synology.slice(0, synology.indexOf('## What was broken'));

  assert.match(intro, /issues\/8/);
  assert.match(intro, /prebuilt|published|pull/i);
});

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

test('the README Docker section leads with the prebuilt image and shows the build second', () => {
  const firstImage = dockerSection.indexOf(IMAGE);
  const firstBuild = dockerSection.indexOf('docker build');

  assert.ok(firstImage >= 0, `the Docker section names ${IMAGE}`);
  assert.ok(firstBuild > firstImage, 'a `docker build` recipe still exists, after the prebuilt image');
  assert.match(dockerSection.slice(0, firstBuild), /docker pull ghcr\.io\/stephenlthorn\/auto-identity-remove/);
  assert.match(dockerSection, /### Building the image yourself/);
});

test('the README run recipes use the published image, not a local build the reader has not made', () => {
  const beforeBuild = dockerSection.slice(0, dockerSection.indexOf('### Building the image yourself'));
  const runs = beforeBuild.match(/docker run --rm --init(?:[^\n]*\\\n)*[^\n]*/g) || [];

  assert.ok(runs.length >= 1, 'precondition: a docker run recipe before the build section');
  for (const run of runs) assert.ok(run.includes(IMAGE), `a recipe before the build section runs a locally built image:\n${run}`);
});

test('the README says the published image is multi-arch and where it lives', () => {
  assert.match(dockerSection, /linux\/amd64/);
  assert.match(dockerSection, /linux\/arm64/);
  assert.match(dockerSection, /GitHub Container Registry|ghcr\.io/);
  assert.match(dockerSection, /:\d+\.\d+\.\d+/, 'pin a version tag');
});

test('the README Updating note covers a pulled image as well as a rebuilt one', () => {
  const updating = section(readme, '### Updating', '### The `aidr` command');

  assert.match(updating, new RegExp(`docker pull ${IMAGE.replace(/[./]/g, '\\$&')}:latest`));
  assert.match(updating, /docker build -t auto-identity-remove \./);
});

test('the Dockerfile header points at the prebuilt image', () => {
  const header = dockerfile.split(/^FROM\s/m)[0];

  assert.match(header, new RegExp(IMAGE.replace(/[./]/g, '\\$&')));
});
test('the README Releasing section says the same run publishes the image, how to rebuild it, and the one-time public step', () => {
  const releasing = section(readme, '## Releasing', '## License');

  assert.match(releasing, new RegExp(IMAGE.replace(/[./]/g, '\\$&')));
  assert.match(releasing, /`image` job/);
  assert.match(releasing, /Run workflow/, 'a failed image job is rebuilt by starting the workflow by hand');
  assert.match(releasing, /Change visibility/i, 'GHCR creates a new package private; a NAS cannot pull it until it is made public');
  assert.match(releasing, /cannot be made private again|cannot make it private again|cannot be undone/i);
});

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

test('the 2.0.1 changelog section says an image is published with every release, and why', () => {
  const changelog = read('CHANGELOG.md');
  const m = changelog.match(/^## 2\.0\.1 - 2026-10-30$/m);

  assert.ok(m, 'CHANGELOG.md needs "## 2.0.1 - 2026-10-30"');
  const body = changelog.slice(m.index + m[0].length).split(/^## /m)[0];
  assert.match(body, /ghcr\.io\/stephenlthorn\/auto-identity-remove/);
  assert.match(body, /multi-arch|amd64/i);
  assert.match(body, /#8\b/);
  assert.match(body, /Synology/);
  assert.match(body, /docs?\b/i, 'and the documentation changes');
});

