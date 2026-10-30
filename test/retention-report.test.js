/**
 * test/retention-report.test.js
 *
 * R6: formatPurgeReport turns a purge result into plain lines for the terminal
 * or the run output. It is read by a person and ends up in logs, so it carries
 * counts, sizes and file NAMES only - never file contents, never the directory
 * path (which contains the user's home directory name).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { formatPurgeReport } = require('../lib/retention');

const MB = 1024 * 1024;
const HOME_DIR = path.join(path.sep, 'Users', 'jane-doe', 'aidr', 'logs');

function entry(kind, name, bytes, ageDays = 200) {
  const dir = kind === 'snapshot' ? path.join(HOME_DIR, 'snapshots') : HOME_DIR;
  return { path: path.join(dir, name), kind, bytes, ageDays };
}

const RESULT = {
  dryRun: false,
  olderThanDays: 180,
  bytes: 5 * MB + 512 * 1024,
  errors: [],
  deleted: [
    entry('run-log', 'run-2025-01-10T09-00-00.json', MB),
    entry('run-log', 'run-2025-01-10T09-00-00.jsonl', MB),
    entry('audit', 'audit-2025-01-10T09-00-00.md', 20 * 1024),
    entry('snapshot', 'spokeo-2025-01-10T09-00-00-123Z.png', 3 * MB),
    entry('report', 'report-2025-01-31.pdf', 512 * 1024 - 20 * 1024),
  ],
};

test('prints a headline with the total count, MB freed and the age', () => {
  const lines = formatPurgeReport(RESULT);
  assert.ok(Array.isArray(lines));
  assert.match(lines[0], /deleted 5 files/i);
  assert.match(lines[0], /5\.5 MB/);
  assert.match(lines[0], /180 days/);
});

test('a dry run says it would delete and says nothing was changed', () => {
  const lines = formatPurgeReport({ ...RESULT, dryRun: true });
  assert.match(lines[0], /would delete 5 files/i);
  assert.doesNotMatch(lines[0], /^deleted/i);
  assert.ok(lines.some(line => /dry run/i.test(line) && /nothing was deleted/i.test(line)));
});

test('counts per kind, with a size each', () => {
  const text = formatPurgeReport(RESULT).join('\n');
  assert.match(text, /run logs: 2 files, 2\.0 MB/);
  assert.match(text, /audit reports: 1 file, 20 KB/);
  assert.match(text, /snapshots: 1 file, 3\.0 MB/);
  assert.match(text, /monthly reports: 1 file, 492 KB/);
});

test('kinds with nothing in them are left out', () => {
  const text = formatPurgeReport({ ...RESULT, deleted: [RESULT.deleted[3]], bytes: 3 * MB }).join('\n');
  assert.match(text, /snapshots: 1 file/);
  assert.doesNotMatch(text, /run logs|audit reports|monthly reports/);
});

test('nothing to purge says so, with the age', () => {
  const lines = formatPurgeReport({ dryRun: false, deleted: [], bytes: 0, errors: [], olderThanDays: 90 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /nothing to purge/i);
  assert.match(lines[0], /90 days/);
});

test('errors are listed by file name and reason, not by full path', () => {
  const lines = formatPurgeReport({
    ...RESULT,
    errors: [{ path: path.join(HOME_DIR, 'run-2025-02-10T09-00-00.json'), error: 'EACCES' }],
  });
  const text = lines.join('\n');
  assert.match(text, /1 file could not be deleted/i);
  assert.match(text, /run-2025-02-10T09-00-00\.json: EACCES/);
});

test('the report never contains a directory path', () => {
  const text = formatPurgeReport({
    ...RESULT,
    errors: [{ path: path.join(HOME_DIR, 'run-2025-02-10T09-00-00.json'), error: 'EACCES' }],
  }, { listFiles: true }).join('\n');
  assert.doesNotMatch(text, /jane-doe/);
  assert.doesNotMatch(text, /Users/);
});

test('files are only listed when asked for, by name', () => {
  assert.doesNotMatch(formatPurgeReport(RESULT).join('\n'), /spokeo-2025/);
  const text = formatPurgeReport(RESULT, { listFiles: true }).join('\n');
  assert.match(text, /spokeo-2025-01-10T09-00-00-123Z\.png/);
  assert.match(text, /run-2025-01-10T09-00-00\.json/);
});

test('an entry with an unknown kind still counts, under its own name', () => {
  const text = formatPurgeReport({
    dryRun: false, olderThanDays: 90, bytes: 10, errors: [],
    deleted: [{ path: path.join(HOME_DIR, 'x'), kind: 'mystery', bytes: 10, ageDays: 100 }],
  }).join('\n');
  assert.match(text, /mystery: 1 file/);
});

test('a result with only errors still reports them', () => {
  const lines = formatPurgeReport({
    dryRun: false, deleted: [], bytes: 0, olderThanDays: 90,
    errors: [{ path: path.join(HOME_DIR, 'config.json'), error: 'not a purgeable artifact name' }],
  });
  const text = lines.join('\n');
  assert.match(text, /nothing (to purge|was deleted)/i);
  assert.match(text, /config\.json: not a purgeable artifact name/);
});
