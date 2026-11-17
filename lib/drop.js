'use strict';

/**
 * lib/drop.js
 *
 * California's DROP: the Delete Request and Opt-out Platform, run by the California
 * Privacy Protection Agency (branded CalPrivacy). One request from a California
 * resident covers every data broker on the state registry.
 *
 * The platform verifies residency through the California Identity Gateway (Socure or
 * Login.gov), so aidr cannot submit a request and does not try. This module only:
 *   - says who the platform is for (isCaliforniaResident),
 *   - records, reads and clears "this person submitted a request on DAY" in the
 *     state file (state.drop, keyed by the person's name like the freeze marks),
 *   - keeps the legal clock (dropDeadline, dropStatus),
 *   - answers "is this broker already covered by that request?" (isCoveredByDrop),
 *     which the generic pass uses to stop sending the same company a second form,
 *   - writes the text `aidr drop` prints (describeDrop).
 *
 * Everything here is pure except recordDropRequest / clearDropRequest (they save the
 * state file, through an injectable `save`) and loadRegistryHosts (reads one file).
 */

const fs = require('fs');
const path = require('path');

const { resolvePaths } = require('./paths');
const { hostnameOf, registrableDomain } = require('./serp-scan');

const DROP_URL = 'https://consumer.drop.privacy.ca.gov';
const DROP_INFO_URL = 'https://privacy.ca.gov/drop/';
// There is no DROP-specific complaint form; the agency takes these through its general
// CCPA complaint form.
const COMPLAINT_URL = 'https://cppa.ca.gov/webapplications/complaint';
const STATUTE = 'Cal. Civ. Code 1798.99.86(c)(1)';

// DROP opened to consumers on this day. A request cannot be older.
const DROP_OPEN_DAY = '2026-01-01';
// Brokers had to start accessing the platform on this day, so a request submitted
// earlier is treated as received on it.
const BROKERS_START_DAY = '2026-08-01';

// Cal. Civ. Code 1798.99.86(c)(1): a broker must access the platform at least once
// every 45 days and, within 45 days after receiving a request, delete the consumer's
// data. Worst case that is 45 days to pick the request up plus 45 days to delete.
const PICKUP_DAYS = 45;
const DELETE_DAYS = 45;
const WINDOW_DAYS = PICKUP_DAYS + DELETE_DAYS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FEEDS_FILE = path.join(resolvePaths().data, 'feeds-brokers.json');

const _upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** True for a person whose state is CA or California and whose country is US or unset. */
function isCaliforniaResident(person) {
  const country = _upper(person && person.country);
  if (country !== '' && country !== 'US') return false;
  const state = _upper(person && person.state);
  return state === 'CA' || state === 'CALIFORNIA';
}

// ─── days ────────────────────────────────────────────────────────────────────

/** Milliseconds (UTC midnight) for a real YYYY-MM-DD day, or null. */
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

const _formatDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Today as YYYY-MM-DD (UTC, like every other day here). */
function todayDay(now = new Date()) {
  return _formatDay(now.getTime());
}

/**
 * The day the brokers' 90-day window ends: the later of the submitted day and
 * 2026-08-01, plus WINDOW_DAYS.
 */
function dropDeadline(submittedDay) {
  const submitted = parseDay(submittedDay);
  if (submitted === null) throw new Error(`dropDeadline: not a YYYY-MM-DD day: ${submittedDay}`);
  const start = Math.max(submitted, parseDay(BROKERS_START_DAY));
  return _formatDay(start + WINDOW_DAYS * MS_PER_DAY);
}

/** Validates the day a person says they submitted: a real day, not in the future, not before DROP opened. */
function checkSubmittedDay(value, today) {
  const ms = parseDay(value);
  if (ms === null) return { ok: false, error: `"${value}" is not a date: use YYYY-MM-DD, for example ${today}` };
  if (ms > parseDay(today)) return { ok: false, error: `${value} is in the future: a request cannot have been submitted yet` };
  if (ms < parseDay(DROP_OPEN_DAY)) return { ok: false, error: `${value} is before ${DROP_OPEN_DAY}, when DROP opened to consumers` };
  return { ok: true };
}

// ─── the record ──────────────────────────────────────────────────────────────

// Keyed by the person's name, not by a broker-style state key: the record is about the
// person, there is no broker part, and the name is stable when persons come and go.
const personKey = (person) => `${person && person.firstName || ''} ${person && person.lastName || ''}`.trim();

/** { submittedAt: 'YYYY-MM-DD' } for this person, or null (also for a damaged record). */
function getDropRequest(state, person) {
  const table = state && state.drop;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const record = table[personKey(person)];
  if (!record || typeof record !== 'object' || parseDay(record.submittedAt) === null) return null;
  return { submittedAt: record.submittedAt };
}

function _defaultSave() {
  require('./config').saveState();
}

/**
 * Record that this person submitted a DROP request on `day`. Mutates `state` in place
 * (only state.drop, never optOuts) and saves it, like lib/freeze.js recordFreezeDone.
 */
