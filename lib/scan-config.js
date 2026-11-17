/**
 * lib/scan-config.js
 *
 * The `scan` section of config.json, kept free of other requires so lib/config.js can
 * validate it without a circular import.
 *
 *   scan.unknown      what `aidr run --found-only` does with a broker whose scan result
 *                     cannot be used (could not tell, too old, never scanned, or the
 *                     broker cannot be searched): "submit" (default) or "skip".
 *   scan.maxAgeDays   how old a scan result may be and still count (default 30).
 */

'use strict';

const SCAN_DEFAULTS = Object.freeze({ unknown: 'submit', maxAgeDays: 30 });
const UNKNOWN_WORDS = new Set(['submit', 'skip']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const wholeDays = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const word = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function scanSettings(config) {
  const section = config && isObject(config.scan) ? config.scan : {};
  return {
    unknown: UNKNOWN_WORDS.has(word(section.unknown)) ? word(section.unknown) : SCAN_DEFAULTS.unknown,
    maxAgeDays: wholeDays(section.maxAgeDays) ? section.maxAgeDays : SCAN_DEFAULTS.maxAgeDays,
  };
}

/**
 * Problems with the scan section. A wrong value is a problem, not a warning: a typo in
 * `skip` would otherwise quietly mean `submit`, the opposite of what was asked.
 */
function scanConfigProblems(config) {
  if (!config || config.scan === undefined) return [];
  const section = config.scan;
  if (!isObject(section)) return ['scan must be an object like { "unknown": "submit", "maxAgeDays": 30 }'];
  const problems = [];
  if (section.unknown !== undefined && !UNKNOWN_WORDS.has(word(section.unknown))) {
    problems.push(`scan.unknown must be "submit" or "skip" (got ${JSON.stringify(section.unknown)})`);
  }
  if (section.maxAgeDays !== undefined && !wholeDays(section.maxAgeDays)) {
    problems.push(`scan.maxAgeDays must be a whole number of 1 or more (got ${JSON.stringify(section.maxAgeDays)})`);
  }
  return problems;
}

module.exports = { SCAN_DEFAULTS, scanSettings, scanConfigProblems };
