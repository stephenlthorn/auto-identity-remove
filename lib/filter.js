/**
 * lib/filter.js
 *
 * Helpers for CLI filter flags: --only, --skip, --retry-failed, --list.
 *
 * Exports:
 *   parseList(arg)                    - splits comma-separated names, trims whitespace
 *   makeBrokerPredicate(opts)         - (brokerName) => boolean, the single include test every runner shares
 *   applyFilter(brokers, opts)        - returns filtered broker array
 *   loadLastLog(logsDir, opts)        - newest run as its summary JSON, or its journal when it crashed; object or null
 *   extractFailedBrokers(log)         - returns Set of broker names from error/captcha/pending/unverified buckets
 */

const { findLatestRun } = require('./journal');

/**
 * Split a comma-separated string into trimmed, non-empty name tokens.
 * @param {string} arg
 * @returns {string[]}
 */
function parseList(arg) {
  if (!arg) return [];
  return arg.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// Case-insensitive, whitespace-tolerant key. `--only spokeo` must hit "Spokeo":
// a filter that silently matches nothing leaves the user thinking it ran.
function nameKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

/**
 * Build the one include test the whole run shares (CORE-4).
 *
 * --only / --skip / --retry-failed used to filter only the explicit non-email
 * list, so `aidr run --only Spokeo` still sent every opt-out email and ran the
 * ~490 generic brokers. The watcher builds this predicate once and hands it to
 * every runner as `opts.include`; a runner skips an excluded broker before it
 * navigates, emails or writes state.
 *
 * The selectors NARROW each other: a broker runs when it is named by --only (if
 * given) AND is in the retry set (if given) AND is not named by --skip. --skip is
 * a veto over everything else. It used to be a precedence chain (only > retry >
 * skip), which dropped a selector without a word: `--retry-failed --skip A` re-ran A,
 * the broker the user asked to leave out (CLI2-2). With no filter every broker is
 * included. A filter that resolves to an empty set (e.g. `--only ,` or nothing
 * failed last run) includes nothing, never "everything".
 *
 * @param {{ only?: string|null, skip?: string|null, retryFailedFromLog?: Iterable<string>|null }} [opts]
 * @returns {(brokerName: string) => boolean}
 */
function makeBrokerPredicate(opts = {}) {
  const { only, skip, retryFailedFromLog } = opts || {};

  const selectors = [];
  if (only) selectors.push(new Set(parseList(only).map(nameKey)));
  if (retryFailedFromLog) selectors.push(new Set([...retryFailedFromLog].map(nameKey)));
  const vetoed = skip ? new Set(parseList(skip).map(nameKey)) : null;

  if (selectors.length === 0 && !vetoed) return () => true;
  return (name) => {
    const key = nameKey(name);
    return selectors.every(names => names.has(key)) && !(vetoed && vetoed.has(key));
  };
}

/**
 * Apply --only / --skip / --retry-failed filter to a broker array: the same test
 * as makeBrokerPredicate (selectors narrow each other, --skip vetoes).
 * If no option is set, returns the full list unchanged.
 *
 * @param {Array<{name: string}>} brokers
 * @param {{ only?: string, skip?: string, retryFailedFromLog?: Set<string> }} [opts]
 * @returns {Array<{name: string}>}
 */
function applyFilter(brokers, opts = {}) {
  const include = makeBrokerPredicate(opts);
  return brokers.filter(b => include(b.name));
}

/**
 * Read the newest run from logsDir: its run-*.json summary, or, when that run
 * crashed before writing one, its run-*.jsonl journal rebuilt into the same
 * bucketed shape (marked `source: 'journal'`, `crashed`, `partial`). Without the
 * journal fallback a crashed run left --retry-failed nothing to read (R3).
 *
 * Returns null on any error (missing dir, no runs, bad JSON with no journal).
 * Pass `exclude` (the current run's log file name or path) so a run in progress,
 * whose journal is already on disk, is never its own retry source.
 *
 * @param {string} logsDir
 * @param {{ exclude?: string }} [opts]
 * @returns {object|null}
 */
function loadLastLog(logsDir, opts = {}) {
  try {
    const run = findLatestRun(logsDir, { exclude: opts && opts.exclude });
    return run ? run.log : null;
  } catch {
    return null;
  }
}

/**
 * Given a log object (with errors, captchaFailed, pendingConfirm, unverified
 * arrays of {broker, status, detail, time}), return a Set of broker names to retry.
 * `unverified` is a submission whose result page could not be read: nobody knows
 * it worked, so --retry-failed must not skip it.
 *
 * logResult() writes `broker`; this used to read `name`, so --retry-failed
 * retried nothing against a real log (CORE-5). `name` is still accepted for
 * logs written by older fixtures.
 *
 * @param {object} log
 * @param {Array<{broker?:string, name?:string}>} [log.errors]
 * @param {Array<{broker?:string, name?:string}>} [log.captchaFailed]
 * @param {Array<{broker?:string, name?:string}>} [log.pendingConfirm]
 * @param {Array<{broker?:string, name?:string}>} [log.unverified]
 * @returns {Set<string>}
 */
function extractFailedBrokers(log) {
  const names = new Set();
  for (const bucket of ['errors', 'captchaFailed', 'pendingConfirm', 'unverified']) {
    for (const entry of (log[bucket] || [])) {
      const name = entry && (entry.broker || entry.name);
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Case-insensitive, whitespace-tolerant membership test for the broker allowlist.
 *
 * A broker on the allowlist is one the user explicitly wants to STAY listed on,
 * so the run loops skip it and verification never flags it as still-listed.
 *
 * @param {string} name    Broker name (e.g. broker.name).
 * @param {{ allowlist?: string[] }} [config]  Parsed config object.
 * @returns {boolean}
 */
function isAllowlisted(name, config) {
  if (!name || !config || !Array.isArray(config.allowlist)) return false;
  const target = String(name).trim().toLowerCase();
  if (!target) return false;
  return config.allowlist.some(entry => String(entry).trim().toLowerCase() === target);
}

module.exports = { parseList, makeBrokerPredicate, applyFilter, loadLastLog, extractFailedBrokers, isAllowlisted };
