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
 *   resolvePurgeAge(opts)              - the age `aidr purge` uses: --older-than, retention.days, else 180d
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

// ── deleting ─────────────────────────────────────────────────────────────────

const sameDir = (a, b) => path.resolve(a) === path.resolve(b);

/**
 * Why this plan entry must not be deleted, or null when it may be.
 *
 * planPurge already applied these rules, but a plan can be stale (the file was
 * swapped for a symlink since) or hand-built, and an unlink is forever, so the
 * entry is judged again from scratch against the filesystem as it is now.
 * `stat` is null when the file is already gone.
 */
function refusalFor(entry, impl, dirs) {
  if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) {
    return { reason: 'malformed plan entry (needs an absolute path)' };
  }
  const rule = RULE_BY_KIND.get(entry.kind);
  if (!rule) return { reason: `unknown kind ${JSON.stringify(entry.kind)}` };
  if (!rule.pattern.test(path.basename(entry.path))) {
    return { reason: 'not a purgeable artifact name' };
  }
  if (dirs && !(dirs[rule.role] && sameDir(path.dirname(entry.path), dirs[rule.role]))) {
    return { reason: `outside the ${rule.role} directory` };
  }
  const stat = lstatQuietly(impl, entry.path);
  if (stat && !stat.isFile()) return { reason: 'not a regular file (symlink or directory)' };
  return { stat };
}

/**
 * Delete the files in `plan` (or, with dryRun, report what would go).
 *
 * Deletes files only: never a directory, never through a symlink. Every entry
 * is re-checked first (see refusalFor), and one failure is recorded and does
 * not stop the rest, because half a purge is still better than none.
 *
 * @param {Array<{ path: string, kind: string }>} plan
 * @param {{ dryRun?: boolean, dirs?: object, fs?: object }} [opts]
 *        dirs: when given, an entry must sit directly inside the directory for its kind
 * @returns {{ dryRun: boolean, deleted: Array<{ path: string, kind: string, ageDays: number, bytes: number }>,
 *             bytes: number, errors: Array<{ path: string, error: string }> }}
 */
function executePurge(plan, opts = {}) {
  const { dryRun = false, dirs } = opts;
  const impl = opts.fs || fs;
  const deleted = [];
  const errors = [];
  let bytes = 0;

  for (const entry of plan || []) {
    const shown = entry && typeof entry.path === 'string' ? entry.path : '(invalid entry)';
    const verdict = refusalFor(entry, impl, dirs);
    if (verdict.reason) {
      errors.push({ path: shown, error: verdict.reason });
      continue;
    }
    // Gone since planning: nothing to delete and nothing went wrong.
    if (!verdict.stat) continue;
    if (!dryRun) {
      try {
        impl.unlinkSync(entry.path);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        errors.push({ path: shown, error: String((err && (err.code || err.message)) || 'unlink failed') });
        continue;
      }
    }
    deleted.push({ path: entry.path, kind: entry.kind, ageDays: entry.ageDays, bytes: verdict.stat.size });
    bytes += verdict.stat.size;
  }
  return { dryRun, deleted, bytes, errors };
}

/**
 * Plan and execute in one call: what `aidr purge` runs.
 *
 * @param {object} opts  planPurge options plus dryRun
 * @returns {ReturnType<typeof executePurge> & { olderThanDays: number }}
 */
function purgeArtifacts(opts = {}) {
  const dirs = opts.dirs || defaultDirs();
  const plan = planPurge({ ...opts, dirs });
  const result = executePurge(plan, { dryRun: Boolean(opts.dryRun), dirs, fs: opts.fs });
  return { ...result, olderThanDays: opts.olderThanDays };
}

// ── reporting ────────────────────────────────────────────────────────────────

const KIND_LABELS = {
  'run-log': 'run logs',
  audit: 'audit reports',
  snapshot: 'snapshots',
  report: 'monthly reports',
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Human-readable lines for a purge result: counts per kind and the space freed.
 *
 * File NAMES only. No contents, and never a directory path: that carries the
 * user's home directory name into run output and logs.
 *
 * @param {{ dryRun?: boolean, deleted: object[], bytes: number, errors: object[], olderThanDays?: number }} result
 * @param {{ listFiles?: boolean }} [opts]  also list each file by name
 * @returns {string[]}
 */
function formatPurgeReport(result, opts = {}) {
  const { dryRun = false, deleted = [], bytes = 0, errors = [], olderThanDays } = result;
  const age = olderThanDays ? `older than ${plural(olderThanDays, 'day')}` : 'old enough';
  const lines = [];

  if (deleted.length === 0 && errors.length === 0) {
    return [`Nothing to purge: no PII files ${age}.`];
  }

  if (deleted.length === 0) {
    lines.push('Nothing was deleted.');
  } else {
    const verb = dryRun ? 'Would delete' : 'Deleted';
    const freed = dryRun ? '' : ' freed';
    lines.push(`${verb} ${plural(deleted.length, 'file')} (${formatSize(bytes)}${freed}), ${age}.`);

    const byKind = new Map();
    for (const item of deleted) {
      const group = byKind.get(item.kind) || { count: 0, bytes: 0, items: [] };
      byKind.set(item.kind, { count: group.count + 1, bytes: group.bytes + item.bytes, items: [...group.items, item] });
    }
    const kinds = [...byKind.keys()].sort((a, b) => {
      const rank = (kind) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);
      return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const kind of kinds) {
      const group = byKind.get(kind);
      lines.push(`  ${KIND_LABELS[kind] || kind}: ${plural(group.count, 'file')}, ${formatSize(group.bytes)}`);
      if (opts.listFiles) {
        for (const item of group.items) lines.push(`    ${path.basename(item.path)} (${plural(item.ageDays, 'day')} old)`);
      }
    }
  }

  if (dryRun) lines.push('Dry run: nothing was deleted.');

  if (errors.length > 0) {
    lines.push(`${plural(errors.length, 'file')} could not be deleted:`);
    for (const item of errors) lines.push(`  ${path.basename(item.path)}: ${item.error}`);
  }
  return lines;
}

// ── config: retention.days ───────────────────────────────────────────────────

const isBlank = (value) => value === undefined || value === null || value === '';

/**
 * The age configured under `retention.days`, or why it is not usable.
 *
 * Absent (or null / blank) means retention is off: every file is kept forever,
 * which is what everyone who has not asked for purging gets. A value that cannot
 * be used also turns it off, with a `problem` to show. Guessing a safer number
 * would still delete files the user never agreed to lose.
 *
 * @param {object|null|undefined} config
 * @returns {{ days: number|null, problem?: string }}
 */
function retentionDaysFromConfig(config) {
  const block = config && config.retention;
  if (isBlank(block)) return { days: null };
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { days: null, problem: 'retention must be an object like { "days": 180 }' };
  }
  if (isBlank(block.days)) return { days: null };
  let days;
  try {
    // force: only so the too-short case can be worded for a config file;
    // zero, negative, fractional and unreadable values still throw.
    days = parseAge(block.days, { force: true });
  } catch (err) {
    return { days: null, problem: `retention.days: ${err.message}` };
  }
  if (days < MIN_RETENTION_DAYS) {
    return {
      days: null,
      problem: `retention.days: must be at least ${MIN_RETENTION_DAYS} days (got ${days}); leave it out to keep files forever`,
    };
  }
  return { days };
}

