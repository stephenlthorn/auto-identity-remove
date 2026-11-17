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
const { hostnameOf } = require('./serp-scan');
const { personFingerprint, fingerprintMatches } = require('./identity');
const { registrableDomain, isPublicSuffix, isSharedPlatformHost, isCoverableDomain } = require('./domains');

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

// Fields named when two people share a name, in the order a person would look for them.
const IDENTITY_FIELDS = [['email', 'email'], ['zip', 'zip code'], ['state', 'state'], ['city', 'city']];

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

/**
 * Today as YYYY-MM-DD in the machine's LOCAL calendar. A person at 17:30 Pacific on Nov 17
 * who runs `aidr drop --done` did it on Nov 17, not on the UTC date Nov 18, and that date
 * ends up in a complaint. `offsetMinutes` is Date#getTimezoneOffset() (positive west of UTC);
 * it is a parameter so a test can pick a zone.
 */
function todayDay(now = new Date(), offsetMinutes = now.getTimezoneOffset()) {
  return _formatDay(now.getTime() - offsetMinutes * 60000);
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

/**
 * Validates the day a person says they submitted: a real day, not in the future, not before
 * DROP opened. "Future" means later than BOTH the local day and the UTC day, so a person east
 * of UTC can name their local today and one west of it can name the UTC date their clock
 * just rolled over to.
 */
function checkSubmittedDay(value, today, utcToday = today) {
  const ms = parseDay(value);
  if (ms === null) return { ok: false, error: `"${value}" is not a date: use YYYY-MM-DD, for example ${today}` };
  if (ms > Math.max(parseDay(today), parseDay(utcToday))) return { ok: false, error: `${value} is in the future: a request cannot have been submitted yet` };
  if (ms < parseDay(DROP_OPEN_DAY)) return { ok: false, error: `${value} is before ${DROP_OPEN_DAY}, when DROP opened to consumers` };
  return { ok: true };
}

// ─── the record ──────────────────────────────────────────────────────────────

// Keyed by the person's name, not by a broker-style state key: the record is about the
// person, there is no broker part, and the name is stable when persons come and go. The name
// alone is not an identity (two John Smiths, or a config person replaced by a namesake), so
// the record also carries the identity fingerprint the rest of the state uses.
const personKey = (person) => `${person && person.firstName || ''} ${person && person.lastName || ''}`.trim();

/** { submittedAt: 'YYYY-MM-DD' } for this person, or null (also for a damaged record). */
function getDropRequest(state, person) {
  const table = state && state.drop;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const record = table[personKey(person)];
  if (!record || typeof record !== 'object' || parseDay(record.submittedAt) === null) return null;
  // A stamped record belongs to the identity it was stamped for. An unstamped one can only
  // come from a development build (2.1 was never released without the stamp), so it is read.
  if (record.fp !== undefined && !fingerprintMatches(record.fp, person)) return null;
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
  state.drop[personKey(person)] = { submittedAt: day, fp: personFingerprint(person) };
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
  // A Map, not a plain object: the keys are third-party text, and `out[domain] || []` on a
  // plain object answers with Object.prototype's own member for a key like "constructor".
  const merged = new Map();
  for (const [host, codes] of Object.entries(raw)) {
    const domain = registryDomainOf(host);
    // A registry file must never make a shared form platform, a bare suffix or a word that is
    // not a host look like a broker, whatever wrote it (lib/feeds.js keeps them out, this is
    // the second lock).
    if (!isCoverableDomain(domain) || !Array.isArray(codes)) continue;
    const cleaned = codes.map(_upper).filter(Boolean);
    if (cleaned.length === 0) continue;
    merged.set(domain, new Set([...(merged.get(domain) || []), ...cleaned]));
  }
  const out = {};
  for (const domain of merged.keys()) out[domain] = [...merged.get(domain)].sort();
  return out;
}

// One warning per process: three places in a run load the list.
const _warnedOnce = { warned: false };

/**
 * loadRegistryHosts, but a broken registry list can never stop a run: any failure is an
 * empty list (nothing is skipped, so everything is submitted) and one plain warning.
 */
function loadRegistryHostsSafe({ load = loadRegistryHosts, warn = (m) => console.warn(m), once = _warnedOnce } = {}) {
  try {
    return load();
  } catch (_) {
    if (!once.warned) {
      once.warned = true;
      warn('Warning: the registry list could not be read, so no broker is skipped as covered by DROP. Run aidr update-brokers to rebuild it.');
    }
    return {};
  }
}

/**
 * How many brokers the California registry holds, from the `registries.CA` block of the feeds
 * file (knownCount, or count for a run that worked). NOT the number of domains in registryHosts:
 * several brokers share a domain, and a broker with no usable website has none. 0 when unknown.
 */
function loadCaBrokerCount({ filePath = FEEDS_FILE, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath));
  } catch (_) {
    return 0;
  }
  const info = parsed && !Array.isArray(parsed) && typeof parsed === 'object' && parsed.registries && !Array.isArray(parsed.registries)
    ? parsed.registries.CA
    : null;
  if (!info || typeof info !== 'object') return 0;
  const valid = (n) => Number.isInteger(n) && n > 0;
  if (valid(info.knownCount)) return info.knownCount;
  return info.ok === true && valid(info.count) ? info.count : 0;
}