function recordDropRequest(state, person, day, opts = {}) {
  if (parseDay(day) === null) throw new Error(`recordDropRequest: not a YYYY-MM-DD day: ${day}`);
  if (!state.drop || typeof state.drop !== 'object' || Array.isArray(state.drop)) state.drop = {};
  state.drop[personKey(person)] = { submittedAt: day };
  (opts.save || _defaultSave)();
  return state;
}

/** Remove this person's record. Clearing a record that is not there is fine. */
function clearDropRequest(state, person, opts = {}) {
  if (state.drop && typeof state.drop === 'object') delete state.drop[personKey(person)];
  (opts.save || _defaultSave)();
  return state;
}

/**
 * Where this person's request stands.
 * @returns {{ kind: 'none' } | { kind: 'waiting'|'passed', submittedAt: string, deadline: string }}
 */
function dropStatus({ state, person, today }) {
  const record = getDropRequest(state, person);
  if (!record) return { kind: 'none' };
  const deadline = dropDeadline(record.submittedAt);
  const kind = parseDay(today) > parseDay(deadline) ? 'passed' : 'waiting';
  return { kind, submittedAt: record.submittedAt, deadline };
}

// ─── the registry ────────────────────────────────────────────────────────────

/** The registrable domain of a host or URL, the way the feeds and the SERP scan reduce one. */
function registryDomainOf(hostOrUrl) {
  const text = String(hostOrUrl == null ? '' : hostOrUrl).trim().toLowerCase();
  if (!text) return '';
  const host = text.includes('/') ? hostnameOf(text.includes('://') ? text : `https://${text}`) : text.replace(/^www\./, '');
  return registrableDomain(host);
}

/**
 * The registry hosts the feeds package writes into data/feeds-brokers.json under
 * `registryHosts`: { "registrable-domain": ["CA", "VT"] }. A missing file, unreadable
 * JSON, the older array-shaped file or a missing key is an empty map, never an error:
 * with no list the tool simply cannot skip anything.
 *
 * @returns {Record<string, string[]>} domains lowercased and reduced, codes upper-cased
 */
function loadRegistryHosts({ filePath = FEEDS_FILE, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath));
  } catch (_) {
    return {};
  }
  const raw = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed.registryHosts : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [host, codes] of Object.entries(raw)) {
    const domain = registryDomainOf(host);
    if (!domain || !Array.isArray(codes)) continue;
    const cleaned = [...new Set(codes.map(_upper).filter(Boolean))].sort();
    if (cleaned.length === 0) continue;
    out[domain] = [...new Set([...(out[domain] || []), ...cleaned])].sort();
  }
  return out;
}

/** The set of domains on the California registry. */
function californiaDomains(registryHosts) {
  const domains = new Set();
  for (const [domain, codes] of Object.entries(registryHosts || {})) {
    if (Array.isArray(codes) && codes.includes('CA')) domains.add(domain);
  }
  return domains;
}

// ─── coverage ────────────────────────────────────────────────────────────────

const _alsoSubmit = (config) => !!(config && config.drop && config.drop.alsoSubmit === true);

/**
 * True when this broker is covered by the person's DROP request: a California
 * resident, a recorded request, the broker's registrable domain on the California
 * registry, and `drop.alsoSubmit` not true.
 */
function isCoveredByDrop({ person, state, config, host, registryHosts }) {
  if (_alsoSubmit(config) || !isCaliforniaResident(person)) return false;
  if (!getDropRequest(state, person)) return false;
  const domain = registryDomainOf(host);
  return domain !== '' && californiaDomains(registryHosts).has(domain);
}

const coverageReason = (submittedAt) => `covered by your DROP request of ${submittedAt}`;

/**
 * The predicate runGenericBrokers takes as `coveredByDrop`: (row) => reason or null.
 * Returns null when nothing can ever be covered (not a Californian, no request, no
 * registry list, or alsoSubmit), so callers pass no option and the generic pass is
 * exactly what it was.
 */
function makeCoveredByDrop({ person, state, config, registryHosts }) {
  if (_alsoSubmit(config) || !isCaliforniaResident(person)) return null;
  const record = getDropRequest(state, person);
  const domains = californiaDomains(registryHosts);
  if (!record || domains.size === 0) return null;
  return (row) => {
    const domain = registryDomainOf(row && row.url);
    return domain !== '' && domains.has(domain) ? coverageReason(record.submittedAt) : null;
  };
}

/** Warnings for the drop block of config.json ([] when fine). */
function dropConfigProblems(config) {
  const block = config && config.drop;
  if (block === undefined) return [];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['drop must be an object, for example {"alsoSubmit": true}'];
  if (block.alsoSubmit !== undefined && typeof block.alsoSubmit !== 'boolean') {
    return ['drop.alsoSubmit must be true or false (anything else is ignored and the DROP skipping stays on)'];
  }
  return [];
}

// ─── what `aidr drop` prints ─────────────────────────────────────────────────

/**
 * The lines `aidr drop` prints for one person.
 * @param {{ person: object, state: object, registryCount: number, today: string }} args
 * @returns {string[]}
 */
