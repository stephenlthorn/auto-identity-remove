/**
 * lib/filter.js
 *
 * Helpers for CLI filter flags: --only, --skip, --retry-failed, --list.
 *
 * Exports:
 *   parseList(arg)                    - splits comma-separated names, trims whitespace
 *   makeBrokerPredicate(opts)         - (brokerName) => boolean, the single include test every runner shares
 *   applyFilter(brokers, opts)        - returns filtered broker array
 *   loadLastLog(logsDir)              - reads newest run-*.json, returns parsed object or null
 *   extractFailedBrokers(log)         - returns Set of broker names from error/captcha/pending/unverified buckets
 */

const fs = require('fs');
const path = require('path');

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
 * Priority: only > retryFailedFromLog > skip. With no filter every broker is
 * included. A filter that resolves to an empty set (e.g. `--only ,` or nothing
 * failed last run) includes nothing, never "everything".
 *
 * @param {{ only?: string|null, skip?: string|null, retryFailedFromLog?: Iterable<string>|null }} [opts]
 * @returns {(brokerName: string) => boolean}
 */
function makeBrokerPredicate(opts = {}) {
  const { only, skip, retryFailedFromLog } = opts || {};

  if (only) {
    const names = new Set(parseList(only).map(nameKey));
    return name => names.has(nameKey(name));
  }

  if (retryFailedFromLog) {
    const names = new Set([...retryFailedFromLog].map(nameKey));
    return name => names.has(nameKey(name));
  }

  if (skip) {
    const names = new Set(parseList(skip).map(nameKey));
    return name => !names.has(nameKey(name));
  }

  return () => true;
}

/**
 * Apply --only / --skip / --retry-failed filter to a broker array.
 *
 * Priority: only > retryFailedFromLog > skip.
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
 * Read the most recently named run-*.json file from logsDir.
 * Returns parsed JSON object, or null on any error (missing dir, no files, bad JSON).
 *
 * @param {string} logsDir
 * @returns {object|null}
 */
function loadLastLog(logsDir) {
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => /^run-.*\.json$/.test(f))
      .sort();

    if (files.length === 0) return null;

    const latest = files[files.length - 1];
    const content = fs.readFileSync(path.join(logsDir, latest), 'utf8');
    return JSON.parse(content);
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
