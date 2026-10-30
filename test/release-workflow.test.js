/**
 * test/release-workflow.test.js
 *
 * .github/workflows/release.yml cuts a GitHub Release when `version` in
 * package.json changes on main, attaching the tarball from
 * scripts/release-archive.sh. Downloads of attached files are the only install
 * count GitHub keeps, so a release that silently does not happen, or happens
 * twice, or ships a tarball nobody tested, defeats the point.
 *
 * Nothing here can run GitHub Actions. Two kinds of check stand in for that:
 *
 *  - Static checks on the YAML: triggers, permissions, pinned actions, step
 *    order. These are the properties a reviewer would otherwise have to remember
 *    to look for.
 *  - The `run:` scripts themselves, pulled out of the YAML and executed with a
 *    stub `gh` on the PATH. The existing-release check is the one that matters
 *    most: only a 404 may count as "absent", because treating a 401, a 500 or a
 *    dropped connection as "absent" would publish over a release that exists. A
 *    text match cannot tell the two apart; running it can.
 *
 * The workflow family style (pinned runs, values passed through env, never
 * interpolated into a shell) follows .github/workflows/test.yml.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const pkg = require(path.join(ROOT, 'package.json'));

const skip = process.platform === 'win32' ? 'the run: scripts are bash and are exercised on POSIX CI' : false;

const readOrEmpty = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const yml = readOrEmpty(WORKFLOW);
const changelog = readOrEmpty(path.join(ROOT, 'CHANGELOG.md'));

/** The workflow split at its top-level keys: { on, permissions, concurrency, jobs, ... }. */
function topLevelSections(text) {
  const sections = {};
  let key = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*):/);
    if (m) {
      key = m[1];
      sections[key] = '';
    }
    if (key) sections[key] += `${line}\n`;
  }
  return sections;
}

const sections = topLevelSections(yml);
const jobs = sections.jobs || '';

/** The job's steps, each as the text of one list item. */
const steps = jobs
  .slice(jobs.indexOf('    steps:\n') + '    steps:\n'.length)
  .split(/^ {6}- /m)
  .slice(1)
  // The first key of an item sits on the "- " line; give it its siblings' indent.
  .map(s => `        ${s}`);

const nameOf = step => (step.match(/^ {8}name: (.+)$/m) || [])[1];
const stepNamed = name => {
  const step = steps.find(s => nameOf(s) === name);
  assert.ok(step, `precondition: the workflow has a step named "${name}"`);
  return step;
};
const indexOfStep = name => steps.indexOf(stepNamed(name));

