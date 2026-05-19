/**
 * lib/defunct.js
 *
 * Detects brokers that appear to be permanently offline based on their
 * error history. A broker is considered defunct when its last N outcomes
 * are all network-unreachable errors.
 *
 * History entries are the `kind` strings stored by recordFailure:
 *   'error'           - caught exception (timeout, connection refused, etc.)
 *   'captcha_failed'  - CAPTCHA solve failure (site is up, captcha is the issue)
 *   'pending_confirm' - form submitted, awaiting email confirmation (site is up)
 *   'success'         - opt-out succeeded
 *
 * Only 'error' is treated as unreachable — captcha and pending_confirm mean
 * the site is reachable, just not completing cleanly.
 *
 * Used by watcher.js to surface defunct brokers in the summary so the user
 * can prune stale entries from brokers.js.
 */

const DEFUNCT_THRESHOLD = 5; // consecutive unreachable runs to flag as defunct

/**
 * Returns true if the history kind string represents a network-unreachable error.
 * Only the 'error' kind (stored by recordFailure when an exception is caught)
 * counts — captcha_failed and pending_confirm both mean the site is reachable.
 *
 * @param {string|null|undefined} kind  History entry kind string
 * @returns {boolean}
 */
function isUnreachable(kind) {
  if (!kind) return false;
  return kind === 'error';
}

/**
 * Returns true if the broker's history shows DEFUNCT_THRESHOLD or more
 * consecutive unreachable errors at the end of the array.
 *
 * @param {string[]|null|undefined} history  Array of history kind strings
 * @returns {boolean}
 */
function isDefunct(history) {
  if (!Array.isArray(history) || history.length < DEFUNCT_THRESHOLD) return false;
  const tail = history.slice(-DEFUNCT_THRESHOLD);
  return tail.every(h => isUnreachable(h));
}

/**
 * Scans the full state.optOuts map and returns an array of broker names
 * that appear to be defunct, sorted alphabetically.
 *
 * @param {Record<string, { history?: string[] }>|null|undefined} stateOptOuts
 * @returns {string[]}
 */
function findDefunct(stateOptOuts) {
  const result = [];
  for (const [name, entry] of Object.entries(stateOptOuts || {})) {
    if (entry && isDefunct(entry.history)) {
      result.push(name);
    }
  }
  return result.sort();
}

module.exports = { isUnreachable, isDefunct, findDefunct, DEFUNCT_THRESHOLD };
