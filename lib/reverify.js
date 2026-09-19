'use strict';

/**
 * lib/reverify.js
 *
 * Quarantine / re-verification repair path for state.json entries.
 *
 * Why this exists: a runner defect once let navigation failures (DNS, timeout,
 * bot-block, renderer crash) masquerade as ordinary automated outcomes. Entries
 * written under those conditions are untrustworthy: the tool may have recorded
 * a "not listed" / error-adjacent result for a site that was never actually
 * reached. Deleting them outright would be wrong (some are genuine), and
 * hand-editing state.json does not scale - so entries can instead be flagged
 * for re-verification.
 *
 * Semantics of the flag (`entry.needsReverify = { since, reason }`):
 *   - shouldSkip()      : a flagged entry never hits the 90-day recheck window
 *                         or the pending-confirmation defer - it is always
 *                         re-attempted on the next run.
 *   - runVerify()       : a flagged entry is re-searched immediately, bypassing
 *                         the "wait 7 days after submit" gate and the
 *                         "no recorded submission" gate.
 *   - recordSuccess()   : a fresh verified success clears the flag.
 *   - runVerify()       : any verification outcome also clears it.
 *
 * What is NEVER flagged: entries carrying proof of a real verification -
 * verifiedDeletedAt / verifiedStillListedAt / verifyHistory (written by the
 * --verify loop), or an explicit manual provenance marker (manual,
 * manuallyVerified, verifiedBy/recordedBy/source === 'manual'|'user'). Those
 * are trusted records; the repair path must not touch them.
 */

// Provenance fields a manual recording tool may stamp on an entry.
const MANUAL_PROVENANCE_FIELDS = ['verifiedBy', 'recordedBy', 'source'];
const MANUAL_PROVENANCE_VALUES = new Set(['manual', 'user']);

/**
 * True iff the entry carries evidence of a real verification or a manual
 * recording. Such entries are trusted and must never be quarantined.
 *
 * @param {object} entry
 * @returns {boolean}
 */
function isVerifiedEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.verifiedDeletedAt || entry.verifiedStillListedAt) return true;
  if (Array.isArray(entry.verifyHistory) && entry.verifyHistory.length > 0) return true;
  if (entry.manual === true || entry.manuallyVerified === true) return true;
  for (const field of MANUAL_PROVENANCE_FIELDS) {
    const v = entry[field];
    if (typeof v === 'string' && MANUAL_PROVENANCE_VALUES.has(v.toLowerCase())) return true;
  }
  return false;
}

/**
 * True iff the entry looks like it was written by the automated runner
 * (attempt/success timestamps, a detail string, outcome history, or a pending
 * confirmation). Entries with none of these have nothing to invalidate.
 *
 * @param {object} entry
 * @returns {boolean}
 */
function hasAutomatedRecord(entry) {
  return !!(
    entry &&
    typeof entry === 'object' &&
    (entry.lastAttempt ||
      entry.lastSuccess ||
      entry.lastDetail ||
      entry.pendingConfirm ||
      (Array.isArray(entry.history) && entry.history.length > 0))
  );
}

/**
 * The plain broker name inside a state key: the text before the first '|'
 * (composite multi-person keys are "Broker|<person label>").
 *
 * @param {string} key
 * @returns {string}
 */
function brokerOfKey(key) {
  const idx = String(key).indexOf('|');
  return idx === -1 ? String(key) : String(key).slice(0, idx);
}

/**
 * Flag ambiguous automated state entries for re-verification. MUTATES state.
 *
 * @param {object} state        - state.json-shaped object ({ optOuts: {...} })
 * @param {object} [opts]
 * @param {string[]} [opts.names] - restrict to these broker names (matched
 *   case-insensitively against the broker part of each key, or the full key).
 *   When omitted, every ambiguous automated entry is flagged.
 * @param {string} [opts.now]   - ISO timestamp for the flag (test injection).
 * @param {string} [opts.reason] - stored on the flag for the audit trail.
 * @returns {{
 *   flagged: string[],        - keys newly flagged this call
 *   alreadyFlagged: string[], - keys that already carried the flag
 *   verified: string[],       - keys skipped because they are trusted
 *   missing: string[]         - requested names that matched no state entry
 * }}
 */
function flagForReverification(state, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const reason = opts.reason || 'recorded under ambiguous conditions - re-verify before trusting';
  const names = opts.names && opts.names.length
    ? new Set(opts.names.map(n => String(n).trim().toLowerCase()).filter(Boolean))
    : null;

  const optOuts = (state && state.optOuts) || {};
  const flagged = [];
  const alreadyFlagged = [];
  const verified = [];
  const matched = new Set();

  for (const [key, entry] of Object.entries(optOuts)) {
    if (names) {
      const broker = brokerOfKey(key).toLowerCase();
      if (!names.has(broker) && !names.has(String(key).toLowerCase())) continue;
      matched.add(broker);
      if (names.has(String(key).toLowerCase())) matched.add(String(key).toLowerCase());
    }

    if (isVerifiedEntry(entry)) {
      verified.push(key);
      continue;
    }
    if (!hasAutomatedRecord(entry)) {
      continue; // nothing recorded - nothing to invalidate
    }
    if (entry.needsReverify) {
      alreadyFlagged.push(key);
      continue;
    }
    entry.needsReverify = { since: now, reason };
    flagged.push(key);
  }

  const missing = names ? [...names].filter(n => !matched.has(n)) : [];
  return { flagged, alreadyFlagged, verified, missing };
}

/**
 * Remove the quarantine flag from an entry, if present. Returns the entry.
 * @param {object} entry
 */
function clearReverifyFlag(entry) {
  if (entry && entry.needsReverify) delete entry.needsReverify;
  return entry;
}

module.exports = {
  flagForReverification,
  isVerifiedEntry,
  hasAutomatedRecord,
  brokerOfKey,
  clearReverifyFlag,
};