/** The script a step runs: a `run: |` block, dedented, or a one-line `run: cmd` ('' when it has none). */
function runScript(step) {
  const oneLine = step.match(/^ {8}run: (?!\|\s*$)(.+)$/m);
  if (oneLine) return oneLine[1];
  const lines = step.split('\n');
  const start = lines.findIndex(l => /^ {8}run: \|\s*$/.test(l));
  if (start === -1) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const NAMES = {
  version: 'Read the version',
  check: 'Stop if the release already exists',
  node: 'Set up Node.js 22',
  install: 'Install dependencies',
  dashboardInstall: 'Install dashboard dependencies',
  test: 'Run tests',
  notes: 'Extract the release notes',
  build: 'Build the release archive',
  create: 'Create the release',
};

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

test('the workflow and the changelog exist', () => {
  assert.ok(yml.length > 0, '.github/workflows/release.yml is missing');
  assert.ok(changelog.length > 0, 'CHANGELOG.md is missing');
});

test('the workflow was parsed into the one job and the steps this file reasons about', () => {
  assert.equal([...jobs.matchAll(/^ {2}[\w-]+:\s*$/gm)].length, 1, 'exactly one job');
  for (const name of Object.values(NAMES)) stepNamed(name);
  assert.ok(steps.length >= 10, `expected the checkout plus the ten named steps, got ${steps.length}`);
});

test('it runs when package.json changes on main, or when started by hand, and never on a pull request', () => {
  const on = sections.on || '';

  assert.match(on, /^ {2}push:\n {4}branches: \[main\]\n {4}paths: \[package\.json\]\n/m);
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(on, /pull_request/);
});

test('the job only runs for main, so a hand-started run from another branch is skipped', () => {
  assert.match(jobs, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test('permissions default to read and only the release job may write', () => {
  assert.match(sections.permissions, /^permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(sections.permissions, /write/);

  const writes = yml.match(/:\s*write\b/g) || [];
  assert.equal(writes.length, 1, 'exactly one write permission in the whole file');
  assert.match(jobs, /^ {4}permissions:\n {6}contents: write\n/m, 'and it sits on the release job');
  assert.doesNotMatch(yml, /write-all/);
});

test('releases are serialised and never cancelled half way', () => {
  assert.match(sections.concurrency, /^ {2}group: release$/m);
  assert.match(sections.concurrency, /^ {2}cancel-in-progress: false$/m);
});

test('the job has a timeout', () => {
  const m = jobs.match(/^ {4}timeout-minutes: (\d+)$/m);

  assert.ok(m, 'timeout-minutes is set on the job');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 60, `a sane timeout, got ${m[1]}`);
});

test('checkout does not leave the token in .git/config', () => {
  const checkout = steps.find(s => /uses: actions\/checkout@/.test(s));

  assert.ok(checkout, 'the job checks the repository out');
  assert.match(checkout, /^ {10}persist-credentials: false$/m);
});

test('every action is pinned to a full commit SHA with a version comment', () => {
  const uses = yml.split('\n').filter(l => /^\s*(- )?uses:/.test(l));
  const unpinned = uses.filter(l => !/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/.test(l));

  assert.ok(uses.length >= 2, `expected at least checkout and setup-node, got ${uses.length}`);
  assert.deepEqual(unpinned, [], 'a tag can be moved after review; a SHA cannot');
});

test('no third-party release action: only first-party actions/*, and gh does the publishing', () => {
  const owners = [...yml.matchAll(/uses:\s+([\w.-]+)\//g)].map(m => m[1]);

  assert.deepEqual([...new Set(owners)], ['actions']);
  assert.match(runScript(stepNamed(NAMES.create)), /^gh release create /m);
});

test('the tests run on Node 22', () => {
  assert.match(stepNamed(NAMES.node), /^ {10}node-version: 22$/m);
});

test('GH_TOKEN is set only on the two steps that call gh', () => {
  const withToken = steps.filter(s => /GH_TOKEN/.test(s)).map(nameOf);

  assert.deepEqual(withToken.sort(), [NAMES.check, NAMES.create].sort());
  assert.equal((yml.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) || []).length, 2);
});

test('no run: script interpolates a ${{ }} expression; values arrive through env', () => {
  const offenders = steps.filter(s => /\$\{\{/.test(runScript(s))).map(s => nameOf(s) || s.split('\n')[0]);

  assert.deepEqual(offenders, [], 'interpolating into a shell is how workflow injection happens');
});

test('the existing-release check comes before anything is installed, tested or built', () => {
  const check = indexOfStep(NAMES.check);

  for (const name of [NAMES.node, NAMES.install, NAMES.dashboardInstall, NAMES.test, NAMES.notes, NAMES.build, NAMES.create]) {
    assert.ok(indexOfStep(name) > check, `"${name}" must come after the existence check`);
  }
  assert.ok(indexOfStep(NAMES.version) < check, 'the tag is known before it is looked up');
});

test('every step after the existence check is skipped when the release already exists', () => {
  const check = indexOfStep(NAMES.check);
  const unguarded = steps.slice(check + 1).filter(s => !/^ {8}if: steps\.check\.outputs\.exists == 'false'$/m.test(s));

  assert.deepEqual(unguarded.map(nameOf), []);
});

test('npm test runs before the release is created, and the archive is built before it too', () => {
  const create = indexOfStep(NAMES.create);

  assert.match(runScript(stepNamed(NAMES.test)), /^npm test$/m);
  assert.ok(indexOfStep(NAMES.install) < indexOfStep(NAMES.test));
  assert.ok(indexOfStep(NAMES.test) < indexOfStep(NAMES.build), 'nothing is built from a tree that has not passed');
  assert.ok(indexOfStep(NAMES.build) < create);
  assert.ok(indexOfStep(NAMES.notes) < create);
});

test('the release notes come from CHANGELOG.md, never auto-generated', () => {
  const create = runScript(stepNamed(NAMES.create));

  assert.match(runScript(stepNamed(NAMES.notes)), /CHANGELOG\.md/);
  assert.match(create, /--notes-file /);
  assert.doesNotMatch(create, /--generate-notes|--notes "/);
});

test('the release is titled with the tag and pinned to the commit that was tested', () => {
  const create = runScript(stepNamed(NAMES.create));

  assert.match(create, /--title "\$TAG"/);
  assert.match(create, /--target "\$GITHUB_SHA"/);
});

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

test('package.json carries a plain X.Y.Z version, the only shape the workflow will tag', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('CHANGELOG.md has a dated section for the version in package.json', () => {
  const heading = new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  const m = changelog.match(heading);

  assert.ok(m, `CHANGELOG.md needs "## ${pkg.version} - <date>"; the release workflow fails without it`);
  const body = changelog.slice(m.index + m[0].length).split(/^## /m)[0];
  assert.ok(body.trim().length > 40, 'and the section has to say something');
});

test('the 2.0.0 section tells 1.x users what changes for them', () => {
  const body = changelog.split(/^## 2\.0\.0 - .*$/m)[1].split(/^## /m)[0];

  assert.match(body, /^#{3,4} Upgrading from 1\.x$/m);
  assert.match(body, /Node(\.js)? 20/);
  assert.match(body, /dashboard/i);
  assert.match(body, /AIDR_HOME=\/home\/aidr/);
});

// ---------------------------------------------------------------------------
// The run: scripts, executed
// ---------------------------------------------------------------------------

function mktmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aidr-wf-${label}-`));
}

/** A fake `gh` that logs its arguments and answers from env, per endpoint. */
function installStubGh(binDir) {
  const body = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  api*releases/tags/*) mode="\${STUB_RELEASE:-404}" ;;
  api*git/ref/tags/*) mode="\${STUB_TAG:-404}" ;;
  release\\ create*) exit 0 ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
case "$mode" in
  found) echo '{"id":1}'; exit 0 ;;
  404) printf '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  500) echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;
  401) echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1 ;;
  net) echo 'error connecting to api.github.com' >&2; exit 1 ;;
esac
`;
  fs.writeFileSync(path.join(binDir, 'gh'), body, { mode: 0o755 });
}

/** Run one step's script the way Actions does (`bash -eo pipefail`), with its own env. */
function runStep(name, { cwd = ROOT, env = {}, bin } = {}) {
  assert.notEqual(runScript(stepNamed(name)), '', `"${name}" has no run: script to execute`);
  const work = mktmp('run');
  const output = path.join(work, 'github-output');
  const log = path.join(work, 'gh.log');
  fs.writeFileSync(output, '');
  fs.writeFileSync(log, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runScript(stepNamed(name))], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${bin ? `${bin}:` : ''}${process.env.PATH}`,
      HOME: work,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: work,
      STUB_LOG: log,
      ...env,
    },
  });
  const notesFile = path.join(env.RUNNER_TEMP || work, 'release-notes.md');
  const result = {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs: fs.readFileSync(output, 'utf8'),
    ghCalls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null,
  };
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

const REPO = 'stephenlthorn/auto-identity-remove';
const checkEnv = (stub) => ({ GH_TOKEN: 'test-token', REPO, TAG: 'v2.0.0', ...stub });

function withStubGh(fn) {
  const bin = mktmp('bin');
  installStubGh(bin);
  try {
    return fn(bin);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('the version step turns package.json into the version and the v-prefixed tag', { skip }, () => {
  const dir = mktmp('pkg');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"2.10.3"}\n');
    const r = runStep(NAMES.version, { cwd: dir });

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.outputs.trim().split('\n').sort(), ['tag=v2.10.3', 'version=2.10.3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the version step refuses anything that is not X.Y.Z, so it never tags a surprise', { skip }, () => {
  for (const bad of ['2.0', '2.0.0-rc.1', 'latest', '2.0.0; touch pwned', '']) {
    const dir = mktmp('badpkg');
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: bad }));
      const r = runStep(NAMES.version, { cwd: dir });

      assert.notEqual(r.status, 0, `version "${bad}" must fail the job`);
      assert.equal(r.outputs, '', `and set no output for "${bad}"`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('with neither a release nor a tag, the check says go and looks up the exact tag', { skip }, () => {
  withStubGh(bin => {
    const r = runStep(NAMES.check, { bin, env: checkEnv({ STUB_RELEASE: '404', STUB_TAG: '404' }) });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /^exists=false$/m);
    assert.deepEqual(r.ghCalls.sort(), [
      `api repos/${REPO}/git/ref/tags/v2.0.0`,
      `api repos/${REPO}/releases/tags/v2.0.0`,
    ]);
  });
});

test('an existing release stops the run with success and a notice', { skip }, () => {
  withStubGh(bin => {
    const r = runStep(NAMES.check, { bin, env: checkEnv({ STUB_RELEASE: 'found', STUB_TAG: 'found' }) });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /^exists=true$/m);
    assert.match(r.stdout, /^::notice::.*v2\.0\.0 already exists/m);
  });
});

test('a tag with no release counts as existing: re-tagging would move a published ref', { skip }, () => {
  withStubGh(bin => {
    const r = runStep(NAMES.check, { bin, env: checkEnv({ STUB_RELEASE: '404', STUB_TAG: 'found' }) });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /^exists=true$/m);
    assert.match(r.stdout, /^::notice::/m);
  });
});

test('only a 404 counts as absent: a 401, a 500 or a dead connection fails the job', { skip }, () => {
  for (const failure of ['401', '500', 'net']) {
    for (const stub of [{ STUB_RELEASE: failure, STUB_TAG: '404' }, { STUB_RELEASE: '404', STUB_TAG: failure }]) {
      withStubGh(bin => {
        const r = runStep(NAMES.check, { bin, env: checkEnv(stub) });

        assert.notEqual(r.status, 0, `${JSON.stringify(stub)} must not be read as "absent"`);
        assert.doesNotMatch(r.outputs, /exists=false/, `${JSON.stringify(stub)} must not say go`);
        assert.match(r.stdout, /^::error::/m);
      });
    }
  }
});

test('the notes step extracts one version section, exactly, and nothing from its neighbours', { skip }, () => {
  const dir = mktmp('changelog');
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), [
      '# Changelog', '',
      '## 2.0.1 - 2026-11-02', '', 'only in 2.0.1', '',
      '## 2.0.0 - 2026-10-30', '', 'Headline of two.', '', '### Upgrading from 1.x', '', '- a change', '',
      '## 1.0.0 - 2026-01-01', '', 'only in 1.0.0', '',
    ].join('\n'));
    const r = runStep(NAMES.notes, { cwd: dir, env: { VERSION: '2.0.0' } });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.notes, /Headline of two\./);
    assert.match(r.notes, /### Upgrading from 1\.x/);
    assert.doesNotMatch(r.notes, /only in 2\.0\.1|only in 1\.0\.0|## 2\.0\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the notes step fails when the version has no section, or an empty one', { skip }, () => {
  const dir = mktmp('changelog-missing');
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## 2.1.0 - 2026-11-01\n\n## 2.0.0 - 2026-10-30\n\nthe two body\n\n## 1.0.0 - 2026-01-01\n\nold\n');

    const missing = runStep(NAMES.notes, { cwd: dir, env: { VERSION: '3.0.0' } });
    const empty = runStep(NAMES.notes, { cwd: dir, env: { VERSION: '2.1.0' } });
    // 2.0 is a prefix of 2.0.0, which has a body: a substring match would find it.
    const substring = runStep(NAMES.notes, { cwd: dir, env: { VERSION: '2.0' } });

    for (const r of [missing, empty, substring]) {
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /^::error::.*CHANGELOG\.md/m);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real CHANGELOG yields notes for the real version', { skip }, () => {
  const r = runStep(NAMES.notes, { env: { VERSION: pkg.version } });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.notes.trim().length > 40);
  assert.doesNotMatch(r.notes, /^## /m, 'the next version heading must not leak in');
});

test('notes, archive and create fit together: every file the release attaches was just built', { skip }, () => {
  withStubGh(bin => {
    const work = mktmp('e2e');
    try {
      const env = { RUNNER_TEMP: work, VERSION: pkg.version, GH_TOKEN: 'test-token', REPO, TAG: `v${pkg.version}`, GITHUB_SHA: 'a'.repeat(40) };
      const notes = runStep(NAMES.notes, { env });
      const build = runStep(NAMES.build, { env });
      const create = runStep(NAMES.create, { bin, env });

      assert.equal(notes.status, 0, notes.stdout + notes.stderr);
      assert.equal(build.status, 0, build.stdout + build.stderr);
      assert.equal(create.status, 0, create.stderr);

      const call = create.ghCalls.find(c => c.startsWith('release create '));
      assert.ok(call, `gh release create was called: ${create.ghCalls.join(' | ')}`);
      const args = call.split(' ');
      const files = args.filter(a => a.startsWith(work) && a.includes('auto-identity-remove.tar.gz'));

      assert.equal(args[2], `v${pkg.version}`);
      assert.deepEqual(files.map(f => path.basename(f)).sort(), ['auto-identity-remove.tar.gz', 'auto-identity-remove.tar.gz.sha256']);
      for (const f of files) assert.ok(fs.existsSync(f), `${f} is attached but the archive step did not build it`);
      assert.equal(args[args.indexOf('--target') + 1], 'a'.repeat(40));
      assert.equal(args[args.indexOf('--title') + 1], `v${pkg.version}`);
      assert.ok(fs.existsSync(args[args.indexOf('--notes-file') + 1]), 'the notes file exists');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
