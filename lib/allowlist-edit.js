/**
 * lib/allowlist-edit.js
 *
 * Pure (no disk I/O) immutable edits to a config object's `allowlist` array.
 * Shared by the CLI (--allow / --unallow in watcher.js) and the dashboard.
 *
 * The allowlist is a list of broker names the user wants to STAY listed on.
 * Matching is case-insensitive; the original casing of an existing entry is
 * preserved so the stored config stays readable.
 */

'use strict';

/**
 * Return a new config object with `name` present in `config.allowlist`.
 * Idempotent and case-insensitive (no duplicate is added).
 *
 * @param {object} config  Parsed config object (not mutated).
 * @param {string} name    Broker name to allowlist.
 * @returns {object}       New config with the updated allowlist.
 */
function addToAllowlist(config, name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('allowlist name must be a non-empty string');
  const existing = Array.isArray(config && config.allowlist) ? config.allowlist : [];
  const already = existing.some(e => String(e).trim().toLowerCase() === trimmed.toLowerCase());
  const allowlist = already ? [...existing] : [...existing, trimmed];
  return { ...(config || {}), allowlist };
}

/**
 * Return a new config object with `name` removed from `config.allowlist`
 * (case-insensitive). No-op when the name is absent or the list is missing.
 *
 * @param {object} config  Parsed config object (not mutated).
 * @param {string} name    Broker name to remove.
 * @returns {object}       New config with the updated allowlist.
 */
function removeFromAllowlist(config, name) {
  const trimmed = String(name == null ? '' : name).trim().toLowerCase();
  const existing = Array.isArray(config && config.allowlist) ? config.allowlist : [];
  const allowlist = existing.filter(e => String(e).trim().toLowerCase() !== trimmed);
  return { ...(config || {}), allowlist };
}

/**
 * Parse --allow <name> / --unallow <name> out of an argv array.
 *
 * Returns:
 *   null                                     when neither flag is present
 *   { action, name }                         when a valid value follows the flag
 *   { action, name: null, error }            when the value is missing or looks
 *                                            like a flag (starts with "-")
 *
 * @param {string[]} argv  Typically process.argv.
 * @returns {{action:'allow'|'unallow', name:string|null, error?:string}|null}
 */
function parseAllowlistArgs(argv) {
  const find = (flag, action) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value || value.startsWith('-')) return { action, name: null, error: 'missing broker name' };
    return { action, name: value };
  };
  return find('--allow', 'allow') || find('--unallow', 'unallow');
}

module.exports = { addToAllowlist, removeFromAllowlist, parseAllowlistArgs };
