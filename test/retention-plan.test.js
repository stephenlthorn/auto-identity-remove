/**
 * test/retention-plan.test.js
 *
 * R6: planPurge decides which PII artifacts are old enough to delete. A purge
 * cannot be undone, so most of these tests are about what must SURVIVE: the
 * newest run, complaints, state/config/lock/checkpoint, symlinks, unknown
 * names and anything outside the directories it was handed.
 *
 * Every test builds its own temp tree with files aged by utimes against an
 * injected `now`. Nothing here touches the repo's real logs/.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planPurge } = require('../lib/retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-29T12:00:00Z');
const SKIP_SYMLINKS = process.platform === 'win32';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-retention-plan-'));
  const logs = path.join(root, 'logs');
  const dirs = { logs, snapshots: path.join(logs, 'snapshots'), reports: path.join(logs, 'reports') };
  fs.mkdirSync(dirs.snapshots, { recursive: true });
  fs.mkdirSync(dirs.reports, { recursive: true });
  fs.mkdirSync(path.join(logs, 'complaints'), { recursive: true });
  return { root, logs, dirs };
}

function put(file, { daysOld, size = 10 }) {
  fs.writeFileSync(file, 'x'.repeat(size));
  const seconds = (NOW.getTime() - daysOld * DAY) / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function names(plan) {
  return plan.map(item => path.basename(item.path)).sort();
}

const RUN_OLD = 'run-2025-01-10T09-00-00';
const RUN_MID = 'run-2025-06-10T09-00-00';
const RUN_NEW = 'run-2026-10-01T09-00-00';

test('missing directories plan nothing instead of throwing', () => {
  const { root } = tree();
  const gone = path.join(root, 'nope');
  assert.deepEqual(
    planPurge({ dirs: { logs: gone, snapshots: gone, reports: gone }, olderThanDays: 30, now: NOW }), []);
});

test('plans old run logs, journals, audit reports, snapshots and report PDFs with kind, age and size', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 300, size: 100 });
  put(path.join(logs, `${RUN_OLD}.jsonl`), { daysOld: 300, size: 50 });
  put(path.join(logs, 'audit-2025-01-10T09-00-00.md'), { daysOld: 300, size: 20 });
  put(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 300, size: 4000 });
  put(path.join(dirs.reports, 'report-2025-01-31.pdf'), { daysOld: 270, size: 9000 });
  // The newest run and its audit, so the old ones above are not "the latest run".
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 28 });
  put(path.join(logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 28 });

  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  const byName = Object.fromEntries(plan.map(item => [path.basename(item.path), item]));

  assert.deepEqual(names(plan), [
    'audit-2025-01-10T09-00-00.md',
    'report-2025-01-31.pdf',
    `${RUN_OLD}.json`,
    `${RUN_OLD}.jsonl`,
    'spokeo-2025-01-10T09-00-00-123Z.png',
  ].sort());
  assert.equal(byName[`${RUN_OLD}.json`].kind, 'run-log');
  assert.equal(byName[`${RUN_OLD}.jsonl`].kind, 'run-log');
  assert.equal(byName['audit-2025-01-10T09-00-00.md'].kind, 'audit');
  assert.equal(byName['spokeo-2025-01-10T09-00-00-123Z.png'].kind, 'snapshot');
  assert.equal(byName['report-2025-01-31.pdf'].kind, 'report');
  assert.equal(byName[`${RUN_OLD}.json`].ageDays, 300);
  assert.equal(byName[`${RUN_OLD}.json`].bytes, 100);
  assert.equal(byName['report-2025-01-31.pdf'].bytes, 9000);
  assert.equal(byName[`${RUN_OLD}.json`].path, path.join(logs, `${RUN_OLD}.json`));
});

test('a file exactly as old as the cutoff is kept: only strictly older files go', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 90 });
  put(path.join(logs, `${RUN_MID}.json`), { daysOld: 90.01 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });

  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 90, now: NOW })), [`${RUN_MID}.json`]);
});

test('younger files are kept', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 10 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 5 });
  put(path.join(dirs.snapshots, 'spokeo-2026-10-20T09-00-00-123Z.png'), { daysOld: 9 });
  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

test('a file dated in the future is never purged', () => {
  const { logs, dirs } = tree();
  put(path.join(dirs.snapshots, 'spokeo-2099-01-01T00-00-00-000Z.png'), { daysOld: -400 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

// ── the latest run is always kept ────────────────────────────────────────────

test('the newest run log, its journal and its audit report survive however old they are', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, `${RUN_OLD}.jsonl`), { daysOld: 400 });
  put(path.join(logs, 'audit-2025-01-10T09-00-00.md'), { daysOld: 400 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 380 });
  put(path.join(logs, `${RUN_NEW}.jsonl`), { daysOld: 380 });
  put(path.join(logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 380 });

  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW })), [
    'audit-2025-01-10T09-00-00.md', `${RUN_OLD}.json`, `${RUN_OLD}.jsonl`,
  ].sort());
});

test('a crashed latest run (journal only, no summary, no audit) is still the latest run', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, 'audit-2025-01-10T09-00-00.md'), { daysOld: 400 });
  put(path.join(logs, `${RUN_NEW}.jsonl`), { daysOld: 380 });

  const planned = names(planPurge({ dirs, olderThanDays: 30, now: NOW }));
  assert.ok(!planned.includes(`${RUN_NEW}.jsonl`), 'the newest journal must stay');
  assert.ok(planned.includes(`${RUN_OLD}.json`));
});

test('the newest audit report stays even when its stamp differs from the newest run log by a second', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, 'audit-2025-01-10T09-00-00.md'), { daysOld: 400 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 380 });
  put(path.join(logs, 'audit-2026-10-01T09-00-01.md'), { daysOld: 380 });

  const planned = names(planPurge({ dirs, olderThanDays: 30, now: NOW }));
  assert.ok(!planned.includes('audit-2026-10-01T09-00-01.md'));
  assert.ok(planned.includes('audit-2025-01-10T09-00-00.md'));
});

test('legacy date-only names are recognised, and ordered against full stamps', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, 'run-2024-12-31.json'), { daysOld: 500 });
  put(path.join(logs, 'audit-2024-12-31.md'), { daysOld: 500 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 380 });
  put(path.join(logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 380 });
  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW })),
    ['audit-2024-12-31.md', 'run-2024-12-31.json']);
});

test('with only one run log on disk it is the latest run and stays', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 900 });
  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

// ── things that are never purged ─────────────────────────────────────────────

test('complaints are never purged, in the logs dir or as a dir of their own', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  put(path.join(logs, 'complaints', 'complaint-spokeo-2025-01-10.txt'), { daysOld: 800 });
  put(path.join(logs, 'complaints', 'report-2025-01-10.pdf'), { daysOld: 800 });
  put(path.join(logs, 'complaint-spokeo-2025-01-10.pdf'), { daysOld: 800 });

  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW })), [`${RUN_OLD}.json`]);
  assert.throws(
    () => planPurge({ dirs: { ...dirs, reports: path.join(logs, 'complaints') }, olderThanDays: 30, now: NOW }),
    /complaints/);
});

test('state, config, lock, checkpoint, heartbeat and other unknown names are never planned', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  const keepers = [
    'state.json', 'state.json.bak', 'state.json.lock', 'state.json.checkpoint', 'config.json',
    'config.json.enc', 'last-run.json', 'notes.txt', 'run-latest.json', 'run-.json', 'run-2025-01-10.txt',
    'audit-notes.md', 'audit-2025-01-10T09-00-00.md.bak', 'RUN-2025-01-10T09-00-00.json',
    'run-2025-01-10T09-00-00.json.tmp', 'run-2025-01-10T09-00-00.json.1234.abcd.tmp',
  ];
  for (const name of keepers) put(path.join(logs, name), { daysOld: 2000 });
  put(path.join(dirs.snapshots, 'notes.txt'), { daysOld: 2000 });
  put(path.join(dirs.snapshots, 'spokeo-2025-01-10.png'), { daysOld: 2000 });
  put(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png.tmp'), { daysOld: 2000 });
  put(path.join(dirs.reports, 'report-latest.pdf'), { daysOld: 2000 });
  put(path.join(dirs.reports, 'report-2025-01-31.html'), { daysOld: 2000 });

  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

test('each kind is only recognised in its own directory', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  put(path.join(dirs.snapshots, `${RUN_OLD}.json`), { daysOld: 900 });
  put(path.join(dirs.reports, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 900 });
  put(path.join(logs, 'report-2025-01-31.pdf'), { daysOld: 900 });
  put(path.join(logs, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 900 });
  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

test('files in subdirectories, and in sibling directories that were not handed over, are never planned', () => {
  const { root, logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  fs.mkdirSync(path.join(logs, 'archive'));
  put(path.join(logs, 'archive', `${RUN_OLD}.json`), { daysOld: 900 });
  fs.mkdirSync(path.join(root, 'elsewhere'));
  put(path.join(root, 'elsewhere', `${RUN_OLD}.json`), { daysOld: 900 });
  // A directory that merely looks like an old log is not a file.
  fs.mkdirSync(path.join(logs, `${RUN_MID}.json`));

  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

test('a symlink that looks like an old log is never planned and its target is untouched', { skip: SKIP_SYMLINKS }, () => {
  const { root, logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  const target = put(path.join(root, 'precious.txt'), { daysOld: 900 });
  fs.symlinkSync(target, path.join(logs, `${RUN_OLD}.json`));
  fs.symlinkSync(target, path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'));
  fs.symlinkSync(path.join(root, 'elsewhere-dir'), path.join(dirs.reports, 'report-2025-01-31.pdf'));

  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
  assert.ok(fs.existsSync(target));
});

test('a symlink or directory with the newest stamp does not demote the real latest run', { skip: SKIP_SYMLINKS }, () => {
  const { root, logs, dirs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 900 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 800 });
  const target = put(path.join(root, 'anything.txt'), { daysOld: 1 });
  fs.symlinkSync(target, path.join(logs, 'run-2030-01-01T00-00-00.json'));
  fs.mkdirSync(path.join(logs, 'run-2031-01-01T00-00-00.json'));
  fs.symlinkSync(target, path.join(logs, 'audit-2030-01-01T00-00-00.md'));
  put(path.join(logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 800 });

  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW })), [`${RUN_OLD}.json`]);
});

test('a symlinked subdirectory is not descended into', { skip: SKIP_SYMLINKS }, () => {
  const { root, logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  put(path.join(outside, `${RUN_OLD}.json`), { daysOld: 900 });
  fs.symlinkSync(outside, path.join(logs, 'linked'));

  assert.deepEqual(planPurge({ dirs, olderThanDays: 30, now: NOW }), []);
});

test('keep protects the caller\'s own files by absolute path', () => {
  const { logs, dirs } = tree();
  const current = put(path.join(logs, `${RUN_MID}.json`), { daysOld: 400 });
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });

  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW, keep: [current] })), [`${RUN_OLD}.json`]);
  assert.deepEqual(names(planPurge({ dirs, olderThanDays: 30, now: NOW, keep: [path.relative(process.cwd(), current)] })),
    [`${RUN_OLD}.json`]);
});

// ── shape and validation ─────────────────────────────────────────────────────

test('the plan is sorted by kind then path, so output is stable', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  put(path.join(logs, `${RUN_MID}.json`), { daysOld: 400 });
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  put(path.join(logs, 'audit-2025-01-10T09-00-00.md'), { daysOld: 400 });
  put(path.join(logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 1 });
  put(path.join(dirs.snapshots, 'b-2025-01-10T09-00-00-123Z.png'), { daysOld: 400 });
  put(path.join(dirs.snapshots, 'a-2025-01-10T09-00-00-123Z.png'), { daysOld: 400 });
  put(path.join(dirs.reports, 'report-2025-01-31.pdf'), { daysOld: 400 });

  const plan = planPurge({ dirs, olderThanDays: 30, now: NOW });
  assert.deepEqual(plan.map(item => `${item.kind}:${path.basename(item.path)}`), [
    `run-log:${RUN_OLD}.json`,
    `run-log:${RUN_MID}.json`,
    'audit:audit-2025-01-10T09-00-00.md',
    'snapshot:a-2025-01-10T09-00-00-123Z.png',
    'snapshot:b-2025-01-10T09-00-00-123Z.png',
    'report:report-2025-01-31.pdf',
  ]);
});

test('the same directory handed over twice does not list a file twice', () => {
  const { logs, dirs } = tree();
  put(path.join(logs, `${RUN_NEW}.json`), { daysOld: 1 });
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  const plan = planPurge({ dirs: { logs, snapshots: logs, reports: dirs.reports }, olderThanDays: 30, now: NOW });
  assert.deepEqual(names(plan), [`${RUN_OLD}.json`]);
});

test('a dir the caller omits is simply not scanned', () => {
  const { dirs } = tree();
  put(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 400 });
  assert.deepEqual(names(planPurge({ dirs: { snapshots: dirs.snapshots }, olderThanDays: 30, now: NOW })),
    ['spokeo-2025-01-10T09-00-00-123Z.png']);
});

test('now may be a Date or epoch milliseconds', () => {
  const { dirs } = tree();
  put(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 400 });
  assert.equal(planPurge({ dirs, olderThanDays: 30, now: NOW.getTime() }).length, 1);
});

test('olderThanDays must be a whole number of at least 7 unless force is passed', () => {
  const { dirs } = tree();
  for (const bad of [undefined, null, NaN, Infinity, -1, 0, 1.5, '30', 6]) {
    assert.throws(() => planPurge({ dirs, olderThanDays: bad, now: NOW }), /age|days/i, `olderThanDays ${String(bad)}`);
  }
  put(path.join(dirs.snapshots, 'spokeo-2026-10-27T09-00-00-123Z.png'), { daysOld: 2 });
  assert.equal(planPurge({ dirs, olderThanDays: 1, now: NOW, force: true }).length, 1);
});

test('an unreadable directory is an error, not an empty plan that hides the problem', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const { logs } = tree();
  put(path.join(logs, `${RUN_OLD}.json`), { daysOld: 400 });
  fs.chmodSync(logs, 0o000);
  try {
    assert.throws(() => planPurge({ dirs: { logs }, olderThanDays: 30, now: NOW }), /EACCES/);
  } finally {
    fs.chmodSync(logs, 0o700);
  }
});
