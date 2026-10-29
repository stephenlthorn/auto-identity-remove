/**
 * dashboard/people.js
 *
 * Who the dashboard shows status for, and how their names are abbreviated.
 *
 * A config with more than one person gets one status column per person in the
 * broker table (state keys "Broker|First Last"), with each name reduced to
 * initials so a screenshot of the table does not carry anyone's full name and
 * eight people still fit on a line. Pure: no fs, no express, so the top-level
 * `node --test` can cover it.
 */

'use strict';

const { stateKey } = require('../lib/config');

/**
 * The person half of the key the runner writes for this person. Built by the
 * writer's own stateKey() so the two can never drift apart (a blank last name
 * leaves a trailing space in the real key, and so here).
 * @param {{ firstName?: string, lastName?: string }} person
 * @returns {string}
 */
function personKeyName(person) {
  return stateKey('', person, 2).slice(1);
}

/**
 * First letter of the first and last word, upper-cased: "Mary Ann Jones" -> "MJ".
 * @param {*} name
 * @returns {string}  "?" when there is nothing to abbreviate
 */
function initialsOf(name) {
  const words = String(name == null ? '' : name).split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
}

/**
 * Initials for a list of names, unique within the list: the second "AS" becomes
 * "AS2". Digits cannot collide with an initials string, which is letters only.
 * Names repeated in the list share one entry.
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
function assignInitials(names) {
  const out = Object.create(null);
  const used = new Map(); // base initials -> how many names have taken it
  for (const name of names) {
    if (name in out) continue;
    const base = initialsOf(name);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    out[name] = n === 1 ? base : `${base}${n}`;
  }
  return { ...out };
}

function withInitials(names) {
  const byName = assignInitials(names);
  return names.filter((n, i) => names.indexOf(n) === i).map(name => ({ name, initials: byName[name] }));
}

/**
 * The people a config describes, in config order. persons[] takes precedence
 * over person (lib/config getPersonsFromConfig). Entries with no name are
 * skipped: they could not have written a state key worth showing.
 * @param {object|null|undefined} cfg
 * @returns {Array<{ name: string, initials: string }>}
 */
function peopleFromConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  let list = [];
  if (cfg.persons !== undefined) list = Array.isArray(cfg.persons) ? cfg.persons : [];
  else if (cfg.person) list = [cfg.person];
  const names = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const first = typeof p.firstName === 'string' ? p.firstName : '';
    const last = typeof p.lastName === 'string' ? p.lastName : '';
    if (!first.trim() && !last.trim()) continue;
    names.push(personKeyName({ firstName: first, lastName: last }));
  }
  return withInitials(names);
}

/**
 * The people state.optOuts names, for when the config cannot be read (locked or
 * corrupt): the table can still show who each result belongs to.
 * @param {object|null|undefined} optOuts
 * @returns {Array<{ name: string, initials: string }>}
 */
function peopleFromState(optOuts) {
  if (!optOuts || typeof optOuts !== 'object' || Array.isArray(optOuts)) return [];
  const names = [];
  for (const key of Object.keys(optOuts)) {
    const i = key.indexOf('|');
    if (i === -1) continue;
    const name = key.slice(i + 1);
    if (name.trim()) names.push(name);
  }
  return withInitials(names);
}

module.exports = { personKeyName, initialsOf, assignInitials, peopleFromConfig, peopleFromState };
