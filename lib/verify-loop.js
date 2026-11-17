/**
 * lib/verify-loop.js
 *
 * T+7 day post-submit verification loop (audit section 2.1).
 *
 * runVerify(context, brokers, persons, opts) re-searches each (person, broker)
 * pair where an opt-out was submitted >= 7 days ago and the listing has not
 * already been confirmed gone since that submission.  Each person is searched
 * with THEIR OWN broker definitions (opts.brokersFor(person)): brokers.js bakes
 * the person's name/city into searchUrl, so reusing persons[0]'s list would
 * record person B as verified clear from person A's search (NET-4b / CORE-2).
 * It writes outcome fields
 * directly to state.optOuts so the next audit summary can report "removed:
 * N verified, M submitted-but-unverified" instead of treating submit as success.
 *
 * State fields written (under state.optOuts[key] for each person-broker pair):
 *   verifiedDeletedAt      - ISO string, set when the listing is gone AFTER one was seen
 *                            (a scan or an earlier verify found it): a real removal
 *   verifiedAbsentAt       - ISO string, set when the search page shows no listing and
 *                            none was ever seen. NOT a removal: nothing was proved there
 *   verifiedStillListedAt  - ISO string, set when listing is still found (also the
 *                            record that a listing was seen)
 *   verifyHistory          - array of { at: ISO, outcome: string }
 *                            outcome: still_listed | verified_clear | never_seen
 *
 * Per-person state key convention:
 *   Single-person mode    → state.optOuts[broker.name]
 *   Multi-person mode     → state.optOuts["broker.name|FirstName LastName"]
 *   (This mirrors whatever key was written by recordSuccess for that person.)
 *
 * Result object:
 *   {
 *     verified_clear: [{ broker, person }],   a listing was seen before and is gone now
 *     never_seen:     [{ broker, person }],   no listing now, and none was ever seen
 *     still_listed:   [{ broker, person }],
 *     unverifiable:   [{ broker, person, reason }],
 *     skipped:        [{ broker, reason }],
 *   }
 */

'use strict';

const { findListingUrl: defaultFindListingUrl } = require('./forms');
const { stateKey, readEntry } = require('./config');
const { isAllowlisted } = require('./filter');
const { canSearch } = require('./searchable');
const { hasSeenListing, readScan } = require('./scan');
const { sightingMs } = require('./sighting');
const { searchHash } = require('./identity');

const VERIFY_AFTER_DAYS = 7; // minimum days after lastSuccess before we re-check
const HISTORY_MAX = 20;      // cap verifyHistory to avoid unbounded growth

/**
 * Run T+7 verification for all eligible (person, broker) pairs.
 *
 * @param {object}   context  - Playwright BrowserContext (or stub for tests)
 * @param {object[]} brokers  - broker definitions array
 * @param {object[]} persons  - array of person config objects
 * @param {object}   opts
 * @param {object}   opts.state    - shared state object ({ optOuts: {...} })
 * @param {Function} [opts.findUrl] - injectable override for findListingUrl (tests)
 * @param {Function} [opts.brokersFor] - (person) => broker[] built for that person
 *                                       (watcher: p => brokers.forPerson(p)). Without it
 *                                       the `brokers` argument is used for everyone.
 * @param {Function} [opts.contextFor] - (person, index) => context | Promise<context>: the browser
 *                                       context for THAT person (R7: one profile per person; the
 *                                       watcher passes (p, i) => contexts.forPerson(i)). The loop
 *                                       then runs person by person so a context is swapped once per
 *                                       person, not once per broker, and asks for one only when
 *                                       something has to be searched. Results keep the same order.
 *                                       Without it, `context` serves everyone as before.
 * @param {Function} [opts.warn]    - warning sink (default console.warn)
 * @returns {Promise<VerifyLoopResult>}
 */
