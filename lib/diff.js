'use strict';

/**
 * lib/diff.js
 *
 * Compare current run results against a previous run log to surface
 * changes: new exposures, newly removed, regressions.
 */

const fs   = require('fs');
const path = require('path');

/**
 * Compare previous and current run results.
 *
 * @param {object|null} prev - Previous run results object (or null if no prior log).
 * @param {object} curr - Current run results object.
 * @returns {{ newExposures: string[], newlyRemoved: string[], regressed: string[], summary: string }}
 */
function diffResults(prev, curr) {
  if (prev === null) {
    const allCurrent = [
      ...(curr.succeeded     || []),
      ...(curr.notFound      || []),
      ...(curr.errors        || []),
      ...(curr.captchaFailed || []),
      ...(curr.pendingConfirm|| []),
      ...(curr.manual        || []),
    ].map(r => r.broker);

    return {
      newExposures: [],
      newlyRemoved: allCurrent,
      regressed:    [],
      summary:      `Since last run: ${allCurrent.length} newly attempted.`,
    };
  }

  const prevSucceeded = new Set((prev.succeeded || []).map(r => r.broker));
  const currSucceeded = new Set((curr.succeeded || []).map(r => r.broker));

  // Present in current.notFound but was previously in succeeded
  const newExposures = (curr.notFound || [])
    .map(r => r.broker)
    .filter(name => prevSucceeded.has(name));

  // In curr.succeeded but NOT in prev.succeeded
  const newlyRemoved = (curr.succeeded || [])
    .map(r => r.broker)
    .filter(name => !prevSucceeded.has(name));

  // In prev.succeeded but now in curr.errors
  const regressed = (curr.errors || [])
    .map(r => r.broker)
    .filter(name => prevSucceeded.has(name));

  const summary = `Since last run: +${newExposures.length} new exposures, +${newlyRemoved.length} newly removed, ${regressed.length} regressed.`;

  return { newExposures, newlyRemoved, regressed, summary };
}

/**
 * Load the newest run-*.json file in logsDir, excluding currentFile.
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

  if (candidates.length === 0) return null;

  try {
    const content = fs.readFileSync(path.join(logsDir, candidates[0]), 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

module.exports = { diffResults, loadPreviousLog };
