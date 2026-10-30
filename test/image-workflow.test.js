/**
 * test/image-workflow.test.js
 *
 * The `image` job in .github/workflows/release.yml publishes a prebuilt
 * multi-arch image to ghcr.io/stephenlthorn/auto-identity-remove with every
 * release (issue #8: a Synology DS720+ had to download the source and
 * `docker build` a 940 MB Playwright image on a Celeron). Two things must never
 * happen, and neither is visible in a green unit suite:
 *
 *  - a broken image reaching users, because the push ran before anything proved
 *    the image can launch Chromium; and
 *  - `packages: write` leaking to a job that runs the tests, or a release
 *    publishing an image for a tag nobody released.
 *
 * Nothing here can run GitHub Actions, so the same two kinds of check as
 * test/release-workflow.test.js stand in for it: static checks on the YAML (the
 * parser is test/workflow-helpers.js), and the `run:` script that feeds the image
 * labels, executed for real. The job's `if:` expression is evaluated against a
 * table of situations rather than pattern-matched, because "does not run for a
 * push that found the release already there" is a behaviour, not a string.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ROOT, parseWorkflow, nameOf, runScript, withInput, stepKey, jobKey, jobPermissions, evaluateIf, usesLines,
} = require('./workflow-helpers');

const pkg = require(path.join(ROOT, 'package.json'));

const skip = process.platform === 'win32' ? 'the run: scripts are bash and are exercised on POSIX CI' : false;

const REPO = 'stephenlthorn/auto-identity-remove';
const REPO_URL = `https://github.com/${REPO}`;
const IMAGE = `ghcr.io/${REPO}`;

const workflow = parseWorkflow(path.join(ROOT, '.github', 'workflows', 'release.yml'));
const image = workflow.jobs.image || { name: 'image', text: '', steps: [] };
const steps = image.steps;

const NAMES = {
  meta: 'Read the image metadata',
  qemu: 'Set up QEMU',
  buildx: 'Set up Buildx',
  load: 'Build the amd64 image for the smoke test',
  smoke: 'Chromium must launch inside the image',
  login: 'Log in to GitHub Container Registry',
  push: 'Build and push the multi-arch image',
};

const stepNamed = name => {
  const step = steps.find(s => nameOf(s) === name);
  assert.ok(step, `precondition: the image job has a step named "${name}"`);
  return step;
};
const indexOfStep = name => steps.indexOf(stepNamed(name));
const usesOf = step => stepKey(step, 'uses') || '';

/** A `labels:` or `tags:` block as lines. */
const lines = block => (block || '').split('\n').map(l => l.trim()).filter(Boolean);

