/**
 * test/scheduler-crontab-injection.test.js
 *
 * The crontab installer rewrote the user's entire crontab by piping it through a
 * shell: `echo "<new crontab>" | crontab -`. Double quotes do not stop a shell
 * expanding $(...), backticks or $VAR, so every pre-existing line was evaluated
 * on its way back in. A perfectly ordinary line like
 *
 *     0 3 * * * /usr/bin/backup --tag=$(date +\%F)
 *
 * came back as `--tag=\2026-08-12`: the user's unrelated backup job permanently
 * rewritten by a privacy tool installing its own schedule, plus whatever command
 * substitution was in there actually running at install time.
 *
 * Two guarantees are tested separately, because they fail separately:
 *   1. buildCrontabPayload() preserves prior content byte for byte (pure).
 *   2. the payload reaches `crontab -` as argv + stdin, with no shell.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const scheduler = require('../lib/scheduler');
const { buildCrontabPayload } = scheduler;

const CRON_LINE = '0 9 1 * * /bin/bash /home/user/aidr/run.sh';

// A crontab full of the shell metacharacters a real user legitimately has.
const HOSTILE_CRONTAB = [
  '# m h dom mon dow command',
  '0 3 * * * /usr/bin/backup --tag=$(date +\\%F)',
  '30 4 * * * /usr/bin/report --home=$HOME --host=`hostname`',
  '15 5 * * * /usr/bin/sync --path="/mnt/My Files" && echo done',
  'MAILTO=""',
  '',
].join('\n');

// ── 1. Preservation (pure) ───────────────────────────────────────────────────

test('command substitution in an existing line is preserved verbatim', () => {
  const out = buildCrontabPayload(HOSTILE_CRONTAB, CRON_LINE);
  assert.ok(
    out.includes('/usr/bin/backup --tag=$(date +\\%F)'),
    'the $(date +\\%F) line must survive unexpanded',
  );
  assert.ok(!/--tag=\\?\d{4}-\d{2}-\d{2}/.test(out), 'no date may be substituted');
});

test('backticks and $VAR in an existing line are preserved verbatim', () => {
  const out = buildCrontabPayload(HOSTILE_CRONTAB, CRON_LINE);
  assert.ok(out.includes('--home=$HOME --host=`hostname`'), '$HOME and `hostname` must survive unexpanded');
  assert.ok(!out.includes('--host=' + os.hostname()), 'the hostname must not be substituted');
});

test('quotes, spaces and && in an existing line are preserved verbatim', () => {
  const out = buildCrontabPayload(HOSTILE_CRONTAB, CRON_LINE);
  assert.ok(out.includes('--path="/mnt/My Files" && echo done'));
  assert.ok(out.includes('MAILTO=""'), 'crontab environment lines must survive');
});

test('every original line is still present, in order', () => {
  const out = buildCrontabPayload(HOSTILE_CRONTAB, CRON_LINE);
  const original = HOSTILE_CRONTAB.split('\n').filter(Boolean);
  const produced = out.split('\n').filter(Boolean);
  assert.deepEqual(produced.slice(0, original.length), original, 'prior content must be untouched and in order');
  assert.equal(produced[produced.length - 1], CRON_LINE, 'our line goes last');
});

test('our line is appended exactly once and the payload ends with a newline', () => {
  const out = buildCrontabPayload(HOSTILE_CRONTAB, CRON_LINE);
  assert.equal(out.split('\n').filter(l => l === CRON_LINE).length, 1);
  assert.ok(out.endsWith('\n'), 'cron silently drops a final line with no trailing newline');
});

test('an empty crontab yields just our line', () => {
  assert.equal(buildCrontabPayload('', CRON_LINE), CRON_LINE + '\n');
  assert.equal(buildCrontabPayload(null, CRON_LINE), CRON_LINE + '\n');
  assert.equal(buildCrontabPayload('\n\n', CRON_LINE), CRON_LINE + '\n');
});

test('trailing blank lines are collapsed, not multiplied', () => {
  const out = buildCrontabPayload('0 1 * * * /bin/true\n\n\n', CRON_LINE);
  assert.equal(out, '0 1 * * * /bin/true\n' + CRON_LINE + '\n');
});

// ── 2. No shell on the write path ────────────────────────────────────────────

function runCrontabInstall(outcome = { status: 0 }) {
  const calls = [];
  scheduler._setStdinRunner((cmd, args, input) => {
    calls.push({ cmd, args, input });
    return { status: outcome.status ?? 0, stderr: outcome.stderr || '' };
  });
  // installLinux prefers systemd; empty out PATH so `which systemctl` misses and
  // we land on the crontab branch.
  const realPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), 'aidr-empty-path-does-not-exist');
  let result;
  try {
    result = scheduler.installScheduleForPlatform({
      platform: 'linux',
      scriptPath: path.join(os.tmpdir(), 'aidr-run.sh'),
      logDir: os.tmpdir(),
    });
  } finally {
    process.env.PATH = realPath;
    scheduler._setStdinRunner(null);
  }
  return { result, calls };
}

test('_setStdinRunner and buildCrontabPayload are exported', () => {
  assert.equal(typeof scheduler._setStdinRunner, 'function');
  assert.equal(typeof scheduler.buildCrontabPayload, 'function');
});

test('the crontab is written as argv + stdin, never as a shell string', () => {
  const { calls } = runCrontabInstall();
  const write = calls.find(c => c.cmd === 'crontab');
  assert.ok(write, 'expected the installer to feed `crontab -` on stdin');
  assert.deepEqual(write.args, ['-'], 'crontab must be invoked as argv with the payload on stdin');
  assert.equal(typeof write.input, 'string');
  assert.ok(!write.input.startsWith('echo '), 'the payload must be the crontab, not a shell command line');
  assert.ok(!write.input.includes('| crontab'), 'no pipeline may appear in the payload');
});

test('the installer appends exactly one aidr entry', () => {
  const { calls, result } = runCrontabInstall();
  const write = calls.find(c => c.cmd === 'crontab');
  // The line now pins PATH (and may carry AIDR_* paths) before /bin/bash (CORE-13).
  const aidr = write.input.split('\n').filter(l => /^0 9 1 \* \* (\S+ )*\/bin\/bash /.test(l));
  assert.equal(aidr.length, 1, 'exactly one aidr entry, never duplicated');
  assert.equal(result.method, 'crontab');
});

test('a non-zero exit from crontab is surfaced with the manual fallback', () => {
  const { result } = runCrontabInstall({ status: 1, stderr: 'crontab: permission denied' });
  assert.match(result.detail, /permission denied|crontab error/i, 'the real failure must reach the user');
  assert.match(result.detail, /Manually add/i, 'and so must the manual workaround');
});

test('the hostile fixture still contains what these tests assume', () => {
  assert.ok(HOSTILE_CRONTAB.includes('$(date'));
  assert.ok(HOSTILE_CRONTAB.includes('`hostname`'));
  assert.ok(HOSTILE_CRONTAB.includes('$HOME'));
});