/** loadCaBrokerCount that can never stop a run (see loadRegistryHostsSafe). */
function loadCaBrokerCountSafe({ load = loadCaBrokerCount } = {}) {
  try {
    return load();
  } catch (_) {
    return 0;
  }
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

// Skipping is on only for a drop block that is valid. A mistyped value ("alsoSubmit": "true")
// used to leave it on, which is the unsafe direction: the person asked for forms to be sent and
// got none. An invalid block now means "submit" (the run says so, see dropRunNotes).
const _alsoSubmit = (config) => dropConfigProblems(config).length > 0 || !!(config && config.drop && config.drop.alsoSubmit === true);

/**
 * THE rule for "is this company on the California registry?", used by the generic pass
 * (makeCoveredByDrop) and by the complaint finder (findDropOverdue). Either
 *   - the row says so itself: it came from the registry and carries `registries`
 *     including CA (the feed rows do), or
 *   - the registrable domain of its own URL is the primary website of a California
 *     registry broker AND that URL is not on a shared form platform.
 * A bundled row whose opt-out page is on a shared platform (a OneTrust portal, a Google
 * Form) and that carries no `registries` field is NOT covered: the platform host says
 * nothing about which company the page belongs to, so it is submitted.
 *
 * @param {{ url?: string, host?: string, registries?: string[] }} target
 * @param {Set<string>} domains  californiaDomains(registryHosts)
 */
function isOnCaliforniaRegistry(target, domains) {
  if (!target) return false;
  if (Array.isArray(target.registries) && target.registries.some((c) => _upper(c) === 'CA')) return true;
  const hostOrUrl = target.url || target.host;
  const domain = registryDomainOf(hostOrUrl);
  if (domain === '' || isPublicSuffix(domain)) return false;
  const text = String(hostOrUrl).trim().toLowerCase();
  const host = text.includes('/') ? hostnameOf(text.includes('://') ? text : `https://${text}`) : text;
  if (isSharedPlatformHost(host)) return false;
  return !!domains && domains.has(domain);
}

/**
 * True when this broker is covered by the person's DROP request: a California
 * resident, a recorded request, the broker on the California registry (see
 * isOnCaliforniaRegistry), and `drop.alsoSubmit` not true. `host` may be a URL;
 * `domains` lets a caller that checks many rows build the set once.
 */
function isCoveredByDrop({ person, state, config, host, url, registries, registryHosts, domains }) {
  if (_alsoSubmit(config) || !isCaliforniaResident(person)) return false;
  if (!getDropRequest(state, person)) return false;
  return isOnCaliforniaRegistry({ url, host, registries }, domains || californiaDomains(registryHosts));
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
  if (!record) return null;
  // A feed row says "CA" itself, so an empty host list does not rule out coverage.
  return (row) => (isCoveredByDrop({ person, state, config, url: row && row.url, registries: row && row.registries, domains })
    ? coverageReason(record.submittedAt)
    : null);
}

/**
 * How many registry brokers a recorded request reaches, for the score's informational
 * line: the number of California registry brokers (loadCaBrokerCount) when at least one
 * California person has a request.
 */
function dropCoveredCount({ persons, state, registryCount }) {
  const any = (persons || []).some((p) => isCaliforniaResident(p) && getDropRequest(state, p));
  return any && Number.isInteger(registryCount) && registryCount > 0 ? registryCount : 0;
}

/** A broker marked californiaOnly (the manual DROP entry) is shown only to California residents. */
function brokerAppliesToPerson(broker, person) {
  return !(broker && broker.californiaOnly) || isCaliforniaResident(person);
}

/**
 * The day a person's DROP request was recorded when `broker` is the manual "CalPrivacy DROP"
 * entry, else null. A recorded request is done: the run lists the entry as done with that date
 * instead of offering it again as a to-do.
 */
function recordedDropFor(broker, person, state) {
  if (!broker || !broker.californiaOnly) return null;
  const record = getDropRequest(state, person);
  return record ? record.submittedAt : null;
}

/** Warnings for the drop block of config.json ([] when fine). */
function dropConfigProblems(config) {
  const block = config && config.drop;
  if (block === undefined) return [];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['drop must be an object, for example {"alsoSubmit": true} (until it is fixed, DROP skipping is off and every broker is submitted)'];
  if (block.alsoSubmit !== undefined && typeof block.alsoSubmit !== 'boolean') {
    return ['drop.alsoSubmit must be true or false (until it is fixed, DROP skipping is off and every broker is submitted)'];
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
 *           registryCount: number, today: string, utcToday?: string, save?: Function }} args
 * @returns {{ lines: string[], code: number, pending?: boolean }} pending: somebody selected is a
 *   California resident with no recorded request (the caller may open the page for them)
 */
function runDrop({ persons, state, options = {}, registryCount, today, utcToday = today, save }) {
  const saveOpts = save ? { save } : {};
  const wanted = options.person ? String(options.person).trim().toLowerCase() : null;
  const people = wanted === null ? persons : persons.filter((p) => personKey(p).toLowerCase() === wanted);
  if (people.length === 0) {
    const names = persons.map(personKey).join(', ');
    return { lines: [`Error: no person named "${options.person}" in config.json. People configured: ${names}`], code: 2 };
  }

  // With several California residents, "everybody" is never what a person means: Ann filing
  // does not file Bob, and a record for Bob makes his generic pass skip every registry broker
  // although no request covers him. Recording and clearing name one person.
  // The record is keyed by name, so two configured people with the same name cannot each
  // hold one. Say what tells them apart (field names only, never the values).
  if ((options.done || options.clear) && people.length > 1 && options.person && new Set(people.map(personKey)).size === 1) {
    const differing = IDENTITY_FIELDS.filter(([key]) => new Set(people.map((p) => _upper(p && p[key]))).size > 1).map(([, label]) => label);
    const apart = differing.length > 0 ? `they differ in ${differing.join(' and ')}` : 'nothing in config.json tells them apart';
    return {
      lines: [`Error: "${options.person}" matches more than one configured person (${apart}). A DROP record is kept per name: give one of them a different first or last name in config.json, then run this again.`],
      code: 2,
    };
  }
  // Who a change could land on: California residents, and for --clear also anyone who still
  // holds a record (a person who moved keeps theirs until it is cleared).
  const californians = people.filter(isCaliforniaResident);
  const affected = options.clear ? people.filter((p) => isCaliforniaResident(p) || getDropRequest(state, p)) : californians;
  if ((options.done || options.clear) && !options.person && affected.length > 1) {
    const names = affected.map(personKey).join(', ');
    return {
      lines: [`Error: ${affected.length} people could be changed here (${names}). Say whose request this is: add --person "Full Name".`],
      code: 2,
    };
  }

  const day = options.on || today;
  if (options.done) {
    const checked = checkSubmittedDay(day, today, utcToday);
    if (!checked.ok) return { lines: [`Error: ${checked.error}`], code: 2 };
  }

  const lines = [];
  const labelled = people.length > 1;
  let changed = 0;
  let pending = false;
  for (const person of people) {
    if (labelled) lines.push('', `── ${personKey(person)} ──`);
    const californian = isCaliforniaResident(person);
    const existing = getDropRequest(state, person);
    if (californian && options.done) {
      if (existing && (!options.on || options.on === existing.submittedAt)) {
        // Re-running --done must never move the date: the 90-day clock hangs on it.
        lines.push(`Already recorded: ${personKey(person)} submitted a DROP request on ${existing.submittedAt}. Nothing was changed. To correct the date, run: aidr drop --done --on YYYY-MM-DD`);
      } else {
        recordDropRequest(state, person, day, saveOpts);
        changed += 1;
        lines.push(existing
          ? `Replaced the recorded date ${existing.submittedAt} with ${day} for ${personKey(person)}.`
          : `Recorded: ${personKey(person)} submitted a DROP request on ${day}.`);
      }
    } else if (options.clear && (californian || existing)) {
      // Anyone who has a record can clear it, even after moving out of California.
      if (existing) {
        clearDropRequest(state, person, saveOpts);
        changed += 1;
        lines.push('Removed the record of your DROP request.');
        if (!californian) continue;
      } else {
        lines.push('No DROP request was recorded, so there was nothing to remove.');
      }
    }
    lines.push(...describeDrop({ person, state, registryCount, today }));
    if (californian && !getDropRequest(state, person)) pending = true;
  }
  if ((options.done || options.clear) && changed === 0 && !people.some(isCaliforniaResident)) {
    lines.push('', 'Nothing was recorded: DROP is for California residents.');
  }
  return { lines, code: 0, pending };
}

/**
 * The lines a run prints about DROP, once per run (not once per person):
 *   - a California person with no recorded request: one hint pointing at `aidr drop`;
 *   - a recorded request but no registry list: one line pointing at `aidr update-brokers`,
 *     because without the list nothing can be skipped.
 */
function dropRunNotes({ persons, state, config, registryHosts }) {
  const californians = (persons || []).filter(isCaliforniaResident);
  // An invalid drop block turns the skipping off (see _alsoSubmit); say so once, at the start.
  const lines = dropConfigProblems(config).map((problem) => `Config warning: ${problem}`);
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
  loadRegistryHostsSafe,
  loadCaBrokerCount,
  loadCaBrokerCountSafe,
  californiaDomains,
  isOnCaliforniaRegistry,
  isCoveredByDrop,
  coverageReason,
  makeCoveredByDrop,
  brokerAppliesToPerson,
  recordedDropFor,
  dropCoveredCount,
  dropConfigProblems,
  describeDrop,
};
