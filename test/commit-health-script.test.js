'use strict';
/**
 * test/commit-health-script.test.js
 *
 * scripts/ci/commit-health.sh, the commit step of the weekly broker health
 * workflow, run against REAL git repositories in a temp directory (a bare
 * repository stands in for GitHub). No network.
 *
 * What it must get right:
 *   - nothing changed: no commit, no push, exit 0 (the issue sync still runs after it)
 *   - main moved while the job ran: pull --rebase, then push
 *   - a rebase conflict in the two generated files: regenerate on top of the
 *     new main and push, instead of failing
 *   - a push that is rejected once: try once more, then fail loudly
 *   - only the two generated files are ever committed
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ci', 'commit-health.sh');

// A stand-in for scripts/generate-status.js: STATUS.md is a pure function of the health file
// plus brokers.txt, like the real one is of the health file plus brokers.js.
const FAKE_GENERATE = `
const fs = require('node:fs');
const health = fs.readFileSync('data/broker-health.json', 'utf8').trim();
const brokers = fs.readFileSync('brokers.txt', 'utf8').trim();
fs.writeFileSync('STATUS.md', 'brokers=' + brokers + '\\nhealth=' + health + '\\n');
`;

let root;
let work;
let origin;
let other;

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const write = (cwd, file, text) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
};
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), 'utf8');

function setIdentity(cwd) {
  git(cwd, 'config', 'user.name', 'Someone');
  git(cwd, 'config', 'user.email', 'someone@example.com');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-commit-health-'));
  origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  work = path.join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  setIdentity(work);
  git(work, 'checkout', '-q', '-b', 'main');
  write(work, 'brokers.txt', 'A\n');
  write(work, 'gen.js', FAKE_GENERATE);
  write(work, 'data/broker-health.json', '{"week":0}\n');
  write(work, 'STATUS.md', 'brokers=A\nhealth={"week":0}\n');
  write(work, 'README.md', 'readme\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'start');
  git(work, 'push', '-q', 'origin', 'main');

  other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  setIdentity(other);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const runScript = (extraEnv = {}) => spawnSync('bash', [SCRIPT], {
  cwd: work,
  encoding: 'utf8',
  env: { ...process.env, HEALTH_REGENERATE: 'node gen.js', ...extraEnv },
});
const remoteLog = () => git(origin, 'log', '--format=%s', 'main').split('\n');
const remoteFile = (file) => git(origin, 'show', `main:${file}`);

// The job's state when the commit step runs: the artifact is in data/, STATUS.md is regenerated.
const jobProduces = (week) => {
  write(work, 'data/broker-health.json', `{"week":${week}}\n`);
  write(work, 'STATUS.md', `brokers=A\nhealth={"week":${week}}\n`);
};

describe('commit-health.sh', () => {
  test('nothing changed: no commit, no push, exit 0', () => {
    const before = git(origin, 'rev-parse', 'main');
    const out = runScript();
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /nothing changed/);
    assert.equal(git(origin, 'rev-parse', 'main'), before);
  });

  test('a change is committed as the Actions bot and pushed to main', () => {
    jobProduces(1);
    const out = runScript();
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.equal(remoteLog()[0], 'chore(health): weekly broker health check');
    assert.equal(remoteFile('data/broker-health.json'), '{"week":1}');
    assert.equal(git(origin, 'log', '-1', '--format=%an', 'main'), 'github-actions[bot]');
  });

  test('only the two generated files are committed, even with other changes in the tree', () => {
    jobProduces(1);
    write(work, 'README.md', 'edited by something else\n');
    write(work, 'stray.txt', 'stray\n');
    assert.equal(runScript().status, 0);
    assert.equal(remoteFile('README.md'), 'readme');
    assert.equal(git(origin, 'ls-tree', '--name-only', 'main').split('\n').includes('stray.txt'), false);
  });

  test('main moved while the job ran: rebases on it and pushes (H3)', () => {
    write(other, 'README.md', 'a human commit that landed during the job\n');
    git(other, 'commit', '-q', '-am', 'docs: human commit');
    git(other, 'push', '-q', 'origin', 'main');
    jobProduces(1);
    const out = runScript();
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.deepEqual(remoteLog().slice(0, 2), ['chore(health): weekly broker health check', 'docs: human commit']);
    assert.equal(remoteFile('README.md'), 'a human commit that landed during the job');
    assert.equal(remoteFile('data/broker-health.json'), '{"week":1}');
  });

  test('main moved and changed brokers.js: STATUS.md is regenerated on the new base, not left stale', () => {
    write(other, 'brokers.txt', 'A\nB\n');
    git(other, 'commit', '-q', '-am', 'feat: broker B');
    git(other, 'push', '-q', 'origin', 'main');
    jobProduces(1);
    const out = runScript();
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.match(remoteFile('STATUS.md'), /brokers=A\nB\n/);
    assert.match(remoteFile('STATUS.md'), /"week":1/);
  });

  test('a rebase conflict in the generated files is regenerated on the new main, not a failure (H3)', () => {
    // Another run (a re-run of last week, say) already committed its own copy of both files.
    write(other, 'data/broker-health.json', '{"week":"from-the-other-run"}\n');
    write(other, 'STATUS.md', 'brokers=A\nhealth={"week":"from-the-other-run"}\n');
    git(other, 'commit', '-q', '-am', 'chore(health): weekly broker health check');
    git(other, 'push', '-q', 'origin', 'main');
    jobProduces(2);
    const out = runScript();
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.equal(remoteFile('data/broker-health.json'), '{"week":2}', 'this run is the newer result');
    assert.equal(remoteFile('STATUS.md'), 'brokers=A\nhealth={"week":2}');
    assert.equal(git(work, 'status', '--porcelain'), '', 'no half-finished rebase left behind');
    assert.equal(fs.existsSync(path.join(work, '.git', 'rebase-merge')), false);
  });

  test('a push that is rejected once is retried once', () => {
    const flag = path.join(root, 'rejected-once');
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -e '${flag}' ]; then : > '${flag}'; echo 'rejected for the test' >&2; exit 1; fi\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    jobProduces(1);
    const out = runScript();
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.equal(remoteFile('data/broker-health.json'), '{"week":1}');
  });

  test('a push that keeps being rejected fails loudly (non-zero), after one retry', () => {
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "always rejected" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    jobProduces(1);
    const before = git(origin, 'rev-parse', 'main');
    const out = runScript();
    assert.notEqual(out.status, 0);
    assert.equal(git(origin, 'rev-parse', 'main'), before);
  });

  test('never force-pushes and never adds everything', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(text, /--force|push -f|git add (-A|\.)/);
    assert.match(text, /git add data\/broker-health\.json STATUS\.md/);
    assert.match(text, /github-actions\[bot\]/);
  });
});
