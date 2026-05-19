/**
 * lib/drift.js
 *
 * Selector drift detection — identifies brokers whose last 3+ consecutive
 * attempts were all non-success (error, captcha_failed, pending_confirm).
 *
 * isDrifted(history)  — returns true if the last 3 entries are all non-success.
 * findDrifted(state)  — scans state.optOuts and returns drifted broker metadata.
 */

const NON_SUCCESS = new Set(['error', 'captcha_failed', 'pending_confirm']);

/**
 * Returns true if the last 3 entries of `historyArray` are all non-success.
 *
 * @param {string[]} historyArray
 * @returns {boolean}
 */
function isDrifted(historyArray) {
  if (!Array.isArray(historyArray) || historyArray.length < 3) return false;
  const tail = historyArray.slice(-3);
  return tail.every(entry => NON_SUCCESS.has(entry));
}

/**
 * Scans all brokers in state.optOuts and returns metadata for drifted ones.
 *
 * @param {{ optOuts: Record<string, { history?: string[], lastSuccess?: string }> }} state
 * @returns {{ name: string, history: string[], lastSuccess: string|null }[]}
 */
function findDrifted(state) {
  return Object.entries(state.optOuts)
    .filter(([, entry]) => isDrifted(entry.history || []))
    .map(([name, entry]) => ({
      name,
      history: entry.history || [],
      lastSuccess: entry.lastSuccess || null,
    }));
}

module.exports = { isDrifted, findDrifted };
