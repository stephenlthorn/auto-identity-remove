'use strict';
/**
 * lib/heartbeat.js
 *
 * The run heartbeat (R4): a small last-run.json, beside state.json, that every
 * run writes when it starts and again when it ends. `aidr schedule status` and
 * `aidr doctor` read it to say when the job last ran and how it ended - without
 * it a monthly job that broke fails silently, because nothing is watching it.
 *
 *   { startedAt, finishedAt, outcome, counts }
 *
 * A record with startedAt and no finishedAt is a run that began and never
 * reported back. While it is younger than the lock's max age it reads as
 * `running`; past it the run cannot still hold the lock, so it reads as
 * `crashed` (an OOM kill, a power cut and `kill -9` skip every handler, so this
 * is the only way they ever show up).
 *
 * The file holds numbers only (counts), never a name or a broker list, but it is
 * still written owner-only like every other file the tool leaves behind.
 */

const fs = require('fs');
const path = require('path');
const { writePrivateFile } = require('./private-fs');
const lock = require('./lock');

const HEARTBEAT_FILENAME = 'last-run.json';

// What a run can write. `running` is never written: it is what a reader makes of
// a start record that has no end yet (and `unknown` of a file it cannot trust).
const OUTCOMES = Object.freeze(['ok', 'partial', 'failed', 'crashed']);

// A count key is a short identifier. Anything else (a name, an address) is not a
// count and is dropped, so a caller cannot leak PII into this file by accident.
const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

// result buckets (lib/logger.js) -> counts
const BUCKET_COUNTS = [
  'succeeded', 'pendingConfirm', 'unverified', 'skipped', 'notFound',
  'captchaFailed', 'manual', 'errors', 'dead',
];
// genericStats (generic-runner.js) -> counts
const GENERIC_COUNTS = {
  attempted: 'genericAttempted',
  submitted: 'genericSubmitted',
  no_form_found: 'genericNoForm',
  error: 'genericErrors',
  unverified: 'genericUnverified',
};

/**
 * How long an unfinished run may be called running: the lock's own max age
 * (AIDR_LOCK_MAX_AGE_HOURS, else 6 hours), since a run older than that has lost
 * its lock to the next one anyway.
 */
function lockMaxAgeMs({ maxAgeMs, env = process.env } = {}) {
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) return maxAgeMs;
  const hours = Number(env && env.AIDR_LOCK_MAX_AGE_HOURS);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return lock.DEFAULT_MAX_AGE_MS;
}

/** last-run.json beside the state file (so one mount or one directory holds both). */
function defaultHeartbeatPath({ statePath } = {}) {
  const state = statePath || require('./config').getStatePath();
  return path.join(path.dirname(state), HEARTBEAT_FILENAME);
}

function isoTime(value, field) {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : NaN);
  if (Number.isNaN(date.getTime())) throw new TypeError(`heartbeat: ${field} must be an ISO timestamp`);
  return date.toISOString();
}