/** `key=value` lines as { key: value }. */
const keyValues = block => Object.fromEntries(lines(block).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// ---------------------------------------------------------------------------
// The job exists, and when it runs
// ---------------------------------------------------------------------------

test('the workflow has an image job that needs the release job', () => {
  assert.ok(image.text.length > 0, 'the release workflow has no `image` job');
  assert.equal(jobKey(image, 'needs'), 'release', 'it can only run after a release exists');
  assert.ok(steps.length >= 8, `expected the checkout plus the named steps, got ${steps.length}`);
  for (const name of Object.values(NAMES)) stepNamed(name);
});

test('the image job runs when this run created the release, or by hand to rebuild an existing release', () => {
  const expression = jobKey(image, 'if');
  assert.ok(expression, 'the image job has an if: condition');
  const run = ({ ref = 'refs/heads/main', event = 'push', exists = 'false', repository = REPO } = {}) => evaluateIf(expression, {
    github: { ref, event_name: event, repository },
    needs: { release: { outputs: { exists } } },
  });

  assert.equal(run({ event: 'push', exists: 'false' }), true, 'a push that cut a release builds its image');
  assert.equal(run({ event: 'workflow_dispatch', exists: 'false' }), true, 'so does a hand-started run that cut one');
  assert.equal(run({ event: 'workflow_dispatch', exists: 'true' }), true, 'a hand-started run rebuilds the image for a release that exists');
  assert.equal(run({ event: 'push', exists: 'true' }), false,
    'a push that found the release already there (a package.json edit that is not a version bump) must not rebuild and re-push it');
});

test('the image job runs for main only, and only in this repository', () => {
  const expression = jobKey(image, 'if');
  const run = ctx => evaluateIf(expression, {
    github: { ref: 'refs/heads/main', event_name: 'push', repository: REPO, ...ctx.github },
    needs: { release: { outputs: { exists: 'false', ...ctx.exists } } },
  });

  for (const event of ['push', 'workflow_dispatch']) {
    for (const exists of ['true', 'false']) {
      assert.equal(run({ github: { ref: 'refs/heads/some-branch', event_name: event }, exists: { exists } }), false,
        `${event} from another branch must not publish an image`);
      assert.equal(run({ github: { ref: 'refs/tags/v2.0.1', event_name: event }, exists: { exists } }), false,
        `${event} from a tag must not publish an image`);
    }
  }
  assert.equal(run({ github: { repository: 'someone-else/auto-identity-remove' } }), false,
    'a fork has no right to push to ghcr.io/stephenlthorn, and would only fail after an hour of arm64 emulation');
  assert.equal(run({ exists: { exists: '' } }), false, 'a release job that did not say whether the release existed is not a go');
});

test('the image job has exactly contents: read and packages: write', () => {
  assert.deepEqual(jobPermissions(image), { contents: 'read', packages: 'write' });
});

test('no other job, and not the workflow default, has packages: write', () => {
  const others = Object.values(workflow.jobs).filter(j => j.name !== 'image');

  assert.ok(others.length >= 1, 'precondition: there is another job to check');
  for (const job of others) {
    assert.doesNotMatch(job.text, /packages:/, `the ${job.name} job must not touch packages`);
  }
  assert.doesNotMatch(workflow.sections.permissions, /packages:/);
  assert.equal((workflow.text.match(/packages:\s*write/g) || []).length, 1, 'one packages: write in the whole file');
});

test('the image job has a timeout that allows for arm64 under QEMU', () => {
  const minutes = Number(jobKey(image, 'timeout-minutes'));

  assert.ok(minutes >= 45 && minutes <= 60, `about an hour for an emulated npm ci and Chromium layer, got ${minutes}`);
});

// ---------------------------------------------------------------------------
// What it builds from
// ---------------------------------------------------------------------------

test('it checks out the release tag, not a branch or a moving ref, and keeps no token in .git/config', () => {
  const checkout = steps.find(s => /uses: actions\/checkout@/.test(s));

  assert.ok(checkout, 'the image job checks the repository out');
  assert.equal(withInput(checkout, 'ref'), 'refs/tags/${{ needs.release.outputs.tag }}',
    'the image must be built from the commit the release was cut at, which a hand-started rebuild of an old release cannot get from github.sha');
  assert.equal(withInput(checkout, 'persist-credentials'), 'false');
  assert.equal(steps.indexOf(checkout), 0, 'and nothing runs before it');
});

test('every action in the job is pinned to a full commit SHA with a version comment, and all four docker actions are used', () => {
  const uses = usesLines(image.text);
  const unpinned = uses.filter(l => !/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/.test(l));

  assert.deepEqual(unpinned, []);
  for (const action of ['docker/login-action', 'docker/setup-qemu-action', 'docker/setup-buildx-action', 'docker/build-push-action']) {
    assert.ok(uses.some(l => l.includes(`${action}@`)), `${action} is used`);
  }
  assert.equal(uses.filter(l => l.includes('docker/build-push-action@')).length, 2, 'the same build action for the smoke build and the push');
});

test('the tag is checked against package.json before anything is built, and the labels are read from package.json', () => {
  const script = runScript(stepNamed(NAMES.meta));

  assert.ok(indexOfStep(NAMES.meta) < indexOfStep(NAMES.load));
  assert.match(script, /package\.json/);
  assert.match(script, /\$VERSION|process\.env\.VERSION/, 'the release version arrives through env and is compared');
  assert.match(script, /git rev-parse HEAD/, 'the revision label is the commit that was checked out, not the one that started the run');
});

// ---------------------------------------------------------------------------
// The order that makes "a broken image is never pushed" true
// ---------------------------------------------------------------------------

test('steps run in the order: set up, build amd64 and load it, smoke test it, log in, push', () => {
  const order = [NAMES.meta, NAMES.buildx, NAMES.load, NAMES.smoke, NAMES.login, NAMES.push].map(indexOfStep);

  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'strictly increasing');
  assert.equal(new Set(order).size, order.length);
  assert.ok(indexOfStep(NAMES.qemu) < indexOfStep(NAMES.push), 'arm64 needs the emulator installed before the push build');
});

