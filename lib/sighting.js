/**
 * lib/sighting.js
 *
 * When was a listing last SEEN, from the two places that record it, and does that sighting
 * outrank a later "found nothing" check (S4)? Pure, with no requires, so the score, the
 * report and the verify loop can all use it without loading lib/config.js (which reads
 * state.json the moment it is required).
 *
 * The two records:
 *   - the opt-out entry's verifiedStillListedAt (`aidr verify` found the listing)
 *   - the scan record's lastFoundAt (`aidr scan`, or an ordinary run's own search, saw it)
 *
 * verify writes verifiedAbsentAt / verifiedDeletedAt when a search page was empty. A scan
 * or a verify that sees the listing LATER than that must win: otherwise the score keeps
 * counting 0 listed, the report files it under "Never seen" and verify skips it as already
 * found absent, all while the listing is up.
 */

'use strict';

const _ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
};

const _latest = (values) => {
  const known = values.filter(v => !Number.isNaN(v));
  return known.length ? Math.max(...known) : NaN;
};

/**
 * A scan record is about the same person as an opt-out entry unless both carry an
 * identity fingerprint and the two differ.
 */
function scanOf(entry, scan) {
  if (!scan || typeof scan !== 'object') return undefined;
  if (entry && entry.fp && scan.fp && entry.fp !== scan.fp) return undefined;
  return scan;
}

/**
 * The latest time a listing was seen, as ms since the epoch, or NaN when never.
 *
 * @param {{ entry?: object|null, scan?: object|null }} records
 */
function sightingMs({ entry, scan }) {
  const own = scanOf(entry, scan);
  return _latest([_ms(entry && entry.verifiedStillListedAt), _ms(own && own.lastFoundAt)]);
}

/**
 * The latest check that found nothing there (a verified removal or a never-seen), in ms, or NaN.
 *
 * @param {object|null|undefined} entry
 */
function goneMs(entry) {
  return _latest([_ms(entry && entry.verifiedDeletedAt), _ms(entry && entry.verifiedAbsentAt)]);
}

module.exports = { sightingMs, goneMs, scanOf };
