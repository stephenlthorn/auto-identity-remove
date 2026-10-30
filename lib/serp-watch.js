/**
 * lib/serp-watch.js
 *
 * Continuous SERP monitoring + new-domain alerts.
 *
 * Extends the on-demand SERP scan (lib/serp-scan.js) into a watch: run a fresh
 * scan, diff the broker hostnames it surfaces against the hostnames recorded in
 * the previous data/serp-history.json snapshot, and fire a desktop/webhook alert
 * via lib/notify.js dispatchNotify ONLY when the user's name appears on a NEW
 * domain.
 *
 * Exported helpers (pure, no I/O - fully unit-testable):
 *   diffSerpResults(previous, current) -> { newDomains, goneDomains, stillPresent }
 *   summaryHostnames(summary)          -> string[]  broker hostnames in a scan summary
 *   historyHostnames(history)          -> string[]  distinct hostnames in a history array
 *   buildAlert(diff, persons)          -> string     concise alert text for new domains
 *
 * Orchestrator (deps injected so it is testable without a live browser):
 *   runSerpWatch(context, persons, brokers, opts)
 *   describeWatchOutcome(result) -> string[]  console lines for the verdict
 *
 * A blocked or unreadable scan is INCONCLUSIVE: it never reports "No new
 * broker domains" and never claims a previously seen domain is gone (NET-5).
 */

'use strict';

const serpScan = require('./serp-scan');
const notify   = require('./notify');

/**
 * Deduplicate a list of hostname strings, dropping falsy / empty values.
 * @param {Array<string>} list
 * @returns {Set<string>}
 */
function _cleanSet(list) {
  const out = new Set();
  for (const h of Array.isArray(list) ? list : []) {
    if (h && typeof h === 'string') out.add(h);
  }
  return out;
}

/**
 * Pure set diff of two hostname lists.
 *
 * @param {string[]} previous  Hostnames seen in the previous snapshot.
 * @param {string[]} current   Hostnames seen in the current scan.
 * @returns {{ newDomains: string[], goneDomains: string[], stillPresent: string[] }}
 *   newDomains   - in current, not in previous (the alert trigger)
 *   goneDomains  - in previous, not in current
 *   stillPresent - in both
 *   All arrays are deduplicated and sorted ascending.
 */
function diffSerpResults(previous, current) {
  const prev = _cleanSet(previous);
  const cur  = _cleanSet(current);

  const newDomains   = [...cur].filter(h => !prev.has(h)).sort();
  const goneDomains  = [...prev].filter(h => !cur.has(h)).sort();
  const stillPresent = [...cur].filter(h => prev.has(h)).sort();

  return { newDomains, goneDomains, stillPresent };
}

/**
 * Extract broker hostnames from a runSerpScan summary object.
 * Each result entry carries a `hostname` (added by runSerpScan); fall back to
 * deriving it from the broker name's absence by returning only present strings.
 *
 * @param {{ results?: Array<{ hostname?: string }> }} summary
 * @returns {string[]}
 */
function summaryHostnames(summary) {
  const results = summary && Array.isArray(summary.results) ? summary.results : [];
  const out = new Set();
  for (const r of results) {
    if (r && r.hostname) out.add(r.hostname);
  }
  return [...out];
}

/**
 * Extract the distinct set of hostnames recorded in a serp-history array.
 *
 * @param {Array<{ hostname?: string }>} history
 * @returns {string[]}
 */
function historyHostnames(history) {
  const out = new Set();
  for (const e of Array.isArray(history) ? history : []) {
    if (e && e.hostname) out.add(e.hostname);
  }
  return [...out];
}

/**
 * Build a concise alert string describing the newly-appeared domains.
 *
 * @param {{ newDomains: string[] }} diff
 * @param {Array<{ firstName?: string, lastName?: string }>} persons
 * @returns {string}
 */
function buildAlert(diff, persons) {
  const who = Array.isArray(persons) && persons.length === 1
    ? `${persons[0].firstName || ''} ${persons[0].lastName || ''}`.trim()
    : `${(persons || []).length} watched identities`;
  const list = diff.newDomains.join(', ');
  const n = diff.newDomains.length;
  return `SERP watch: ${who} now appears on ${n} new domain${n === 1 ? '' : 's'}: ${list}`;
}

/**
 * Run a SERP scan, diff against the previous history snapshot, and alert on new
 * domains. Dependencies are injectable so this is testable without a live
 * browser or real disk:
 *   opts._runSerpScan(context, persons, brokers)  -> Promise<summary>
 *   opts._readHistory()                           -> history array
 *   opts._dispatchNotify(text, cfg)               -> Promise<void>
 *   opts.cfg                                      -> config (for notify.cfg.notify)
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object[]} persons
 * @param {object[]} brokers
 * @param {object} [opts]
 * @returns {Promise<{ diff: object, alerted: boolean, summary: object }>}
 */
async function runSerpWatch(context, persons, brokers, opts = {}) {
  const readHistoryFn   = opts._readHistory   || serpScan.readHistory;
  const runScanFn       = opts._runSerpScan   || serpScan.runSerpScan;
  const dispatchFn      = opts._dispatchNotify || notify.dispatchNotify;
  const cfg             = opts.cfg || {};

  // Snapshot the PREVIOUS hostnames before the scan appends new entries to the
  // same history file.
  const previousHosts = historyHostnames(readHistoryFn());

  const summary = await runScanFn(context, persons, brokers);
  const currentHosts = summaryHostnames(summary);
  const inconclusive = !!(summary && summary.inconclusive);

  const diff = diffSerpResults(previousHosts, currentHosts);
  // A scan with no usable engine saw nothing, so it cannot say anything left.
  if (inconclusive) diff.goneDomains = [];

  let alerted = false;
  if (diff.newDomains.length > 0) {
    await dispatchFn(buildAlert(diff, persons), cfg);
    alerted = true;
  }

  return { diff, alerted, summary, inconclusive };
}

/**
 * Console lines for the end of a watch run. Pure.
 *
 * @param {{ diff: object, alerted: boolean, summary: object, inconclusive?: boolean }} watch
 * @returns {string[]}
 */
function describeWatchOutcome(watch) {
  const { diff, alerted, summary } = watch;
  const usable = summary && Array.isArray(summary.enginesUsable) ? summary.enginesUsable : null;
  const attempted = (summary && summary.enginesAttempted) || 3;
  const partial = usable !== null && usable.length > 0 && usable.length < attempted;

  if (diff.newDomains.length > 0) {
    return [
      'WARNING: NEW domains your name now appears on:',
      ...diff.newDomains.map(d => `   - ${d}`),
      alerted ? 'An alert was dispatched.' : '(No alert channel configured.)',
      ...(watch.inconclusive || partial
        ? [`Only ${usable ? usable.length : 0} of ${attempted} search engines were usable, so this list may be incomplete.`]
        : []),
    ];
  }
  if (watch.inconclusive) {
    return [
      'INCONCLUSIVE: no search engine returned usable results, so aidr cannot tell whether',
      'your name appeared on any new domain. Try again later or from a different network.',
    ];
  }
  if (partial) {
    return [`No new broker domains since the last scan, on the ${usable.length} of ${attempted} search engines that responded (${usable.join(', ')}).`];
  }
  return ['No new broker domains since the last scan.'];
}

module.exports = {
  diffSerpResults,
  summaryHostnames,
  historyHostnames,
  buildAlert,
  runSerpWatch,
  describeWatchOutcome,
};
