'use strict';
/**
 * lib/outage.js
 *
 * When are a run's "no such host" answers a problem with the machine rather than a
 * verdict on any one site? A resolver that is down, or a captive network that
 * answers NXDOMAIN for everything, makes every host look gone. Two callers need the
 * same judgment, so the thresholds live here once:
 *
 *   scripts/prune-dead.js  leaves such a run out of every host's history, so a broken
 *                          resolver cannot write the whole broker list into
 *                          data/dead-urls.json and switch the opt-outs off
 *   lib/heartbeat.js       will not call such a run `ok`: the monthly opt-out did
 *                          nothing, and the job reported healthy (exit 0)
 */

// A run in which MORE than this share of the hosts that were actually tried failed
// hard is a machine that was offline (or whose resolver was down), not evidence about
// any one host.
const MAX_HARD_SHARE = 0.5;

// Only judged once a run has tried at least this many hosts, so a small run (or a
// log) with a few really dead hosts is not mistaken for an outage.
const MIN_HOSTS_FOR_OUTAGE_CHECK = 10;

// The generic runner short-circuits hosts already in dead-urls.json; that entry is a
// cache hit, not a new observation, so it is neither a failure nor a host tried.
const CACHED_SKIP = /cached dead-url/i;

// One line for the run summary, the notification and the logs.
const OFFLINE_HINT = 'Most sites could not be resolved, so this run proves nothing. Check the network or DNS before trusting it.';

/**
 * @param {{ hard: number, tried: number }} counts hosts that failed hard, and hosts tried
 * @returns {boolean} true when the failures are better explained by an outage
 */
function isOutage({ hard, tried }) {
  return tried >= MIN_HOSTS_FOR_OUTAGE_CHECK && hard / tried > MAX_HARD_SHARE;
}

module.exports = {
  MAX_HARD_SHARE,
  MIN_HOSTS_FOR_OUTAGE_CHECK,
  CACHED_SKIP,
  OFFLINE_HINT,
  isOutage,
};
