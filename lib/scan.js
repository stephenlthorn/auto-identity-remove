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
const FUTURE_TOLERANCE_DAYS = 1;

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
 * Two people with the same first and last name share ONE key here, as they do in the opt-out
 * entries (the key scheme is deliberately left alone: both stores use it). What stops one of
 * them being judged on the other's result is the search hash (S1): their search addresses
 * differ whenever their state or full name does, so the hash no longer matches and the record
 * counts as never scanned. What remains: two same-named people who search to the SAME address
 * (same state, same full name) and differ only in zip or email share a result, and the
 * identity fingerprint (zip and email) is what separates them in readScan above.
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
 * nothing about a listing). For a broker with method `search-form` (opts.method) a recorded
 * submission is a sighting: see the comment in the body.
 */
function hasSeenListing(state, brokerName, person, personCount, opts) {
  const scan = readScan(state, brokerName, person, personCount, opts);
  // With the current search's hash given, only a sighting made by THAT search counts (S1).
  const sameSearch = !opts || !opts.searchHash || (scan && scan.sh === opts.searchHash);
  if (scan && sameSearch && (scan.lastFoundAt || scan.outcome === 'found')) return true;
  const entry = readEntry(state, brokerName, person, personCount, opts);
  if (entry && entry.verifiedStillListedAt) return true;
  // A broker whose run does the search step FIRST (method search-form) only reaches
  // recordSuccess after that search found a listing, so its lastSuccess is a sighting too.
  // That is what makes a submission from before scans existed count. A direct-form broker
  // that merely HAS a search step (USPhonebook) does not qualify: it submitted without
  // looking, so its lastSuccess proves nothing about a listing (S3).
  return Boolean(entry && entry.lastSuccess && opts && opts.method === 'search-form');
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
 *   not_found, fresh, from a search step validated live (`validated`) -> skip, always
 *   anything we cannot use: could not tell, older than scan.maxAgeDays, never scanned (or
 *   scanned for different details), cannot be searched, or an empty result from a search step
 *   that was never validated -> follows scan.unknown ("submit" by default, or "skip")
 *
 * @returns {{ action: 'submit'|'skip', basis: string, reason: string }}
 *   basis: found | not_found | unknown | unvalidated | stale | missing | unsearchable
 */
function decideFoundOnly({ scan, searchable, validated, config, now, searchHash: currentSearch }) {
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

  const clock = now || new Date();
  const atMs = Date.parse(scan.at);
  const ageDays = Number.isNaN(atMs) ? Infinity : (clock.getTime() - atMs) / MS_PER_DAY;
  // A record dated in the future (a wrong clock, a NAS that lost its battery) would never
  // go stale on its own and would be trusted for as long as the clock stays wrong, so
  // anything more than a day ahead is unusable. A few hours of drift is tolerated (S10).
  if (ageDays < -FUTURE_TOLERANCE_DAYS) {
    return unusable('stale', `the scan is dated ${isoDay(scan.at)}, which is in the future (check this machine's clock)`);
  }
  if (ageDays > maxAgeDays) {
    const age = Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'of unknown age';
    return unusable('stale', `the scan is ${age} (limit ${maxAgeDays})`);
  }

  if (scan.outcome === 'found') {
    return { action: 'submit', basis: 'found', reason: `listed (scan of ${isoDay(scan.at)})` };
  }
  if (scan.outcome === 'not_found' && validated) {
    return { action: 'skip', basis: 'not_found', reason: `not listed (scan of ${isoDay(scan.at)})` };
  }

  // The latest result is one that cannot say "not listed": it could not tell, or it came back
  // empty from a search step nobody validated live (S8). A listing seen inside the window by
  // this same search is still the best evidence there is, so it stands (S5): a bot wall two
  // days ago must not undo a sighting from five. A later VALIDATED not_found is the one thing
  // that overrides a sighting, and it was handled above.
  const seenMs = Date.parse(scan.lastFoundAt);
  const seenAgeDays = Number.isNaN(seenMs) ? Infinity : (clock.getTime() - seenMs) / MS_PER_DAY;
  if (seenAgeDays >= -FUTURE_TOLERANCE_DAYS && seenAgeDays <= maxAgeDays) {
    return { action: 'submit', basis: 'found', reason: `listed (scan of ${isoDay(scan.lastFoundAt)}); a later scan could not confirm it, so the sighting stands` };
  }

  if (scan.outcome === 'not_found') {
    // Only a search step validated live in both directions may say "not listed" (S8): a site
    // whose result links stopped matching listingPattern gives an empty answer on a normal
    // results page too. For the rest it is "no listing seen", and follows scan.unknown.
    return unusable('unvalidated', "no listing was seen, but this broker's search step has not been validated, so an empty result cannot show you are not listed");
  }
  const why = scan.reason ? `the scan could not tell (${scan.reason})` : 'the scan could not tell';
  return unusable('unknown', why);
}

// A record that came from `aidr scan` (as opposed to a sighting an ordinary run noted on its
// way past, which says nothing about the brokers it did not look at).
const isScanRecord = (rec) => Boolean(rec && typeof rec === 'object' && (rec.lastScanAt || (rec.at && rec.source !== 'run')));

/**
 * Split one person's broker list into what `--found-only` submits and what it skips.
 * Order is kept. `brokers` are that person's OWN definitions (searchUrl carries their
 * name), so canSearch is asked of the right broker.
 *
 * `decisions` has every broker's decision, whatever the action, for the overview
 * (lib/scan-report.js). `usable` counts the ones that rest on a real scan result: a found
 * or not_found from `aidr scan` itself that this person's current search stands behind.
 *
 * @returns {{ submit: object[], skipped: Array<{ broker: object, decision: object }>, decisions: Array<{ broker: object, decision: object }>, usable: number }}
 */
function applyFoundOnly({ brokers, person, personCount, persons, personIndex, state, config, now }) {
  const submit = [];
  const skipped = [];
  const decisions = [];
  let usable = 0;
  for (const broker of brokers) {
    const scan = readScan(state, broker.name, person, personCount, { persons, personIndex });
    const decision = decideFoundOnly({
      scan,
      searchable: canSearch(broker),
      validated: Boolean(broker.searchCheckedAt),
      searchHash: searchHash(broker.searchUrl),
      config,
      now,
    });
    decisions.push({ broker, decision });
    if ((decision.basis === 'found' || decision.basis === 'not_found') && isScanRecord(scan)) usable += 1;
    if (decision.action === 'submit') submit.push(broker);
    else skipped.push({ broker, decision });
  }
  return { submit, skipped, decisions, usable };
}

/**
 * Whether ANY person has ANY usable scan result for ANY broker that can be searched. This is
 * the gate in front of `--found-only`: with none, every broker would be "never scanned" or
 * stale and the run would be a full run that only looks filtered (S2).
 *
 * @param {{ brokersFor: (person: object) => object[], persons: object[], state: object, config: object, now?: Date }} args
 */
function hasUsableScan({ brokersFor, persons, state, config, now }) {
  return persons.some((person, personIndex) => {
    const brokers = brokersFor(person).filter(canSearch);
    return applyFoundOnly({ brokers, person, personCount: persons.length, persons, personIndex, state, config, now }).usable > 0;
  });
}

// ─── email entries (S7) ──────────────────────────────────────────────────────

// Two-part public suffixes seen in broker addresses. Anything else takes the last two labels.
const TWO_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp', 'co.in']);

/** "privacy.example.co.uk" -> "example.co.uk"; "www.spokeo.com" -> "spokeo.com". */
function registrableDomain(host) {
  const labels = String(host || '').trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };
const mailDomain = (address) => String(address || '').split('@').pop();

/**
 * The registrable domains an entry stands for: its opt-out and search pages, and the domain
 * of its email address.
 */
function companyDomains(broker) {
  return [hostOf(broker.optOutUrl), hostOf(broker.searchUrl), mailDomain(broker.emailTo)]
    .map(registrableDomain).filter(Boolean);
}

/**
 * What `--found-only` does with the email opt-outs of one person (S7). An email entry is
 * itself unsearchable, so it used to follow scan.unknown alone and the Spokeo opt-out email
 * went out while the Spokeo form was skipped as not listed. It now follows the decision of a
 * searchable entry for the same company: one whose pages share a registrable domain with the
 * email address's domain (or, failing that, whose name is the email entry's name without its
 * " (email)"). With several such entries any submit wins, the safe direction. With none it
 * follows scan.unknown, as before.
 *
 * @param {{ emailBrokers: object[], decisions: Array<{ broker: object, decision: { action: string, reason: string } }>, config: object }} args
 *   `decisions` are the person's decisions for their searchable entries (applyFoundOnly)
 * @returns {{ send: Set<string>, skipped: Array<{ broker: object, reason: string }> }}
 */
function foundOnlyEmailPlan({ emailBrokers, decisions, config }) {
  const { unknown: policy } = scanSettings(config);
  const siblings = decisions.filter(d => canSearch(d.broker));
  const send = new Set();
  const skipped = [];

  for (const mail of emailBrokers) {
    const own = new Set([registrableDomain(mailDomain(mail.emailTo)), registrableDomain(hostOf(mail.optOutUrl))].filter(Boolean));
    const baseName = String(mail.name).replace(/\s*\(email\)\s*$/i, '').trim().toLowerCase();
    const same = siblings.filter(({ broker }) => (
      companyDomains(broker).some(d => own.has(d)) || broker.name.trim().toLowerCase() === baseName
    ));

    if (same.length === 0) {
      if (policy === 'submit') send.add(mail.name);
      else skipped.push({ broker: mail, reason: `no searchable entry for this company, so it follows scan.unknown; scan.unknown is "${policy}"` });
      continue;
    }
    if (same.some(d => d.decision.action === 'submit')) {
      send.add(mail.name);
    } else {
      const first = same[0];
      skipped.push({ broker: mail, reason: `follows ${first.broker.name}: ${first.decision.reason}` });
    }
  }
  return { send, skipped };
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
 * @returns {Promise<{ found: object[], not_found: object[], unvalidated: object[], unknown: object[], unsearchable: object[], skipped: object[] }>}
 *   not_found is an empty result from a search step validated live (searchCheckedAt); an empty
 *   result from any other search step is in `unvalidated`
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
  const unvalidated = [];
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
        // Kept apart: an empty answer from a search step nobody validated live is not a
        // finding about the person (S8). The record is the plain fact; the reading is here.
        (personBroker.searchCheckedAt ? not_found : unvalidated).push({ broker: broker.name, person });
      }
    }
  }

  return { found, not_found, unvalidated, unknown, unsearchable, skipped };
}

module.exports = {
  SCAN_HISTORY_MAX,
  readScan,
  recordScan,
  hasSeenListing,
  hasAnyScan,
  decideFoundOnly,
  applyFoundOnly,
  hasUsableScan,
  foundOnlyEmailPlan,
  registrableDomain,
  runScan,
};
