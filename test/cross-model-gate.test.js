/**
 * test/cross-model-gate.test.js
 *
 * scripts/cross-model-gate.sh looks for a `Cross-model-review:` trailer with
 * `git log ... | grep -q` under `set -o pipefail`. grep -q exits on the first
 * match; when the trailer sits on a recent commit and older commits still have
 * more than a pipe buffer of text to write, git log dies of SIGPIPE (141),
 * pipefail makes the pipeline fail, and the gate reports a missing trailer
 * that is there. The 2026-10-29 overhaul branch (210 commits) hit exactly this.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'scripts', 'cross-model-gate.sh');
const skip = process.platform === 'win32' ? 'bash pipelines are exercised on POSIX CI' : false;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repoWithTrailerAboveALongHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-gate-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'gate@example.com']);
  git(dir, ['config', 'user.name', 'Gate Test']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'config.js'), 'module.exports = {};\n');
  git(dir, ['add', '.']);
  // Linux caps one argv string at 128 KiB, so the long message goes in a file.
  const message = path.join(dir, '.git', 'LONG_MSG');
  fs.writeFileSync(message, `touch a tier-1 file\n\n${'filler line for the pipe buffer\n'.repeat(8000)}`);
  git(dir, ['commit', '-q', '-F', message]);
  git(dir, ['commit', '-q', '--allow-empty', '-m',
    'merge the work\n\nCross-model-review: docs/reviews/cross-model/2026-10-29-abc1234.md (P1:0 P2:0)']);
  return { dir, base };
}

test('a trailer on the newest commit is found even when older commits are longer than a pipe buffer', { skip }, () => {
  const { dir, base } = repoWithTrailerAboveALongHistory();
  try {
    const r = spawnSync('bash', [GATE, base, 'HEAD'], { cwd: dir, encoding: 'utf8' });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Found a Cross-model-review trailer/);
    assert.doesNotMatch(r.stdout, /carries no Cross-model-review trailer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tier-1 change with no trailer still fails under CROSS_MODEL_STRICT=1', { skip }, () => {
  const { dir, base } = repoWithTrailerAboveALongHistory();
  try {
    git(dir, ['reset', '-q', '--hard', 'HEAD~1']);
    const r = spawnSync('bash', [GATE, base, 'HEAD'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, CROSS_MODEL_STRICT: '1' },
    });

    assert.equal(r.status, 1);
    assert.match(r.stdout, /carries no Cross-model-review trailer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