function describeDrop({ person, state, registryCount, today }) {
  if (!isCaliforniaResident(person)) {
    return ['DROP is for California residents; nothing was changed for this person.'];
  }
  const status = dropStatus({ state, person, today });
  const statusLine = {
    none: 'Status: not recorded yet. Once you have submitted it, run: aidr drop --done',
    waiting: `Status: submitted on ${status.submittedAt}; brokers have until ${status.deadline} to pick it up and delete your data.`,
    passed: `Status: submitted on ${status.submittedAt}; the window passed on ${status.deadline}. Run aidr verify to see who still lists you, then aidr complaints.`,
  }[status.kind];
  const registryLine = registryCount > 0
    ? `This tool knows ${registryCount} registry brokers.`
    : 'This tool does not know the registry yet: run aidr update-brokers so it can skip the brokers a request covers.';
  return [
    'DROP (Delete Request and Opt-out Platform) is California\'s one-stop deletion request: one request',
    'from a California resident covers every data broker on the state registry, and brokers must keep',
    'deleting new data about you. aidr cannot submit it for you, because the state verifies who you are.',
    `Submit it here: ${DROP_URL}  (about it: ${DROP_INFO_URL})`,
    'It asks for your name, date of birth and email; phone, ZIP code, mobile ad ID, vehicle VIN and device ID are optional.',
    statusLine,
    registryLine,
  ];
}

/**
 * The whole of `aidr drop`, minus the process: what to print, what to record, and the
 * exit code. watcher.js wraps it with the lock, the config and the state file.
 *
 * @param {{ persons: object[], state: object, options: { done?: boolean, clear?: boolean, on?: string|null, person?: string|null },
 *           registryCount: number, today: string, save?: Function }} args
 * @returns {{ lines: string[], code: number }}
 */
function runDrop({ persons, state, options = {}, registryCount, today, save }) {
  const saveOpts = save ? { save } : {};
  const wanted = options.person ? String(options.person).trim().toLowerCase() : null;
  const people = wanted === null ? persons : persons.filter((p) => personKey(p).toLowerCase() === wanted);
  if (people.length === 0) {
    const names = persons.map(personKey).join(', ');
    return { lines: [`Error: no person named "${options.person}" in config.json. People configured: ${names}`], code: 2 };
  }

  const day = options.on || today;
  if (options.done) {
    const checked = checkSubmittedDay(day, today);
    if (!checked.ok) return { lines: [`Error: ${checked.error}`], code: 2 };
  }

  const lines = [];
  const labelled = people.length > 1;
  let changed = 0;
  for (const person of people) {
    if (labelled) lines.push('', `── ${personKey(person)} ──`);
    const californian = isCaliforniaResident(person);
    if (californian && options.done) {
      recordDropRequest(state, person, day, saveOpts);
      changed += 1;
      lines.push(`Recorded: ${personKey(person)} submitted a DROP request on ${day}.`);
    } else if (californian && options.clear) {
      if (getDropRequest(state, person)) {
        clearDropRequest(state, person, saveOpts);
        changed += 1;
        lines.push('Removed the record of your DROP request.');
      } else {
        lines.push('No DROP request was recorded, so there was nothing to remove.');
      }
    }
    lines.push(...describeDrop({ person, state, registryCount, today }));
  }
  if ((options.done || options.clear) && changed === 0 && !people.some(isCaliforniaResident)) {
    lines.push('', 'Nothing was recorded: DROP is for California residents.');
  }
  return { lines, code: 0 };
}

/**
 * The lines a run prints about DROP, once per run (not once per person):
 *   - a California person with no recorded request: one hint pointing at `aidr drop`;
 *   - a recorded request but no registry list: one line pointing at `aidr update-brokers`,
 *     because without the list nothing can be skipped.
 */
function dropRunNotes({ persons, state, config, registryHosts }) {
  const californians = (persons || []).filter(isCaliforniaResident);
  const lines = [];
  const unrecorded = californians.filter((p) => !getDropRequest(state, p));
  if (unrecorded.length > 0) {
    lines.push('California resident: one DROP request can cover the registered data brokers and spare you most of the forms below. See: aidr drop');
  }
  const recorded = californians.length > unrecorded.length;
  if (recorded && !_alsoSubmit(config) && californiaDomains(registryHosts).size === 0) {
    lines.push('Your DROP request is recorded, but this tool has no registry list to skip by: run aidr update-brokers so it can stop sending forms to brokers the request covers.');
  }
  return lines;
}

module.exports = {
  runDrop,
  dropRunNotes,
  DROP_URL,
  DROP_INFO_URL,
  COMPLAINT_URL,
  STATUTE,
  DROP_OPEN_DAY,
  BROKERS_START_DAY,
  PICKUP_DAYS,
  DELETE_DAYS,
  WINDOW_DAYS,
  isCaliforniaResident,
  parseDay,
  todayDay,
  dropDeadline,
  checkSubmittedDay,
  getDropRequest,
  recordDropRequest,
  clearDropRequest,
  dropStatus,
  registryDomainOf,
  loadRegistryHosts,
  californiaDomains,
  isCoveredByDrop,
  coverageReason,
  makeCoveredByDrop,
  dropConfigProblems,
  describeDrop,
};
