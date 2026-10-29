'use strict';

/**
 * lib/diff.js
 *
 * Compare current run results against a previous run log to surface
 * changes: new exposures, newly removed, regressions.
 *
 * Rows are keyed by person AND broker (CFG-13). Matching on the broker name
 * alone turned "Jane succeeded at Spokeo, John errored at Spokeo" into a
 * regression and let one person's rows hide the other's.
 */

const fs   = require('fs');
const path = require('path');

const ATTEMPTED_BUCKETS = ['succeeded', 'notFound', 'errors', 'captchaFailed', 'pendingConfirm', 'manual', 'unverified'];

const rowKey = r => `${r.person || ''}\u0000${r.broker}`;

/**
 * Index a previous run's rows so `has(row)` answers "was this person's row
 * there?". Rows without a person (logs written before results were tagged)
 * match on broker alone, in both directions, so the first run after an upgrade
 * does not report every broker as new.
 */
function indexRows(entries) {
  const exact = new Set();
  const untaggedBrokers = new Set();
  const allBrokers = new Set();
  for (const r of entries) {
    allBrokers.add(r.broker);
    if (r.person) exact.add(rowKey(r));
    else untaggedBrokers.add(r.broker);
  }
  return {
    has: r => (r.person
      ? exact.has(rowKey(r)) || untaggedBrokers.has(r.broker)
      : allBrokers.has(r.broker)),
  };
}

/** Distinct person labels across every bucket of the given runs. */
function peopleIn(...runs) {
  const people = new Set();
  for (const run of runs) {
    if (!run) continue;
    for (const bucket of ATTEMPTED_BUCKETS) {
      for (const r of run[bucket] || []) if (r.person) people.add(r.person);
    }
  }
  return people;
}

/**
 * Compare previous and current run results.
 *
 * Names in the returned arrays are plain broker names for a single-person run
 * and "Broker (First Last)" once more than one person appears in either log.
 *
 * @param {object|null} prev - Previous run results object (or null if no prior log).
 * @param {object} curr - Current run results object.
 * @returns {{ newExposures: string[], newlyRemoved: string[], regressed: string[], summary: string }}
 */
function diffResults(prev, curr) {
  const multiPerson = peopleIn(prev, curr).size > 1;
  const label = r => (multiPerson && r.person ? `${r.broker} (${r.person})` : r.broker);

  if (prev === null) {
    const allCurrent = ATTEMPTED_BUCKETS.flatMap(bucket => curr[bucket] || []).map(label);

    return {
      newExposures: [],
      newlyRemoved: allCurrent,
      regressed:    [],
      summary:      `Since last run: ${allCurrent.length} newly attempted.`,
    };
  }

  const prevSucceeded = indexRows(prev.succeeded || []);

  // Present in current.notFound but was previously in succeeded
  const newExposures = (curr.notFound || [])
    .filter(r => prevSucceeded.has(r))
    .map(label);

  // In curr.succeeded but NOT in prev.succeeded
  const newlyRemoved = (curr.succeeded || [])
    .filter(r => !prevSucceeded.has(r))
    .map(label);

  // In prev.succeeded but now in curr.errors
  const regressed = (curr.errors || [])
    .filter(r => prevSucceeded.has(r))
    .map(label);

  const summary = `Since last run: +${newExposures.length} new exposures, +${newlyRemoved.length} newly removed, ${regressed.length} regressed.`;

  return { newExposures, newlyRemoved, regressed, summary };
}

/**
 * Whether a run log covers only part of the broker list. The watcher marks
 * `--only`, `--skip`, `--retry-failed` and `--resume` runs with `partial: true`
 * and a `filter` object. A partial log is a bad baseline: diffing a full run
 * against a one-broker log reports hundreds of "newly removed" brokers and hides
 * real regressions (CFG-15c).
 *
 * @param {object|null} log
 * @returns {boolean}
 */
function isPartialLog(log) {
  if (!log || typeof log !== 'object') return false;
  if (log.partial === true) return true;
  const filter = log.filter;
  if (!filter) return false;
  if (typeof filter !== 'object') return true;
  return Object.values(filter).some(v => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
}

/**
 * Load the newest FULL run-*.json file in logsDir, excluding currentFile.
 * Partial runs (see isPartialLog) and unreadable files are skipped.
 *
 * @param {string} logsDir - Directory containing run-*.json files.
 * @param {string} currentFile - Filename or absolute path of the current log to exclude.
 * @returns {object|null} Parsed JSON of the previous run, or null if none found.
 */
function loadPreviousLog(logsDir, currentFile) {
  const currentBase = path.basename(currentFile);

  let files;
  try {
    files = fs.readdirSync(logsDir);
  } catch (_) {
    return null;
  }

  const candidates = files
    .filter(f => /^run-.+\.json$/.test(f) && f !== currentBase)
    .sort()
    .reverse();

  for (const file of candidates) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8'));
    } catch (_) {
      continue;
    }
    if (!isPartialLog(log)) return log;
  }
  return null;
}

module.exports = { diffResults, loadPreviousLog, isPartialLog };