async function runVerify(context, brokers, persons, opts = {}) {
  const { state, findUrl: injectedFindUrl, config = null, brokersFor, warn, contextFor } = opts;
  const findUrl = injectedFindUrl || defaultFindListingUrl;

  if (!state || !state.optOuts) {
    throw new Error('runVerify: opts.state must be a state object with an optOuts property');
  }

  /** @type {Array<{broker: string, person: object}>} */
  const verified_clear = [];
  /** @type {Array<{broker: string, person: object}>} */
  const never_seen     = [];
  /** @type {Array<{broker: string, person: object}>} */
  const still_listed   = [];
  /** @type {Array<{broker: string, person: object, reason: string}>} */
  const unverifiable   = [];
  /** @type {Array<{broker: string, reason: string}>} */
  const skipped        = [];

  const now = new Date();

  // With a context per person the work is done person by person (one browser swap
  // per person), but callers have always read the results broker first, then person.
  // Every entry remembers its (broker, person) position and the lists are put back
  // in that order at the end.
  const position = new Map();
  const add = (list, entry, brokerIndex, personIndex) => {
    position.set(entry, [brokerIndex, personIndex]);
    list.push(entry);
  };
  const byPosition = (a, b) => {
    const [ab, ap] = position.get(a);
    const [bb, bp] = position.get(b);
    return ab - bb || ap - bp;
  };

  // person index -> Promise<{ context } | { error }>. A person whose browser would
  // not start fails once and stays failed: retrying per broker would relaunch a
  // broken Chromium dozens of times.
  const contexts = new Map();
  function contextOf(person, personIndex) {
    if (typeof contextFor !== 'function') return Promise.resolve({ context });
    if (!contexts.has(personIndex)) {
      contexts.set(personIndex, Promise.resolve()
        .then(() => contextFor(person, personIndex))
        .then(found => ({ context: found }), err => ({ error: (err && err.message) || String(err) })));
    }
    return contexts.get(personIndex);
  }

  if (typeof brokersFor !== 'function' && persons.length > 1) {
    (warn || console.warn)(
      'runVerify: more than one person but no opts.brokersFor; every person is searched ' +
      'with the same broker list. Pass brokersFor so each person gets their own search URL.'
    );
  }

  // person -> { byName } | { error }. Built once per person, lazily.
  const perPerson = new Map();
  function brokerForPerson(person, broker) {
    if (typeof brokersFor !== 'function') return { broker };
    let entry = perPerson.get(person);
    if (!entry) {
      try {
        entry = { byName: new Map((brokersFor(person) || []).map(b => [b.name, b])) };
      } catch (err) {
        entry = { error: (err && err.message) || String(err) };
      }
      perPerson.set(person, entry);
    }
    if (entry.error) return { reason: `could not build broker list for this person: ${entry.error}` };
    const found = entry.byName.get(broker.name);
    return found ? { broker: found } : { reason: 'broker missing from this person\'s broker list' };
  }

  const pairs = [];
  if (typeof contextFor === 'function') {
    persons.forEach((person, personIndex) => brokers.forEach((broker, brokerIndex) => pairs.push({ broker, brokerIndex, person, personIndex })));
  } else {
    brokers.forEach((broker, brokerIndex) => persons.forEach((person, personIndex) => pairs.push({ broker, brokerIndex, person, personIndex })));
  }

  const allowlistReported = new Set();

  for (const { broker, brokerIndex, person, personIndex } of pairs) {
    // ── Gate 0: allowlisted brokers are never verified (the user wants to stay
    // listed, so a found listing is not a failure). Recorded once per broker. ─
    if (isAllowlisted(broker.name, config)) {
      if (!allowlistReported.has(brokerIndex)) {
        allowlistReported.add(brokerIndex);
        add(skipped, { broker: broker.name, reason: 'on allowlist - keeping listing, verification skipped' }, brokerIndex, -1);
      }
      continue;
    }

    const key    = stateKey(broker.name, person, persons.length);
    // Read through the person-aware reader: persons[0]'s history from before a
    // second person was added sits under the bare broker name. Results are
    // written under `key`, which migrates it to the multi-person layout.
    const record = readEntry(state, broker.name, person, persons.length, { persons });

    // ── Gate 1: must have a recorded lastSuccess ──────────────────────────
    if (!record || !record.lastSuccess) {
      add(skipped, { broker: broker.name, person, reason: 'no recorded opt-out submission' }, brokerIndex, personIndex);
      continue;
    }

    const lastSuccessMs = new Date(record.lastSuccess).getTime();
    const daysSinceSuccess = (now.getTime() - lastSuccessMs) / (1000 * 60 * 60 * 24);

    // ── Gate 2: must be >= VERIFY_AFTER_DAYS since submission ─────────────
    if (daysSinceSuccess < VERIFY_AFTER_DAYS) {
      const daysLeft = Math.ceil(VERIFY_AFTER_DAYS - daysSinceSuccess);
      add(skipped, {
        broker: broker.name,
        person,
        reason: `too recent - verify in ${daysLeft}d (submitted ${Math.floor(daysSinceSuccess)}d ago)`,
      }, brokerIndex, personIndex);
      continue;
    }

    // A listing seen AFTER one of the "found nothing" checks below (a scan, a run's own
    // search or an earlier verify) outranks it: that check is out of date, so it is searched
    // again instead of being skipped as already settled (S4).
    const sighting = sightingMs({ entry: record, scan: readScan(state, broker.name, person, persons.length, { persons }) });
    const seenSince = (iso) => sighting > new Date(iso).getTime();

    // ── Gate 3: skip if already verified clear AFTER the last submission ──
    if (record.verifiedDeletedAt) {
      const verifiedMs = new Date(record.verifiedDeletedAt).getTime();
      if (verifiedMs > lastSuccessMs && !seenSince(record.verifiedDeletedAt)) {
        // Already confirmed gone since the last submission - nothing new to check.
        add(skipped, {
          broker: broker.name,
          person,
          reason: 'already verified clear since last submission',
        }, brokerIndex, personIndex);
        continue;
      }
      // verifiedDeletedAt is older than lastSuccess - a new submission was
      // recorded after the last verify, so we should re-check.
    }

    // Found absent (never seen) since the last submission: the same, nothing new
    // to learn until the next submission.
    if (record.verifiedAbsentAt && new Date(record.verifiedAbsentAt).getTime() > lastSuccessMs && !seenSince(record.verifiedAbsentAt)) {
      add(skipped, {
        broker: broker.name,
        person,
        reason: 'already found absent since last submission',
      }, brokerIndex, personIndex);
      continue;
    }

    // ── Gate 4: must be verifiable (a search page + a listing pattern, whatever the method) ─
    const resolved = brokerForPerson(person, broker);
    if (!resolved.broker) {
      add(unverifiable, { broker: broker.name, person, reason: resolved.reason }, brokerIndex, personIndex);
      continue;
    }
    const personBroker = resolved.broker;
    if (!canSearch(personBroker)) {
      add(unverifiable, {
        broker: broker.name,
        person,
        reason: 'no automated search signal (email / manual or missing searchUrl/listingPattern)',
      }, brokerIndex, personIndex);
      continue;
    }

    // ── Search ────────────────────────────────────────────────────────────
    // This person's browser. Asked for only now, so a person with nothing to search
    // never costs a Chromium launch; one that would not start is "could not tell".
    const opened = await contextOf(person, personIndex);
    if (opened.error) {
      add(unverifiable, { broker: broker.name, person, reason: `search failed: browser unavailable (${opened.error.slice(0, 160)})` }, brokerIndex, personIndex);
      continue;
    }
    const page = await opened.context.newPage();
    let listingUrl = null;
    let searchError = null;

    try {
      // Pass person to findListingUrl so multi-person brokers can parameterise the search.
      listingUrl = await findUrl(page, personBroker, person);
    } catch (err) {
      // A thrown error (including err.code === 'UNVERIFIABLE' from
      // findListingUrl: failed navigation, non-2xx, bot wall) is "could not
      // tell". It never records verifiedDeletedAt or verified_clear.
      searchError = ((err && err.message) || String(err)).slice(0, 200);
    } finally {
      await page.close().catch(() => {});
    }

    if (searchError) {
      add(unverifiable, {
        broker: broker.name,
        person,
        reason: `search failed: ${searchError}`,
      }, brokerIndex, personIndex);
      continue;
    }

    // Contract with findListingUrl: null means the search page loaded fine and
    // has no matching listing; a string is the listing. Anything else is a
    // contract breach and must never read as "verified clear".
    if (listingUrl !== null && !(typeof listingUrl === 'string' && listingUrl)) {
      add(unverifiable, {
        broker: broker.name,
        person,
        reason: `search failed: unexpected result from listing search (${typeof listingUrl})`,
      }, brokerIndex, personIndex);
      continue;
    }

    // ── Record outcome ────────────────────────────────────────────────────
    const at = now.toISOString();
    const prevHistory = Array.isArray(record.verifyHistory) ? record.verifyHistory : [];

    if (listingUrl) {
      state.optOuts[key] = {
        ...record,
        verifiedStillListedAt: at,
        verifyHistory: [...prevHistory, { at, outcome: 'still_listed' }].slice(-HISTORY_MAX),
      };
      add(still_listed, { broker: broker.name, person }, brokerIndex, personIndex);
    } else if (hasSeenListing(state, broker.name, person, persons.length, { persons, method: personBroker.method, searchHash: searchHash(personBroker.searchUrl) })) {
      // A listing was seen before (by a scan or an earlier verify) and is gone now:
      // that is a removal.
      state.optOuts[key] = {
        ...record,
        verifiedDeletedAt: at,
        verifyHistory: [...prevHistory, { at, outcome: 'verified_clear' }].slice(-HISTORY_MAX),
      };
      add(verified_clear, { broker: broker.name, person }, brokerIndex, personIndex);
    } else {
      // Nothing there now, and nothing was ever seen there: not a removal. Recorded
      // under its own field so the score, the report and the complaints cannot count it.
      state.optOuts[key] = {
        ...record,
        verifiedAbsentAt: at,
        verifyHistory: [...prevHistory, { at, outcome: 'never_seen' }].slice(-HISTORY_MAX),
      };
      add(never_seen, { broker: broker.name, person }, brokerIndex, personIndex);
    }
  }

  for (const list of [verified_clear, never_seen, still_listed, unverifiable, skipped]) list.sort(byPosition);

  return { verified_clear, never_seen, still_listed, unverifiable, skipped };
}

module.exports = { runVerify };

/**
 * @typedef {{
 *   verified_clear: Array<{broker: string, person: object}>,
 *   never_seen:     Array<{broker: string, person: object}>,
 *   still_listed:   Array<{broker: string, person: object}>,
 *   unverifiable:   Array<{broker: string, person: object, reason: string}>,
 *   skipped:        Array<{broker: string, reason: string}>,
 * }} VerifyLoopResult
 */
