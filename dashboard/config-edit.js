'use strict';
/*
 * dashboard/config-edit.js - how a PUT /api/config body becomes the next
 * config.json.
 *
 * Kept free of express and fs so the top-level test run covers it. server.js
 * re-exports maskConfig / mergeConfig / MASK for the callers that already use
 * them from there.
 */

const MASK = '••••••••';

// Every secret leaf config.example.json can define. Adding a credential to the
// example config without adding it here leaks it verbatim through
// GET /api/config to anything with dashboard read access - which is how
// relay.apiKey (SimpleLogin) and hibp.apiKey went unmasked.
const SECRET_PATHS = [
  ['capsolver', 'apiKey'],
  ['hibp', 'apiKey'],
  ['relay', 'apiKey'],
  ['email', 'smtp', 'pass'],
  ['notify', 'webhook'],
];

// Keys that must never be merged from client input - assigning them can corrupt
// the prototype chain (prototype pollution). Dropped outright (defense-in-depth).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Sections that mean "feature on" only when something is filled in. The runtime
// treats the bare presence of email.smtp as "send via SMTP" (lib/email.js), so a
// form submitted blank must not leave `{host:'', port:'', ...}` behind.
const PRUNABLE_SECTIONS = [['email', 'smtp'], ['relay'], ['hibp']];

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Mask secret leaves so they never reach the browser.
function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  for (const p of SECRET_PATHS) {
    let o = c; for (let i = 0; i < p.length - 1; i++) o = o && o[p[i]];
    const k = p[p.length - 1];
    if (o && typeof o[k] === 'string' && o[k]) o[k] = MASK;
  }
  if (c.accounts && typeof c.accounts === 'object') {
    for (const k of Object.keys(c.accounts)) {
      const a = c.accounts[k];
      if (a && typeof a === 'object' && a.password) a.password = MASK;
    }
  }
  return c;
}

// Merge incoming over existing; a value equal to MASK means "keep existing".
function mergeConfig(existing, incoming) {
  if (Array.isArray(incoming)) return incoming;
  if (incoming && typeof incoming === 'object') {
    const out = Array.isArray(existing) ? {} : { ...(existing || {}) };
    for (const k of Object.keys(incoming)) {
      if (DANGEROUS_KEYS.has(k)) continue; // never merge prototype-polluting keys
      if (incoming[k] === MASK) continue; // preserve existing secret
      out[k] = mergeConfig(existing ? existing[k] : undefined, incoming[k]);
    }
    return out;
  }
  return incoming;
}

/**
 * True when nothing a user could have typed is left in `v`. Keys starting with
 * "_" are the example config's inline comments and do not count as content;
 * numbers and booleans always do.
 */
function isBlankDeep(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.every(isBlankDeep);
  if (typeof v === 'object') {
    return Object.keys(v).filter(k => !k.startsWith('_')).every(k => isBlankDeep(v[k]));
  }
  return false;
}

const hasPersons = c => isPlainObject(c) && Array.isArray(c.persons) && c.persons.length > 0;

function getIn(obj, path) {
  return path.reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function deleteIn(obj, path) {
  const parent = getIn(obj, path.slice(0, -1));
  if (isPlainObject(parent)) delete parent[path[path.length - 1]];
}

/**
 * Apply a PUT body to the existing config and return the config to write.
 * Neither argument is mutated.
 *
 *  - persons[] configs (DASH-2): brokers.js and lib/config.js resolve the person
 *    from `persons` when it exists, so a sibling `person` is at best ignored and
 *    at worst (before the brokers.js precedence fix) searched with blank names.
 *    A `person` edit is therefore applied to persons[0], an all-blank `person`
 *    is dropped, and no top-level `person` is ever created beside `persons`.
 *  - blank optional sections (DASH-4): a section the request touched that ends
 *    up with nothing in it is removed instead of stored as empty strings.
 *
 * @param {object} existing  the decrypted current config ({} when absent)
 * @param {object} incoming  the request's config object
 * @returns {object}
 */
function applyConfigEdit(existing, incoming) {
  const base = isPlainObject(existing) ? existing : {};
  const inc = isPlainObject(incoming) ? { ...incoming } : {};

  const personsMode = hasPersons(base) || hasPersons(inc);
  let personEdit;
  if (personsMode) {
    personEdit = inc.person;
    delete inc.person;
  }

  const merged = mergeConfig(base, inc);

  if (personsMode) {
    const editsPerson = !hasPersons(inc) && isPlainObject(personEdit) && !isBlankDeep(personEdit);
    if (editsPerson) {
      merged.persons = merged.persons.map((p, i) => (i === 0 ? mergeConfig(p, personEdit) : p));
    }
    if (isPlainObject(merged.person) && isBlankDeep(merged.person)) delete merged.person;
  }

  for (const section of PRUNABLE_SECTIONS) {
    if (getIn(inc, section) === undefined) continue; // not part of this request
    if (!isBlankDeep(getIn(merged, section))) continue;
    deleteIn(merged, section);
    if (section.length > 1) {
      const parentPath = section.slice(0, -1);
      const parent = getIn(merged, parentPath);
      if (isPlainObject(parent) && Object.keys(parent).length === 0 && getIn(base, parentPath) === undefined) {
        deleteIn(merged, parentPath);
      }
    }
  }
  return merged;
}

module.exports = {
  MASK,
  SECRET_PATHS,
  DANGEROUS_KEYS,
  maskConfig,
  mergeConfig,
  isBlankDeep,
  applyConfigEdit,
};