// What `aidr purge` uses when neither --older-than nor retention.days says.
const DEFAULT_PURGE_DAYS = 180;

/**
 * The age for `aidr purge`: --older-than, else retention.days, else 180 days.
 *
 * A bad --older-than THROWS (the CLI should print it and exit 2): the user
 * typed it, so guessing would delete files they did not mean to. A config that
 * cannot be read or holds a bad retention.days does not stop a purge the user
 * asked for by hand; it falls back to the default and returns a `note`.
 *
 * @param {object} opts
 * @param {string|number} [opts.olderThan]   the --older-than value
 * @param {boolean} [opts.force]             allow under 7 days
 * @param {() => object} [opts.loadConfig]   returns the config; may throw
 * @returns {{ days: number, source: 'flag'|'config'|'default', note?: string }}
 */
function resolvePurgeAge({ olderThan, force = false, loadConfig } = {}) {
  if (!isBlank(olderThan)) return { days: parseAge(olderThan, { force }), source: 'flag' };

  const fallback = `using the default of ${DEFAULT_PURGE_DAYS} days`;
  if (!loadConfig) return { days: DEFAULT_PURGE_DAYS, source: 'default' };
  try {
    const { days, problem } = retentionDaysFromConfig(loadConfig());
    if (days !== null) return { days, source: 'config' };
    if (problem) return { days: DEFAULT_PURGE_DAYS, source: 'default', note: `${problem}; ${fallback}` };
  } catch (err) {
    const why = (err && (err.code || err.message)) || 'unknown error';
    return { days: DEFAULT_PURGE_DAYS, source: 'default', note: `config not read (${why}), so retention.days is unknown; ${fallback}` };
  }
  return { days: DEFAULT_PURGE_DAYS, source: 'default' };
}

/**
 * The end-of-run hook: apply `retention.days` after a SUCCESSFUL, non-dry run.
 *
 * Never throws and never deletes on a bad config. A retention hiccup must not
 * turn a finished run into a failed one, so every outcome comes back as a
 * status plus the lines to print:
 *
 *   'disabled'  no retention.days; nothing scanned, nothing printed
 *   'dry-run'   the run was a dry run; nothing scanned, nothing printed
 *   'invalid'   retention.days unusable; nothing deleted, the problem is printed
 *   'purged'    purge ran (result attached); prints only when it did something
 *   'error'     the purge itself failed; nothing is thrown
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} [opts.dirs]     default: defaultDirs()
 * @param {Date|number} [opts.now]
 * @param {string[]} [opts.keep]   this run's own files (log, journal, audit report)
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.fs]
 * @returns {{ status: string, lines: string[], result?: object }}
 */
function applyRetention(opts = {}) {
  const { config, dirs, now, keep, dryRun = false } = opts;
  const { days, problem } = retentionDaysFromConfig(config);
  if (problem) {
    return { status: 'invalid', lines: [`Retention ignored: ${problem}. No files were purged.`] };
  }
  if (days === null) return { status: 'disabled', lines: [] };
  if (dryRun) return { status: 'dry-run', lines: [] };

  try {
    const result = purgeArtifacts({ dirs, olderThanDays: days, now, keep, fs: opts.fs });
    if (result.deleted.length === 0 && result.errors.length === 0) return { status: 'purged', lines: [], result };
    return { status: 'purged', lines: [`Retention (retention.days=${days}):`, ...formatPurgeReport(result).map(line => `  ${line}`)], result };
  } catch (err) {
    return { status: 'error', lines: [`Retention skipped: ${(err && (err.code || err.message)) || 'unknown error'}`] };
  }
}

module.exports = {
  parseAge,
  planPurge,
  executePurge,
  purgeArtifacts,
  formatPurgeReport,
  retentionDaysFromConfig,
  resolvePurgeAge,
  applyRetention,
  defaultDirs,
  MIN_RETENTION_DAYS,
  DEFAULT_PURGE_DAYS,
};
