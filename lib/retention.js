/**
 * lib/retention.js
 *
 * Retention for the files aidr writes that hold PII: run logs and their
 * journals, audit reports, form screenshots and the monthly report PDFs. They
 * accumulate forever, and each one names the user and the brokers that hold
 * their data (R6).
 *
 *   parseAge(input, { force })         - '180d' | '6m' | '1y' | '30' | 180 -> whole days
 *   planPurge(opts)                    - read-only: reads the given dirs, returns what would go
 *   executePurge(plan, opts)           - deletes the planned files (or reports them in a dry run)
 *   purgeArtifacts(opts)               - plan + execute in one call, for `aidr purge`
 *   applyRetention(opts)               - the end-of-run hook for `retention.days`; never throws
 *   retentionDaysFromConfig(config)    - the configured age, or why it was ignored
 *   formatPurgeReport(result, opts)    - human lines: counts per kind, MB freed
 *
 * What this module will NEVER delete, whatever age it is given:
 *   - complaints (legal records) - a directory named "complaints" is refused outright
 *   - state, config, the run lock and the checkpoint - they match no known name
 *   - the newest run's log + journal, and the newest audit report
 *   - symlinks (never followed, never unlinked)
 *   - subdirectories, and anything outside the directories it was handed
 *   - any file whose name is not one of the patterns below
 *
 * A purge is an unlink and cannot be undone, so every rule errs towards
 * keeping the file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

// A week. Shorter than that deletes evidence from the run you are probably
// still checking, so it needs an explicit `force`.
const MIN_RETENTION_DAYS = 7;

const UNITS = { d: 1, m: MONTH_DAYS, y: YEAR_DAYS };
const ACCEPTED = 'expected a whole number of days like 30, or 180d, 6m, 1y';

/**
 * Turn an age into whole days.
 *
 * @param {string|number} input   '180d' | '6m' | '1y' | '30' | 180
 * @param {{ force?: boolean }} [opts]  force allows ages under MIN_RETENTION_DAYS
 * @returns {number}
 * @throws {Error} with a message that says what was wrong and what is accepted
 */
function parseAge(input, opts = {}) {
  const days = readDays(input);
  if (days < 1) {
    throw new Error(`age must be a positive whole number of days (got ${JSON.stringify(input)})`);
  }
  if (days < MIN_RETENTION_DAYS && !opts.force) {
    throw new Error(
      `refusing to purge files younger than ${MIN_RETENTION_DAYS} days (got ${days}); ` +
      `age must be at least ${MIN_RETENTION_DAYS} days unless you pass force`);
  }
  return days;
}

function readDays(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new Error(`age must be a whole number of days (got ${input})`);
    }
    return input;
  }
  if (typeof input !== 'string') {
    throw new Error(`age must be a number of days or a string like 180d (got ${input === null ? 'null' : typeof input})`);
  }
  const match = input.trim().toLowerCase().match(/^(-?\d+)([dmy]?)$/);
  if (!match) throw new Error(`cannot read age ${JSON.stringify(input)}: ${ACCEPTED}`);
  const days = Number(match[1]) * UNITS[match[2] || 'd'];
  if (!Number.isSafeInteger(days)) {
    throw new Error(`age ${JSON.stringify(input)} is too large to be a whole number of days`);
  }
  return days;
}