test('the amd64 image is built with --load and without pushing, and is the image the smoke test runs', () => {
  const load = stepNamed(NAMES.load);
  const smoke = runScript(stepNamed(NAMES.smoke));
  const tag = withInput(load, 'tags');

  assert.match(usesOf(load), /^docker\/build-push-action@/);
  assert.equal(withInput(load, 'platforms'), 'linux/amd64', 'amd64 is what the DS720+ runs and what the runner can execute');
  assert.equal(withInput(load, 'load'), 'true');
  assert.notEqual(withInput(load, 'push'), 'true');
  assert.equal(withInput(load, 'context'), '.');
  assert.ok(tag && !tag.includes('/'), `a local tag, not a registry one, got "${tag}"`);
  assert.match(smoke, new RegExp(`^docker run --rm --init ${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} node scripts/ci/docker-smoke\\.js$`, 'm'),
    'it must run the same docker-smoke.js test.yml runs, in the image that was just built');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'ci', 'docker-smoke.js')));
});

test('nothing before the smoke test pushes an image or logs in to a registry', () => {
  const smoke = indexOfStep(NAMES.smoke);
  const early = steps.slice(0, smoke + 1);

  for (const step of early) {
    const label = nameOf(step) || step.split('\n')[0];
    assert.doesNotMatch(step, /^ {10}push:\s*true\s*$/m, `"${label}" pushes before the smoke test`);
    assert.doesNotMatch(step, /docker push|docker login|login-action|docker buildx imagetools create/, `"${label}" publishes or authenticates before the smoke test`);
  }
});

test('exactly one step pushes, exactly one logs in, and both come after the smoke test', () => {
  const pushing = steps.filter(s => /^ {10}push:\s*true\s*$/m.test(s));
  const login = steps.filter(s => /login-action@/.test(s));

  assert.equal(pushing.length, 1);
  assert.equal(nameOf(pushing[0]), NAMES.push);
  assert.equal(login.length, 1);
  assert.equal(nameOf(login[0]), NAMES.login);
  assert.ok(indexOfStep(NAMES.login) > indexOfStep(NAMES.smoke));
  assert.ok(indexOfStep(NAMES.push) > indexOfStep(NAMES.login));
});

// ---------------------------------------------------------------------------
// What is pushed
// ---------------------------------------------------------------------------

test('it pushes linux/amd64 and linux/arm64, tagged with the version and latest', () => {
  const push = stepNamed(NAMES.push);
  const tags = lines(withInput(push, 'tags')).map(t => t.replace('${{ env.IMAGE }}', IMAGE));

  assert.match(usesOf(push), /^docker\/build-push-action@/);
  assert.deepEqual(withInput(push, 'platforms').split(',').sort(), ['linux/amd64', 'linux/arm64']);
  assert.equal(withInput(push, 'push'), 'true');
  assert.equal(withInput(push, 'context'), '.');
  assert.deepEqual(tags.sort(), [`${IMAGE}:\${{ steps.meta.outputs.version }}`, `${IMAGE}:latest`].sort());
  assert.match(workflow.text, new RegExp(`^ {6}IMAGE: ${IMAGE.replace(/[./]/g, '\\$&')}$`, 'm'), 'the image name is set once, as ghcr.io/stephenlthorn/auto-identity-remove');
});

test('the image carries the OCI labels, and source links the package to this repository', () => {
  const labels = keyValues(withInput(stepNamed(NAMES.push), 'labels'));

  assert.equal(labels['org.opencontainers.image.source'], REPO_URL, 'without this label GHCR shows the package unlinked from the repo');
  assert.equal(labels['org.opencontainers.image.version'], '${{ steps.meta.outputs.version }}');
  assert.equal(labels['org.opencontainers.image.licenses'], '${{ steps.meta.outputs.license }}');
  assert.equal(labels['org.opencontainers.image.description'], '${{ steps.meta.outputs.description }}');
  assert.equal(labels['org.opencontainers.image.revision'], '${{ steps.meta.outputs.revision }}');
});