function cleanCounts(counts) {
  const clean = {};
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return clean;
  for (const [key, value] of Object.entries(counts)) {
    if (COUNT_KEY.test(key) && typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
  }
  return clean;
}

/**
 * Atomically write the heartbeat, mode 0600. Throws TypeError for a record that
 * is not well formed (a programmer error: nothing is written); callers on the
 * run path use startHeartbeat, which never lets this fail a run.
 *
 * @param {string} file
 * @param {{ startedAt: string|Date, finishedAt?: string|Date|null,
 *           outcome?: 'ok'|'partial'|'failed'|'crashed'|null, counts?: object }} record
 */
function writeHeartbeat(file, record) {
  const rec = record || {};
  const startedAt = isoTime(rec.startedAt, 'startedAt');
  const finishedAt = rec.finishedAt == null ? null : isoTime(rec.finishedAt, 'finishedAt');
  const outcome = rec.outcome == null ? null : rec.outcome;
  if (outcome !== null && !OUTCOMES.includes(outcome)) {
    throw new TypeError(`heartbeat: outcome must be one of ${OUTCOMES.join(', ')} (got ${String(outcome)})`);
  }
  if ((finishedAt === null) !== (outcome === null)) {
    throw new TypeError('heartbeat: a finished run needs both finishedAt and an outcome; a started one has neither');
  }

  // Plain mkdir: the directory is the app's (or the user's mount), not ours to
  // chmod, which mkdirPrivate would do.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFile(file, JSON.stringify({ startedAt, finishedAt, outcome, counts: cleanCounts(rec.counts) }, null, 2) + '\n');
}

function validTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

const UNREADABLE = Object.freeze({
  startedAt: null, finishedAt: null, outcome: 'unknown', counts: {}, unreadable: true,
});

/**
 * Read the heartbeat. Read-only: a crashed run is reported, never rewritten.
 *
 * @param {string} file
 * @param {{ now?: number, maxAgeMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {null | { startedAt: string|null, finishedAt: string|null,
 *                    outcome: 'ok'|'partial'|'failed'|'crashed'|'running'|'unknown',
 *                    counts: object, unreadable?: boolean }}
 *   null: no run has left one. `unknown` + `unreadable`: there is a file but it is not a heartbeat.
 */
function readHeartbeat(file, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { ...UNREADABLE, counts: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { ...UNREADABLE, counts: {} };
  }
  const finishedAt = parsed && parsed.finishedAt != null ? parsed.finishedAt : null;
  const outcome = parsed && parsed.outcome != null ? parsed.outcome : null;
  const wellFormed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    validTime(parsed.startedAt) &&
    (finishedAt === null || validTime(finishedAt)) &&
    (outcome === null || OUTCOMES.includes(outcome)) &&
    (finishedAt === null) === (outcome === null);
  if (!wellFormed) return { ...UNREADABLE, counts: {} };

  const counts = cleanCounts(parsed.counts);
  if (finishedAt !== null) return { startedAt: parsed.startedAt, finishedAt, outcome, counts };

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const age = now - Date.parse(parsed.startedAt);
  const state = age > lockMaxAgeMs(opts) ? 'crashed' : 'running';
  return { startedAt: parsed.startedAt, finishedAt: null, outcome: state, counts };
}

/**
 * Begin a run's heartbeat: writes the start record now and hands back finish().
 *
 * finish() writes the end once, so the shutdown handler (outcome `failed`) and
 * the normal end of the run can both call it and the real end wins. Neither it
 * nor the start write ever throws: a read-only mount must not stop a run that is
 * otherwise fine, so failures go to onError (default: one warning line).
 *
 * @param {string} file
 * @param {{ now?: () => number, onError?: (err: Error) => void }} [opts]
 * @returns {{ startedAt: string, finish: (end?: { outcome: string, counts?: object }) => boolean }}
 */
function startHeartbeat(file, opts = {}) {
  const now = opts.now || Date.now;
  const onError = opts.onError || (err => console.warn(`⚠ could not write the run heartbeat ${file}: ${err.message}`));
  const startedAt = new Date(now()).toISOString();

  try {
    writeHeartbeat(file, { startedAt });
  } catch (err) {
    onError(err);
  }

  let done = false;
  return {
    startedAt,
    finish({ outcome, counts } = {}) {
      if (done) return false;
      try {
        writeHeartbeat(file, { startedAt, finishedAt: new Date(now()), outcome, counts });
        done = true;
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
  };
}

/**
 * The outcome and numbers-only counts for a finished run, from the logger's
 * results object.
 *
 * ok       finished with no errors (sites that need a human are a to-do, not a failure)
 * partial  finished, but some brokers errored
 * failed   errors and nothing else happened: no broker was submitted, skipped or checked
 *
 * `crashed` is not decided here: a crash leaves no end record, which is what
 * readHeartbeat reports as crashed.
 */
function outcomeFromResults(results) {
  const counts = {};
  const source = results || {};
  for (const bucket of BUCKET_COUNTS) {
    if (Array.isArray(source[bucket])) counts[bucket] = source[bucket].length;
  }
  const stats = source.genericStats;
  if (stats && typeof stats === 'object') {
    for (const [stat, key] of Object.entries(GENERIC_COUNTS)) {
      if (typeof stats[stat] === 'number' && Number.isFinite(stats[stat])) counts[key] = stats[stat];
    }
  }

  const n = key => counts[key] || 0;
  const errors = n('errors') + n('genericErrors');
  const progress = n('succeeded') + n('pendingConfirm') + n('unverified') + n('skipped') + n('notFound') +
    n('genericSubmitted') + n('genericUnverified');
  if (errors === 0) return { outcome: 'ok', counts };
  return { outcome: progress === 0 ? 'failed' : 'partial', counts };
}

module.exports = {
  HEARTBEAT_FILENAME,
  OUTCOMES,
  defaultHeartbeatPath,
  lockMaxAgeMs,
  writeHeartbeat,
  readHeartbeat,
  startHeartbeat,
  outcomeFromResults,
};
