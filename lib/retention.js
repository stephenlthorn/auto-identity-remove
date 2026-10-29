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

module.exports = { parseAge, MIN_RETENTION_DAYS };