// ── what counts as a purgeable artifact ──────────────────────────────────────
//
// One row per file this tool writes. The directory role says where the file may
// live (a run-*.json dropped into the snapshots dir is not ours to delete), and
// the pattern is deliberately strict: `run-latest.json`, `last-run.json`,
// `state.json.lock`, a half-written `.tmp` or a stray note do not match, so they
// are never touched. Legacy date-only stamps (run-2026-05-19.json, written
// before intraday stamps existed) are still recognised.
const STAMP = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}-\\d{2}-\\d{2})?';
const RULES = [
  // lib/audit.js timestampForFilename; the .jsonl is the R3 crash-safe journal.
  { kind: 'run-log',  role: 'logs',      pattern: new RegExp(`^run-(${STAMP})\\.jsonl?$`) },
  { kind: 'audit',    role: 'logs',      pattern: new RegExp(`^audit-(${STAMP})\\.md$`) },
  // lib/snapshot.js: <broker>-<ISO with ':' and '.' as '-'>.png
  { kind: 'snapshot', role: 'snapshots', pattern: /^[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/ },
  // lib/report.js reportPdfPath
  { kind: 'report',   role: 'reports',   pattern: /^report-\d{4}-\d{2}-\d{2}\.pdf$/ },
];
const RULE_BY_KIND = new Map(RULES.map(rule => [rule.kind, rule]));
const KIND_ORDER = RULES.map(rule => rule.kind);
const ROLES = ['logs', 'snapshots', 'reports'];

// Complaints are legal records (CCPA/GDPR evidence). No rule above can match
// one, but a caller that hands over the complaints directory by mistake must
// hear about it rather than get an empty plan.
const NEVER_SCAN_DIR = 'complaints';

/**
 * Where the artifacts live when the caller does not say. lib/paths.js (R0) owns
 * that once it exists; until then the module constants' locations are used.
 *
 * @param {object} [env]
 * @returns {{ logs: string, snapshots: string, reports: string }}
 */
function defaultDirs(env = process.env) {
  try {
    const paths = require('./paths').resolvePaths(env);
    return { logs: paths.logs, snapshots: paths.snapshots, reports: paths.reports };
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  const logs = path.join(__dirname, '..', 'logs');
  return { logs, snapshots: path.join(logs, 'snapshots'), reports: path.join(logs, 'reports') };
}

function toEpochMs(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(ms)) throw new Error('now must be a Date or epoch milliseconds');
  return ms;
}

function requireDays(olderThanDays, force) {
  if (!Number.isSafeInteger(olderThanDays)) {
    throw new Error(`olderThanDays must be a whole number of days (got ${String(olderThanDays)}); use parseAge for text like 180d`);
  }
  return parseAge(olderThanDays, { force });
}

function listDir(impl, dir) {
  try {
    return impl.readdirSync(dir);
  } catch (err) {
    // No directory yet just means nothing has been written. Anything else
    // (EACCES, EIO) must surface: an empty plan would claim "nothing to purge"
    // about a directory that was never read.
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}

function lstatQuietly(impl, file) {
  try {
    return impl.lstatSync(file);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

// Newest stamp wins by NAME, the same order loadLastLog uses. A date-only
// stamp sorts before a full one for the same day, which is what we want.
const maxStamp = (items) => items.reduce((max, item) => (item.stamp > max ? item.stamp : max), '');

/**
 * Work out which artifacts are older than `olderThanDays` and may go.
 *
 * Reads only. Looks directly inside each given directory (no recursion, no
 * symlinks followed), so complaints/ under logs/ and anything else nested is
 * out of reach by construction.
 *
 * @param {object} opts
 * @param {{ logs?: string, snapshots?: string, reports?: string }} [opts.dirs]  default: defaultDirs()
 * @param {number}   opts.olderThanDays  whole days, at least MIN_RETENTION_DAYS unless force
 * @param {Date|number} [opts.now]       injected clock
 * @param {string[]} [opts.keep]         extra paths never to purge, e.g. the run in progress
 * @param {boolean}  [opts.force]        allow olderThanDays under MIN_RETENTION_DAYS
 * @param {object}   [opts.fs]           fs override for tests
 * @returns {Array<{ path: string, kind: string, ageDays: number, bytes: number }>}
 */
function planPurge(opts = {}) {
  const { olderThanDays, keep = [], force = false } = opts;
  const impl = opts.fs || fs;
  const dirs = opts.dirs || defaultDirs();
  const days = requireDays(olderThanDays, force);
  const nowMs = toEpochMs(opts.now === undefined ? Date.now() : opts.now);
  const cutoffMs = nowMs - days * DAY_MS;
  const keepPaths = new Set(keep.map(item => path.resolve(item)));

  const found = [];
  const seen = new Set();
  for (const role of ROLES) {
    const dir = dirs[role];
    if (!dir) continue;
    if (path.basename(path.resolve(dir)) === NEVER_SCAN_DIR) {
      throw new Error(`refusing to scan ${role} directory "${NEVER_SCAN_DIR}": complaints are legal records and are never purged`);
    }
    for (const name of listDir(impl, dir)) {
      const rule = RULES.find(candidate => candidate.role === role && candidate.pattern.test(name));
      if (!rule) continue;
      const file = path.join(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      const stat = lstatQuietly(impl, file);
      // lstat, not stat: a symlink reports isSymbolicLink and is skipped, so a
      // link planted in logs/ can never make us delete what it points at.
      if (!stat || !stat.isFile()) continue;
      const stamp = (name.match(rule.pattern) || [])[1] || '';
      found.push({ file, name, kind: rule.kind, stamp, stat });
    }
  }

  // The latest run is always kept: its log and journal share a stamp, and the
  // newest audit report is kept on its own because the audit stamp is taken
  // from the run's start and can differ from the log's by a second.
  const runs = found.filter(item => item.kind === 'run-log');
  const audits = found.filter(item => item.kind === 'audit');
  const newestRun = maxStamp(runs);
  const newestAudit = maxStamp(audits);
  const isLatest = (item) =>
    (item.kind === 'run-log' && item.stamp === newestRun) ||
    (item.kind === 'audit' && item.stamp === newestAudit);

  return found
    .filter(item => !isLatest(item))
    .filter(item => !keepPaths.has(path.resolve(item.file)))
    .filter(item => item.stat.mtimeMs < cutoffMs)
    .map(item => ({
      path: item.file,
      kind: item.kind,
      ageDays: Math.floor((nowMs - item.stat.mtimeMs) / DAY_MS),
      bytes: item.stat.size,
    }))
    .sort((a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

module.exports = { parseAge, planPurge, defaultDirs, MIN_RETENTION_DAYS };