test('the amd64 smoke build and the push share one builder, and QEMU is limited to arm64', () => {
  const qemu = stepNamed(NAMES.qemu);

  assert.match(usesOf(qemu), /^docker\/setup-qemu-action@/);
  assert.match(withInput(qemu, 'platforms') || '', /^(linux\/)?arm64$/, 'emulating only what is not native keeps the setup short');
  assert.match(usesOf(stepNamed(NAMES.buildx)), /^docker\/setup-buildx-action@/);
});

test('it logs in to ghcr.io as the actor with the workflow token, and no other secret is used', () => {
  const login = stepNamed(NAMES.login);

  assert.match(usesOf(login), /^docker\/login-action@/);
  assert.equal(withInput(login, 'registry'), 'ghcr.io');
  assert.equal(withInput(login, 'username'), '${{ github.actor }}');
  assert.equal(withInput(login, 'password'), '${{ secrets.GITHUB_TOKEN }}');
  assert.deepEqual([...workflow.text.matchAll(/secrets\.(\w+)/g)].map(m => m[1]), ['GITHUB_TOKEN']);
});

// ---------------------------------------------------------------------------
// The metadata step, executed
// ---------------------------------------------------------------------------

function mktmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aidr-img-${label}-`));
}

/** A throwaway checkout: a git repo with one commit and the given package.json. */
function makeCheckout(manifest) {
  const dir = mktmp('checkout');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', 'package.json').status, 0);
  assert.equal(git('commit', '-q', '-m', 'release').status, 0);
  return { dir, head: git('rev-parse', 'HEAD').stdout.trim() };
}

function runMeta({ cwd, version }) {
  const work = mktmp('meta');
  const output = path.join(work, 'github-output');
  fs.writeFileSync(output, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runScript(stepNamed(NAMES.meta))], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: work, GITHUB_OUTPUT: output, VERSION: version },
  });
  const outputs = fs.readFileSync(output, 'utf8');
  fs.rmSync(work, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs, lines: outputs.split('\n').filter(Boolean) };
}

test('the metadata step reads version, license and description from package.json and the revision from git', { skip }, () => {
  const { dir, head } = makeCheckout({ name: 'x', version: '2.0.1', license: 'MIT', description: 'Removes things' });
  try {
    const r = runMeta({ cwd: dir, version: '2.0.1' });

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.sort(), [
      'description=Removes things',
      'license=MIT',
      `revision=${head}`,
      'version=2.0.1',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the metadata step refuses a tag whose package.json says a different version, so the version label is never a lie', { skip }, () => {
  const { dir } = makeCheckout({ name: 'x', version: '2.0.0', license: 'MIT', description: 'd' });
  try {
    const r = runMeta({ cwd: dir, version: '2.0.1' });

    assert.notEqual(r.status, 0);
    assert.equal(r.outputs, '', 'and sets no output the build could use');
    assert.match(r.stdout + r.stderr, /::error::.*2\.0\.1.*2\.0\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the metadata step refuses a package.json with no license, because a licenses label must not be empty', { skip }, () => {
  const { dir } = makeCheckout({ name: 'x', version: '2.0.1', description: 'd' });
  try {
    const r = runMeta({ cwd: dir, version: '2.0.1' });

    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /::error::.*license/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a multi-line description stays one output line, so it cannot add outputs of its own', { skip }, () => {
  const { dir, head } = makeCheckout({ name: 'x', version: '2.0.1', license: 'MIT', description: 'first\nrevision=deadbeef\n  third' });
  try {
    const r = runMeta({ cwd: dir, version: '2.0.1' });

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.lines.filter(l => l.startsWith('revision=')).length, 1, 'one revision, the real one');
    assert.ok(r.lines.includes(`revision=${head}`));
    assert.ok(r.lines.includes('description=first revision=deadbeef third'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('against the real package.json the metadata step yields the labels this release will carry', { skip }, () => {
  const r = runMeta({ cwd: ROOT, version: pkg.version });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.lines.includes(`version=${pkg.version}`));
  assert.ok(r.lines.includes(`license=${pkg.license}`));
  assert.ok(r.lines.some(l => l.startsWith('description=') && l.length > 'description='.length + 20));
  assert.ok(r.lines.some(l => /^revision=[0-9a-f]{40}$/.test(l)));
});
