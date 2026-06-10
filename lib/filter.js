/**
 * lib/filter.js
 *
 * Helpers for CLI filter flags: --only, --skip, --retry-failed, --list.
 *
 * Exports:
 *   parseList(arg)                    — splits comma-separated names, trims whitespace
 *   applyFilter(brokers, opts)        — returns filtered broker array
 *   loadLastLog(logsDir)              — reads newest run-*.json, returns parsed object or null
 *   extractFailedBrokers(log)         — returns Set of broker names from error/captcha/pending buckets
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
  const { only, skip, retryFailedFromLog } = opts;

  if (only) {
    const names = new Set(parseList(only));
    return brokers.filter(b => names.has(b.name));
  }

  if (retryFailedFromLog) {
    return brokers.filter(b => retryFailedFromLog.has(b.name));
  }

  if (skip) {
    const names = new Set(parseList(skip));
    return brokers.filter(b => !names.has(b.name));
  }

  return brokers;
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
 * Given a log object (with errors, captchaFailed, pendingConfirm arrays of {name, ...}),
 * return a Set of broker names that should be retried.
 *
 * @param {object} log
 * @param {Array<{name:string}>} [log.errors]
 * @param {Array<{name:string}>} [log.captchaFailed]
 * @param {Array<{name:string}>} [log.pendingConfirm]
 * @returns {Set<string>}
 */
function extractFailedBrokers(log) {
  const names = new Set();
  for (const bucket of ['errors', 'captchaFailed', 'pendingConfirm']) {
    for (const entry of (log[bucket] || [])) {
      if (entry.name) names.add(entry.name);
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

module.exports = { parseList, applyFilter, loadLastLog, extractFailedBrokers, isAllowlisted };
