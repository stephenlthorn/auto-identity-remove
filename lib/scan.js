/**
 * lib/scan.js
 *
 * `aidr scan`: look for a listing at every broker that can be searched, for every
 * person, WITHOUT submitting anything, and remember what was found.
 *
 * State written (top level, beside optOuts), keyed exactly like the opt-outs
 * (lib/config.js stateKey: the bare broker name for one person, "Broker|First Last"
 * for several):
 *
 *   state.scans[key] = {
 *     at,                      ISO time of the latest result
 *     outcome,                 'found' | 'not_found' | 'unknown'
 *     listingUrl?,             the listing, when found
 *     reason?,                 why we could not tell, when unknown
 *     screenshot?,             path of the saved search-page screenshot, when found
 *     lastFoundAt?,            the last time ANY result was 'found' (kept across later results)
 *     source?,                 'run' when an ordinary run's own search step saw the listing
 *     lastScanAt?,             the last time an `aidr scan` (not a run) recorded anything
 *     history: [{ at, outcome }],   the last few results
 *     fp,                      identity fingerprint, so a changed zip or email starts fresh
 *     sh?,                     one-way hash of the exact search URL that was searched (S1). A
 *                              record whose hash is not the person's CURRENT search for that
 *                              broker, or that has none (older code), counts as never scanned.
 *                              The URL itself is never stored: it carries the person's name.
 *   }
 *
 * `unknown` ("could not tell") is a bot wall, a failed navigation or a browser that
 * would not start. It is never `not_found`: that would read as "you are not listed".
 *
 * Also here, because verify, the run and the watcher all need them: the evidence
 * helpers (was a listing ever seen) and the pure `--found-only` decision.
 */

'use strict';

const { stateKey, readEntry } = require('./config');
const { personFingerprint, fingerprintMatches, searchHash } = require('./identity');
const { isAllowlisted } = require('./filter');
const { canSearch } = require('./searchable');
const { scanSettings } = require('./scan-config');
const { findListingUrl: defaultFindListingUrl } = require('./forms');
const { captureSubmitSnapshot } = require('./snapshot');

const SCAN_HISTORY_MAX = 10;
const OUTCOMES = new Set(['found', 'not_found', 'unknown']);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const isoDay = (iso) => String(iso).slice(0, 10);

// ─── reading and writing the scan records ────────────────────────────────────

function _own(entry, person) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (!entry.fp || !person || fingerprintMatches(entry.fp, person)) return entry;
  return undefined;
}

