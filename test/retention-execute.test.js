/**
 * test/retention-execute.test.js
 *
 * R6: executePurge deletes what planPurge listed. The plan can be stale (a file
 * replaced by a symlink between plan and delete) or hand-built, so executePurge
 * re-checks every entry itself and refuses anything that is not a regular file
 * with a known artifact name.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planPurge, executePurge, purgeArtifacts } = require('../lib/retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-29T12:00:00Z');
const SKIP_SYMLINKS = process.platform === 'win32';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-retention-exec-'));
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

const OLD_LOG = 'run-2025-01-10T09-00-00.json';
const NEW_LOG = 'run-2026-10-01T09-00-00.json';

function populated() {
  const t = tree();
  put(path.join(t.logs, NEW_LOG), { daysOld: 28 });
  put(path.join(t.logs, 'audit-2026-10-01T09-00-00.md'), { daysOld: 28 });
  put(path.join(t.logs, OLD_LOG), { daysOld: 300, size: 100 });
  put(path.join(t.dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'), { daysOld: 300, size: 4000 });
  put(path.join(t.dirs.reports, 'report-2025-01-31.pdf'), { daysOld: 270, size: 9000 });
  put(path.join(t.logs, 'complaints', 'complaint-spokeo-2025-01-10.txt'), { daysOld: 800 });
  put(path.join(t.logs, 'state.json'), { daysOld: 800 });
  return t;
}

test('deletes exactly the planned files and reports what went', () => {
  const { logs, dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  const result = executePurge(plan);

  assert.equal(result.dryRun, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.deleted.length, 3);
  assert.equal(result.bytes, 100 + 4000 + 9000);
  assert.deepEqual(result.deleted.map(item => item.kind).sort(), ['report', 'run-log', 'snapshot']);

  assert.ok(!fs.existsSync(path.join(logs, OLD_LOG)));
  assert.ok(!fs.existsSync(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png')));
  assert.ok(!fs.existsSync(path.join(dirs.reports, 'report-2025-01-31.pdf')));
  // Survivors: the latest run + audit, complaints, state, and the directories themselves.
  assert.ok(fs.existsSync(path.join(logs, NEW_LOG)));
  assert.ok(fs.existsSync(path.join(logs, 'audit-2026-10-01T09-00-00.md')));
  assert.ok(fs.existsSync(path.join(logs, 'complaints', 'complaint-spokeo-2025-01-10.txt')));
  assert.ok(fs.existsSync(path.join(logs, 'state.json')));
  assert.ok(fs.statSync(dirs.snapshots).isDirectory());
  assert.ok(fs.statSync(dirs.reports).isDirectory());
});

test('a dry run deletes nothing but returns the same list and byte count', () => {
  const { logs, dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  const dry = executePurge(plan, { dryRun: true });

  assert.equal(dry.dryRun, true);
  assert.equal(dry.deleted.length, 3);
  assert.equal(dry.bytes, 13100);
  assert.deepEqual(dry.errors, []);
  assert.ok(fs.existsSync(path.join(logs, OLD_LOG)));
  assert.ok(fs.existsSync(path.join(dirs.reports, 'report-2025-01-31.pdf')));

  const real = executePurge(plan);
  assert.deepEqual(real.deleted, dry.deleted);
  assert.equal(real.bytes, dry.bytes);
});

test('an empty plan is a quiet no-op', () => {
  assert.deepEqual(executePurge([]), { dryRun: false, deleted: [], bytes: 0, errors: [] });
  assert.deepEqual(executePurge([], { dryRun: true }), { dryRun: true, deleted: [], bytes: 0, errors: [] });
});

test('one failed delete is recorded and the rest still go', () => {
  const { dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  const stuck = plan.find(item => item.kind === 'snapshot').path;
  const flaky = {
    ...fs,
    unlinkSync(target) {
      if (target === stuck) throw Object.assign(new Error(`EACCES: permission denied, unlink '${target}'`), { code: 'EACCES' });
      return fs.unlinkSync(target);
    },
  };
  const result = executePurge(plan, { fs: flaky });

  assert.equal(result.deleted.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, stuck);
  assert.match(result.errors[0].error, /EACCES/);
  assert.equal(result.bytes, 100 + 9000, 'bytes counts only what was actually freed');
  assert.ok(fs.existsSync(stuck));
});

test('a file that vanished since planning is skipped, not an error', () => {
  const { logs, dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  fs.unlinkSync(path.join(logs, OLD_LOG));
  const result = executePurge(plan);
  assert.deepEqual(result.errors, []);
  assert.equal(result.deleted.length, 2);
});

test('a plan entry swapped for a symlink after planning is refused and its target survives', { skip: SKIP_SYMLINKS }, () => {
  const { root, logs, dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  const target = put(path.join(root, 'precious.txt'), { daysOld: 1 });
  fs.unlinkSync(path.join(logs, OLD_LOG));
  fs.symlinkSync(target, path.join(logs, OLD_LOG));

  const result = executePurge(plan);
  assert.ok(fs.existsSync(target), 'the symlink target must not be deleted');
  assert.ok(fs.lstatSync(path.join(logs, OLD_LOG)).isSymbolicLink(), 'the link itself is left alone too');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /not a regular file/);
  assert.equal(result.deleted.length, 2);
});

test('a plan entry swapped for a directory is refused: only files are ever deleted', () => {
  const { logs, dirs } = populated();
  const plan = planPurge({ dirs, olderThanDays: 90, now: NOW });
  fs.unlinkSync(path.join(logs, OLD_LOG));
  fs.mkdirSync(path.join(logs, OLD_LOG));
  fs.writeFileSync(path.join(logs, OLD_LOG, 'inside.txt'), 'keep me');

  const result = executePurge(plan);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /not a regular file/);
  assert.equal(fs.readFileSync(path.join(logs, OLD_LOG, 'inside.txt'), 'utf8'), 'keep me');
});

test('a hand-built plan naming state, config or a complaint is refused', () => {
  const { logs } = populated();
  const config = put(path.join(logs, 'config.json'), { daysOld: 900 });
  const complaint = path.join(logs, 'complaints', 'complaint-spokeo-2025-01-10.txt');
  const state = path.join(logs, 'state.json');
  const plan = [config, complaint, state].map(file => ({ path: file, kind: 'run-log', ageDays: 900, bytes: 10 }));

  const result = executePurge(plan);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.errors.length, 3);
  for (const item of result.errors) assert.match(item.error, /not a purgeable/);
  for (const file of [config, complaint, state]) assert.ok(fs.existsSync(file), file);
});

test('an entry with an unknown kind, a relative path or no path is refused', () => {
  const { logs } = populated();
  const real = path.join(logs, OLD_LOG);
  const result = executePurge([
    { path: real, kind: 'everything', ageDays: 1, bytes: 1 },
    { path: path.relative(process.cwd(), real), kind: 'run-log', ageDays: 1, bytes: 1 },
    { kind: 'run-log' },
    null,
  ]);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.errors.length, 4);
  assert.ok(fs.existsSync(real));
});

test('with dirs given, an entry outside them is refused even when its name is a known pattern', () => {
  const { root, dirs } = populated();
  fs.mkdirSync(path.join(root, 'elsewhere'));
  const outside = put(path.join(root, 'elsewhere', OLD_LOG), { daysOld: 900 });
  const plan = [{ path: outside, kind: 'run-log', ageDays: 900, bytes: 10 }];

  const refused = executePurge(plan, { dirs });
  assert.equal(refused.deleted.length, 0);
  assert.match(refused.errors[0].error, /outside/);
  assert.ok(fs.existsSync(outside));

  const trusted = executePurge(plan);
  assert.equal(trusted.deleted.length, 1, 'without dirs the name check alone applies');
});

test('a dry run refuses the same entries a real run would', () => {
  const { logs } = populated();
  const config = put(path.join(logs, 'config.json'), { daysOld: 900 });
  const result = executePurge([{ path: config, kind: 'run-log', ageDays: 900, bytes: 10 }], { dryRun: true });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.errors.length, 1);
});

test('purgeArtifacts plans and executes in one call, validating the age first', () => {
  const { logs, dirs } = populated();
  const dry = purgeArtifacts({ dirs, olderThanDays: 90, now: NOW, dryRun: true });
  assert.equal(dry.olderThanDays, 90);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.deleted.length, 3);
  assert.ok(fs.existsSync(path.join(logs, OLD_LOG)));

  const real = purgeArtifacts({ dirs, olderThanDays: 90, now: NOW });
  assert.equal(real.deleted.length, 3);
  assert.ok(!fs.existsSync(path.join(logs, OLD_LOG)));

  assert.throws(() => purgeArtifacts({ dirs, olderThanDays: 3, now: NOW }), /at least 7 days/);
});

test('purgeArtifacts never deletes the files named in keep', () => {
  const { logs, dirs } = populated();
  const mine = put(path.join(logs, 'run-2025-06-10T09-00-00.json'), { daysOld: 300 });
  const result = purgeArtifacts({ dirs, olderThanDays: 90, now: NOW, keep: [mine] });
  assert.ok(fs.existsSync(mine));
  assert.ok(!result.deleted.some(item => item.path === mine));
});
