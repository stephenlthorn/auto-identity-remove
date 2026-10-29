/**
 * test/retention-apply.test.js
 *
 * R6: `retention.days` in config.json turns on automatic purging at the end of
 * a successful run. It is OFF unless the key is present and valid, so everyone
 * who has not asked for it keeps every file forever, exactly as before. A bad
 * value never deletes anything: it is reported and ignored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyRetention, retentionDaysFromConfig, defaultDirs } = require('../lib/retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-29T12:00:00Z');
const EXAMPLE = path.join(__dirname, '..', 'config.example.json');

function populated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-retention-apply-'));
  const logs = path.join(root, 'logs');
  const dirs = { logs, snapshots: path.join(logs, 'snapshots'), reports: path.join(logs, 'reports') };
  fs.mkdirSync(dirs.snapshots, { recursive: true });
  fs.mkdirSync(dirs.reports, { recursive: true });
  fs.mkdirSync(path.join(logs, 'complaints'), { recursive: true });
  const put = (file, daysOld) => {
    fs.writeFileSync(file, 'x'.repeat(100));
    const seconds = (NOW.getTime() - daysOld * DAY) / 1000;
    fs.utimesSync(file, seconds, seconds);
    return file;
  };
  const files = {
    newLog: put(path.join(logs, 'run-2026-10-28T09-00-00.json'), 1),
    newAudit: put(path.join(logs, 'audit-2026-10-28T09-00-00.md'), 1),
    oldLog: put(path.join(logs, 'run-2025-01-10T09-00-00.json'), 300),
    oldSnap: put(path.join(dirs.snapshots, 'spokeo-2025-01-10T09-00-00-123Z.png'), 300),
    youngSnap: put(path.join(dirs.snapshots, 'spokeo-2026-10-01T09-00-00-123Z.png'), 28),
    complaint: put(path.join(logs, 'complaints', 'complaint-spokeo-2025-01-10.txt'), 700),
  };
  return { dirs, files };
}

// ── reading the config ───────────────────────────────────────────────────────

test('no retention block, an empty one, or a null/blank days means retention is off', () => {
  for (const config of [{}, { retention: {} }, { retention: { days: null } }, { retention: { days: '' } },
    { retention: { _comment: 'only a comment' } }, { retention: null }, null, undefined]) {
    assert.deepEqual(retentionDaysFromConfig(config), { days: null }, JSON.stringify(config));
  }
});

test('days accepts a number or the same text as --older-than', () => {
  assert.deepEqual(retentionDaysFromConfig({ retention: { days: 180 } }), { days: 180 });
  assert.deepEqual(retentionDaysFromConfig({ retention: { days: '180d' } }), { days: 180 });
  assert.deepEqual(retentionDaysFromConfig({ retention: { days: '6m' } }), { days: 180 });
  assert.deepEqual(retentionDaysFromConfig({ retention: { days: '1y' } }), { days: 365 });
});

test('a bad value turns retention off and says why, naming the key', () => {
  for (const days of [3, '3d', 0, -30, 1.5, 'soon', true, false, [], {}]) {
    const out = retentionDaysFromConfig({ retention: { days } });
    assert.equal(out.days, null, `days ${JSON.stringify(days)}`);
    assert.match(out.problem, /^retention\.days: /, `days ${JSON.stringify(days)}`);
  }
  for (const retention of ['180d', 180, [], true]) {
    const out = retentionDaysFromConfig({ retention });
    assert.equal(out.days, null);
    assert.match(out.problem, /^retention must be an object/);
  }
});

test('the shipped config.example.json documents retention but does not switch it on', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.equal(typeof example.retention._comment, 'string');
  assert.match(example.retention._comment, /forever/i);
  assert.match(example.retention._comment, /"days"/);
  assert.match(example.retention._comment, /complaint/i);
  assert.match(example.retention._comment, /7 days/);
  assert.deepEqual(retentionDaysFromConfig(example), { days: null });
  assert.equal('days' in example.retention, false, 'an example that sets days would enable purging for everyone who copies it');
});

// ── applying it at the end of a run ──────────────────────────────────────────

test('with retention off nothing is scanned or deleted and nothing is printed', () => {
  const { dirs, files } = populated();
  for (const config of [{}, { retention: {} }]) {
    const out = applyRetention({ config, dirs, now: NOW });
    assert.equal(out.status, 'disabled');
    assert.deepEqual(out.lines, []);
  }
  for (const file of Object.values(files)) assert.ok(fs.existsSync(file), file);
});

test('with retention.days set it purges old artifacts and keeps the latest run and complaints', () => {
  const { dirs, files } = populated();
  const out = applyRetention({ config: { retention: { days: 180 } }, dirs, now: NOW });

  assert.equal(out.status, 'purged');
  assert.equal(out.result.deleted.length, 2);
  assert.ok(!fs.existsSync(files.oldLog));
  assert.ok(!fs.existsSync(files.oldSnap));
  for (const keep of [files.newLog, files.newAudit, files.youngSnap, files.complaint]) assert.ok(fs.existsSync(keep), keep);
  assert.match(out.lines[0], /retention/i);
  assert.match(out.lines.join('\n'), /Deleted 2 files/);
});

test('a run with nothing old enough prints nothing, so a monthly run stays quiet', () => {
  const { dirs } = populated();
  const out = applyRetention({ config: { retention: { days: '2y' } }, dirs, now: NOW });
  assert.equal(out.status, 'purged');
  assert.equal(out.result.deleted.length, 0);
  assert.deepEqual(out.lines, []);
});

test('a dry run never purges, even with retention.days set', () => {
  const { dirs, files } = populated();
  const out = applyRetention({ config: { retention: { days: 180 } }, dirs, now: NOW, dryRun: true });
  assert.equal(out.status, 'dry-run');
  assert.deepEqual(out.lines, []);
  assert.ok(fs.existsSync(files.oldLog));
  assert.ok(fs.existsSync(files.oldSnap));
});

test('an invalid retention.days deletes nothing and reports why', () => {
  const { dirs, files } = populated();
  for (const days of [3, 'soon', 0, true]) {
    const out = applyRetention({ config: { retention: { days } }, dirs, now: NOW });
    assert.equal(out.status, 'invalid', `days ${String(days)}`);
    assert.match(out.lines.join('\n'), /retention\.days/);
    assert.match(out.lines.join('\n'), /no files were purged/i);
  }
  for (const file of Object.values(files)) assert.ok(fs.existsSync(file), file);
});

test('keep protects the caller\'s files even when they are old', () => {
  const { dirs, files } = populated();
  applyRetention({ config: { retention: { days: 180 } }, dirs, now: NOW, keep: [files.oldLog] });
  assert.ok(fs.existsSync(files.oldLog));
  assert.ok(!fs.existsSync(files.oldSnap));
});

test('a failure while purging is reported, not thrown: a finished run must still exit cleanly', () => {
  const { dirs } = populated();
  const broken = { ...fs, readdirSync() { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } };
  const out = applyRetention({ config: { retention: { days: 180 } }, dirs, now: NOW, fs: broken });
  assert.equal(out.status, 'error');
  assert.match(out.lines.join('\n'), /retention skipped/i);
  assert.match(out.lines.join('\n'), /EIO/);
});

test('per-file delete errors surface in the lines of an otherwise successful purge', () => {
  const { dirs, files } = populated();
  const flaky = {
    ...fs,
    unlinkSync(target) {
      if (target === files.oldSnap) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.unlinkSync(target);
    },
  };
  const out = applyRetention({ config: { retention: { days: 180 } }, dirs, now: NOW, fs: flaky });
  assert.equal(out.status, 'purged');
  assert.equal(out.result.errors.length, 1);
  assert.match(out.lines.join('\n'), /spokeo-2025-01-10T09-00-00-123Z\.png: EPERM/);
});

// ── default locations ────────────────────────────────────────────────────────

test('defaultDirs names logs, snapshots and reports as absolute paths', () => {
  const dirs = defaultDirs({});
  for (const key of ['logs', 'snapshots', 'reports']) {
    assert.equal(typeof dirs[key], 'string', key);
    assert.ok(path.isAbsolute(dirs[key]), key);
  }
  assert.notEqual(path.basename(dirs.logs), 'complaints');
});

// ── which age `aidr purge` uses ──────────────────────────────────────────────

const { resolvePurgeAge, DEFAULT_PURGE_DAYS } = require('../lib/retention');

test('--older-than wins over everything and is parsed like retention.days', () => {
  const loadConfig = () => { throw new Error('must not be read when a flag was given'); };
  assert.deepEqual(resolvePurgeAge({ olderThan: '6m', loadConfig }), { days: 180, source: 'flag' });
  assert.deepEqual(resolvePurgeAge({ olderThan: '30' }), { days: 30, source: 'flag' });
});

test('--older-than under a week throws unless force, so the CLI can exit 2 with the reason', () => {
  assert.throws(() => resolvePurgeAge({ olderThan: '3d' }), /at least 7 days/);
  assert.deepEqual(resolvePurgeAge({ olderThan: '3d', force: true }), { days: 3, source: 'flag' });
  assert.throws(() => resolvePurgeAge({ olderThan: 'soon' }), /cannot read age/);
});

test('without a flag it uses retention.days from the config', () => {
  const loadConfig = () => ({ retention: { days: '90d' } });
  assert.deepEqual(resolvePurgeAge({ loadConfig }), { days: 90, source: 'config' });
});

test('without a flag or a configured age it falls back to 180 days', () => {
  assert.equal(DEFAULT_PURGE_DAYS, 180);
  assert.deepEqual(resolvePurgeAge({ loadConfig: () => ({}) }), { days: 180, source: 'default' });
  assert.deepEqual(resolvePurgeAge({}), { days: 180, source: 'default' });
});

test('an unreadable config does not stop a purge: default age plus a note saying why', () => {
  const locked = resolvePurgeAge({ loadConfig: () => { throw Object.assign(new Error('passphrase needed'), { code: 'ENCRYPTED' }); } });
  assert.equal(locked.days, 180);
  assert.equal(locked.source, 'default');
  assert.match(locked.note, /config not read/i);
  assert.match(locked.note, /180 days/);
});

test('an invalid retention.days falls back to the default and says so, never to a guess', () => {
  const out = resolvePurgeAge({ loadConfig: () => ({ retention: { days: 3 } }) });
  assert.equal(out.days, 180);
  assert.equal(out.source, 'default');
  assert.match(out.note, /retention\.days/);
});