const _atMs = (entry) => {
  const t = Date.parse(entry && entry.at);
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The latest scan record for a (broker, person), or undefined. Mirrors readEntry's
 * handling of the bare and composite keys: persons[0] keeps what was recorded before a
 * second person was added, and when the person count falls back to one the newer of
 * the two entries wins. A record stamped for a different identity is not theirs.
 *
 * @param {{ scans?: object }} state
 * @param {string} brokerName
 * @param {object|null} person
 * @param {number|undefined} personCount
 * @param {{ personIndex?: number, persons?: object[] }} [opts]
 */
function readScan(state, brokerName, person, personCount, opts) {
  const scans = (state && state.scans) || {};
  const key = stateKey(brokerName, person, personCount);
  const composite = person ? `${brokerName}|${person.firstName} ${person.lastName}` : null;
  const newest = (a, b) => (!a ? b : !b ? a : _atMs(b) > _atMs(a) ? b : a);

  if (key === brokerName) {
    return newest(_own(scans[brokerName], person), composite ? _own(scans[composite], person) : undefined);
  }
  if (scans[key] !== undefined) return _own(scans[key], person);
  const first = opts && opts.personIndex !== undefined && opts.personIndex !== null
    ? opts.personIndex === 0
    : Boolean(opts && Array.isArray(opts.persons) && opts.persons[0] && person
      && opts.persons[0].firstName === person.firstName && opts.persons[0].lastName === person.lastName);
  return first ? _own(scans[brokerName], person) : undefined;
}

/**
 * Record one result as the latest for a (broker, person).
 *
 * @param {object} state  mutated: state.scans[key] is replaced
 * @param {{ brokerName: string, person: object, personCount: number, persons?: object[], personIndex?: number }} ref
 * @param {{ outcome: string, at?: string, listingUrl?: string, reason?: string, screenshot?: string, source?: string, searchHash?: string }} result
 */
function recordScan(state, ref, result) {
  if (!OUTCOMES.has(result.outcome)) {
    throw new Error(`recordScan: outcome must be found, not_found or unknown (got ${String(result.outcome)})`);
  }
  const { brokerName, person, personCount } = ref;
  const at = result.at || new Date().toISOString();
  const prev = readScan(state, brokerName, person, personCount, ref) || {};
  // A result that names no search of its own (the broker list could not be built, so
  // nothing was searched) says nothing about the search the old record came from: it keeps
  // that record's hash and sighting. A result for a DIFFERENT search starts the sighting
  // over, and so does one that replaces a record with no hash: what an old search saw
  // is not evidence about this one (S1).
  const sh = result.searchHash || prev.sh;
  const sameSearch = !result.searchHash || (prev.sh && prev.sh === result.searchHash);
  const lastFoundAt = result.outcome === 'found' ? at : (sameSearch ? prev.lastFoundAt : undefined);
  // A sighting by an ordinary run replaces the latest result, but must not erase the
  // fact that a scan was done (hasAnyScan, for --found-only's "scan first" check).
  const lastScanAt = result.source === 'run' ? (prev.lastScanAt || (prev.source !== 'run' ? prev.at : undefined)) : at;
  const history = [...(Array.isArray(prev.history) ? prev.history : []), { at, outcome: result.outcome }].slice(-SCAN_HISTORY_MAX);
  const fp = personFingerprint(person);

  if (!state.scans || typeof state.scans !== 'object') state.scans = {};
  state.scans[stateKey(brokerName, person, personCount)] = {
    at,
    outcome: result.outcome,
    ...(result.outcome === 'found' && result.listingUrl ? { listingUrl: result.listingUrl } : {}),
    ...(result.outcome === 'unknown' && result.reason ? { reason: result.reason } : {}),
    ...(result.outcome === 'found' && result.screenshot ? { screenshot: result.screenshot } : {}),
    ...(lastFoundAt ? { lastFoundAt } : {}),
    ...(lastScanAt ? { lastScanAt } : {}),
    ...(result.source ? { source: result.source } : {}),
    history,
    ...(fp ? { fp } : {}),
    ...(sh ? { sh } : {}),
  };
}

/**
 * Whether a listing was actually seen for this (broker, person) at any earlier point:
 * by a scan, or by a verify that found one (verifiedStillListedAt). A removal only
 * counts as verified when this is true; an old verifiedDeletedAt on its own is NOT a
 * sighting (older versions wrote it whenever the search page was empty, so it proves
 * nothing about a listing).
 */
function hasSeenListing(state, brokerName, person, personCount, opts) {
  const scan = readScan(state, brokerName, person, personCount, opts);
  // With the current search's hash given, only a sighting made by THAT search counts (S1).
  const sameSearch = !opts || !opts.searchHash || (scan && scan.sh === opts.searchHash);
  if (scan && sameSearch && (scan.lastFoundAt || scan.outcome === 'found')) return true;
  const entry = readEntry(state, brokerName, person, personCount, opts);
  return Boolean(entry && entry.verifiedStillListedAt);
}

/** True once an `aidr scan` has recorded anything. A sighting made by an ordinary run does not count. */
function hasAnyScan(state) {
  const scans = (state && state.scans) || {};
  return Object.values(scans).some(e => e && (e.lastScanAt || (e.at && e.source !== 'run')));
}

// ─── the --found-only decision ───────────────────────────────────────────────

/**
 * Whether `aidr run --found-only` submits to one broker for one person.
 *
 * Pure: the scan record (or undefined), whether the broker can be searched, the hash
 * of the search the person would make there NOW, the config and today's date in, a
 * decision out.
 *
 *   found, fresh        -> submit
 *   not_found, fresh    -> skip, always (the scan looked and you were not there)
 *   anything we cannot use: could not tell, older than scan.maxAgeDays, never scanned,
 *   cannot be searched -> follows scan.unknown ("submit" by default, or "skip")
 *
 * @returns {{ action: 'submit'|'skip', basis: string, reason: string }}
 *   basis: found | not_found | unknown | stale | missing | unsearchable
 */
function decideFoundOnly({ scan, searchable, config, now, searchHash: currentSearch }) {
  const { unknown: policy, maxAgeDays } = scanSettings(config);
  const unusable = (basis, why) => ({
    action: policy,
    basis,
    reason: `${why}; scan.unknown is "${policy}"`,
  });

  if (!searchable) return unusable('unsearchable', 'this broker cannot be searched');
  if (!scan || typeof scan !== 'object') return unusable('missing', 'never scanned');
  // A result is only about the search it came from. One for a different search (a state
  // or a name changed since) or with no hash at all (older code) was never made for these
  // details, so it is no better than no scan (S1).
  if (!currentSearch || !scan.sh || scan.sh !== currentSearch) {
    return unusable('missing', 'never scanned with the current details (the record is for a different search, or from an older version)');
  }

  const atMs = Date.parse(scan.at);
  const ageDays = Number.isNaN(atMs) ? Infinity : ((now || new Date()).getTime() - atMs) / MS_PER_DAY;
  if (ageDays > maxAgeDays) {
    const age = Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'of unknown age';
    return unusable('stale', `the scan is ${age} (limit ${maxAgeDays})`);
  }

  if (scan.outcome === 'found') {
    return { action: 'submit', basis: 'found', reason: `listed (scan of ${isoDay(scan.at)})` };
  }
  if (scan.outcome === 'not_found') {
    return { action: 'skip', basis: 'not_found', reason: `not listed (scan of ${isoDay(scan.at)})` };
  }
  const why = scan.reason ? `the scan could not tell (${scan.reason})` : 'the scan could not tell';
  return unusable('unknown', why);
}

/**
 * Split one person's broker list into what `--found-only` submits and what it skips.
 * Order is kept. `brokers` are that person's OWN definitions (searchUrl carries their
 * name), so canSearch is asked of the right broker.
 *
 * @returns {{ submit: object[], skipped: Array<{ broker: object, decision: object }> }}
 */
function applyFoundOnly({ brokers, person, personCount, persons, personIndex, state, config, now }) {
  const submit = [];
  const skipped = [];
  for (const broker of brokers) {
    const decision = decideFoundOnly({
      scan: readScan(state, broker.name, person, personCount, { persons, personIndex }),
      searchable: canSearch(broker),
      searchHash: searchHash(broker.searchUrl),
      config,
      now,
    });
    if (decision.action === 'submit') submit.push(broker);
    else skipped.push({ broker, decision });
  }
  return { submit, skipped };
}

// ─── the scan itself ─────────────────────────────────────────────────────────

// A reason ends up in state.json and on screen. Playwright puts the URL it was loading
// into its messages, and these URLs carry the person's name and city, so every URL is cut
// down to its host.
function safeReason(err) {
  const raw = (err && err.message) || String(err);
  return raw
    .replace(/https?:\/\/[^\s'")]+/gi, (url) => { try { return new URL(url).hostname; } catch (_) { return 'url'; } })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// The details this broker's search URL is built from that the person does not have.
// `searchNeeds` is declared per broker in brokers.js; field names only, never values.
function blankSearchInputs(broker, person) {
  const needs = Array.isArray(broker && broker.searchNeeds) ? broker.searchNeeds : [];
  return needs.filter(field => !String((person && person[field]) == null ? '' : person[field]).trim());
}

const outsideUs = (person) => String((person && person.country) || 'US').trim().toUpperCase() !== 'US';

/**
 * Search every broker that can be searched, for every person, and record the latest
 * result for each pair in state.scans. Submits nothing and sends nothing.
 *
 * Modelled on runVerify (lib/verify-loop.js): person by person, each with their OWN
 * broker list (brokers.js bakes the person's name and city into searchUrl) and their
 * OWN browser context, and a thrown error from the search is "could not tell", never
 * "not found".
 *
 * @param {object|null} context  Playwright context (used when opts.contextFor is absent)
 * @param {object[]} brokers
 * @param {object[]} persons
 * @param {object} opts
 * @param {object}   opts.state       the state object; state.scans is written
 * @param {Function} [opts.findUrl]   injectable findListingUrl (tests)
 * @param {Function} [opts.brokersFor] (person) => broker[] built for that person
 * @param {Function} [opts.contextFor] (person, index) => context | Promise<context>
 * @param {Function} [opts.snapshot]  injectable screenshot helper (page, name) => path | null
 * @param {object}   [opts.config]    for the allowlist
 * @param {Date}     [opts.now]
 * @returns {Promise<{ found: object[], not_found: object[], unknown: object[], unsearchable: object[], skipped: object[] }>}
 */
async function runScan(context, brokers, persons, opts = {}) {
  const { state, config = null, brokersFor, contextFor, warn } = opts;
  const findUrl = opts.findUrl || defaultFindListingUrl;
  const snapshot = opts.snapshot || captureSubmitSnapshot;
  const now = opts.now instanceof Date ? opts.now : new Date();

  if (!state || typeof state !== 'object') {
    throw new Error('runScan: opts.state must be a state object');
  }

  const found = [];
  const not_found = [];
  const unknown = [];
  const unsearchable = [];
  const skipped = [];

  if (typeof brokersFor !== 'function' && persons.length > 1) {
    (warn || console.warn)(
      'runScan: more than one person but no opts.brokersFor; every person is searched with ' +
      'the same broker list. Pass brokersFor so each person gets their own search URL.'
    );
  }

  const allowlistReported = new Set();

  for (const [personIndex, person] of persons.entries()) {
    // This person's browser, asked for only when there is something to search, and
    // remembered: a Chromium that would not start fails once, not once per broker.
    let opened = null;
    const browserFor = async () => {
      if (!opened) {
        opened = typeof contextFor !== 'function'
          ? { context }
          : await Promise.resolve()
            .then(() => contextFor(person, personIndex))
            .then(ctx => ({ context: ctx }), err => ({ error: safeReason(err) }));
      }
      return opened;
    };

    let byName = null;
    let listError = null;
    if (typeof brokersFor === 'function') {
      try {
        byName = new Map((brokersFor(person) || []).map(b => [b.name, b]));
      } catch (err) {
        listError = safeReason(err);
      }
    }

    const ref = (broker) => ({
      brokerName: broker.name, person, personCount: persons.length, persons, personIndex,
    });
    // The hash of the search THIS person's broker entry would make, set once the entry is known.
    let searchedAs = null;
    const save = (broker, result) => recordScan(state, ref(broker), {
      ...result, at: now.toISOString(), ...(searchedAs ? { searchHash: searchedAs } : {}),
    });
    const cannotTell = (broker, reason) => {
      save(broker, { outcome: 'unknown', reason });
      unknown.push({ broker: broker.name, person, reason });
    };

    for (const broker of brokers) {
      searchedAs = null;
      // The user wants to stay listed here, so there is nothing to look for.
      if (isAllowlisted(broker.name, config)) {
        if (!allowlistReported.has(broker.name)) {
          allowlistReported.add(broker.name);
          skipped.push({ broker: broker.name, reason: 'on allowlist - keeping listing, scan skipped' });
        }
        continue;
      }

      let personBroker = broker;
      if (typeof brokersFor === 'function') {
        if (listError) {
          if (canSearch(broker)) cannotTell(broker, `could not build broker list for this person: ${listError}`);
          else unsearchable.push({ broker: broker.name, person });
          continue;
        }
        personBroker = byName.get(broker.name);
        if (!personBroker) {
          unsearchable.push({ broker: broker.name, person });
          continue;
        }
      }

      if (!canSearch(personBroker)) {
        unsearchable.push({ broker: broker.name, person });
        continue;
      }
      if (personBroker.usOnly && outsideUs(person)) {
        skipped.push({ broker: broker.name, person, reason: 'US-only broker - not searched for a non-US person' });
        continue;
      }
      if (personBroker.skipReason) {
        skipped.push({ broker: broker.name, person, reason: personBroker.skipReason });
        continue;
      }

      searchedAs = searchHash(personBroker.searchUrl);

      // A search URL built from a blank name or state does not look for this person, so
      // its "no listing" would say nothing about them (S1). Said, never recorded as not found.
      const blank = blankSearchInputs(personBroker, person);
      if (blank.length > 0) {
        cannotTell(broker, `not searched: ${blank.join(' and ')} ${blank.length > 1 ? 'are' : 'is'} blank in config.json, so the search address would not name you`);
        continue;
      }

      const browser = await browserFor();
      if (browser.error) {
        cannotTell(broker, `search failed: browser unavailable (${browser.error.slice(0, 160)})`);
        continue;
      }

      let page;
      try {
        page = await browser.context.newPage();
      } catch (err) {
        cannotTell(broker, `search failed: could not open a page (${safeReason(err)})`);
        continue;
      }

      let listingUrl = null;
      let searchError = null;
      let screenshot = null;
      try {
        listingUrl = await findUrl(page, personBroker, person);
        // The page is still showing the results, which is the evidence. The helper
        // writes it with private permissions and never throws.
        if (typeof listingUrl === 'string' && listingUrl) {
          screenshot = await snapshot(page, `scan-${broker.name}`).catch(() => null);
        }
      } catch (err) {
        // A thrown error (UNVERIFIABLE: bot wall, failed navigation, non-2xx; or
        // anything else) is "could not tell". It is never recorded as not found.
        searchError = safeReason(err);
      } finally {
        await page.close().catch(() => {});
      }

      if (searchError) {
        cannotTell(broker, `search failed: ${searchError}`);
        continue;
      }
      // findListingUrl returns null for "the page loaded and shows no listing" and a
      // string for the listing. Anything else is a contract breach, not an answer.
      if (listingUrl !== null && !(typeof listingUrl === 'string' && listingUrl)) {
        cannotTell(broker, `search failed: unexpected result from listing search (${typeof listingUrl})`);
        continue;
      }

      if (listingUrl) {
        save(broker, { outcome: 'found', listingUrl, screenshot: screenshot || undefined });
        found.push({ broker: broker.name, person, listingUrl, ...(screenshot ? { screenshot } : {}) });
      } else {
        save(broker, { outcome: 'not_found' });
        not_found.push({ broker: broker.name, person });
      }
    }
  }

  return { found, not_found, unknown, unsearchable, skipped };
}

module.exports = {
  SCAN_HISTORY_MAX,
  readScan,
  recordScan,
  hasSeenListing,
  hasAnyScan,
  decideFoundOnly,
  applyFoundOnly,
  runScan,
};
