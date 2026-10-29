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
 *   verifiedDeletedAt      - ISO string, set when listing is absent
 *   verifiedStillListedAt  - ISO string, set when listing is still found
 *   verifyHistory          - array of { at: ISO, outcome: string }
 *
 * Per-person state key convention:
 *   Single-person mode    → state.optOuts[broker.name]
 *   Multi-person mode     → state.optOuts["broker.name|FirstName LastName"]
 *   (This mirrors whatever key was written by recordSuccess for that person.)
 *
 * Result object:
 *   {
 *     verified_clear: [{ broker, person }],
 *     still_listed:   [{ broker, person }],
 *     unverifiable:   [{ broker, person, reason }],
 *     skipped:        [{ broker, reason }],
 *   }
 */

'use strict';

const { findListingUrl: defaultFindListingUrl } = require('./forms');
const { stateKey } = require('./config');
const { isAllowlisted } = require('./filter');

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
 * @param {Function} [opts.warn]    - warning sink (default console.warn)
 * @returns {Promise<VerifyLoopResult>}
 */
async function runVerify(context, brokers, persons, opts = {}) {
  const { state, findUrl: injectedFindUrl, config = null, brokersFor, warn } = opts;
  const findUrl = injectedFindUrl || defaultFindListingUrl;

  if (!state || !state.optOuts) {
    throw new Error('runVerify: opts.state must be a state object with an optOuts property');
  }

  /** @type {Array<{broker: string, person: object}>} */
  const verified_clear = [];
  /** @type {Array<{broker: string, person: object}>} */
  const still_listed   = [];
  /** @type {Array<{broker: string, person: object, reason: string}>} */
  const unverifiable   = [];
  /** @type {Array<{broker: string, reason: string}>} */
  const skipped        = [];

  const now = new Date();

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

  for (const broker of brokers) {
    // ── Gate 0: allowlisted brokers are never verified (the user wants to stay
    // listed, so a found listing is not a failure). Recorded once per broker. ─
    if (isAllowlisted(broker.name, config)) {
      skipped.push({ broker: broker.name, reason: 'on allowlist - keeping listing, verification skipped' });
      continue;
    }

    for (const person of persons) {
      const key    = stateKey(broker.name, person, persons.length);
      const record = state.optOuts[key];

      // ── Gate 1: must have a recorded lastSuccess ──────────────────────────
      if (!record || !record.lastSuccess) {
        skipped.push({ broker: broker.name, person, reason: 'no recorded opt-out submission' });
        continue;
      }

      const lastSuccessMs = new Date(record.lastSuccess).getTime();
      const daysSinceSuccess = (now.getTime() - lastSuccessMs) / (1000 * 60 * 60 * 24);

      // ── Gate 2: must be >= VERIFY_AFTER_DAYS since submission ─────────────
      if (daysSinceSuccess < VERIFY_AFTER_DAYS) {
        const daysLeft = Math.ceil(VERIFY_AFTER_DAYS - daysSinceSuccess);
        skipped.push({
          broker: broker.name,
          person,
          reason: `too recent - verify in ${daysLeft}d (submitted ${Math.floor(daysSinceSuccess)}d ago)`,
        });
        continue;
      }

      // ── Gate 3: skip if already verified clear AFTER the last submission ──
      if (record.verifiedDeletedAt) {
        const verifiedMs = new Date(record.verifiedDeletedAt).getTime();
        if (verifiedMs > lastSuccessMs) {
          // Already confirmed gone since the last submission - nothing new to check.
          skipped.push({
            broker: broker.name,
            person,
            reason: 'already verified clear since last submission',
          });
          continue;
        }
        // verifiedDeletedAt is older than lastSuccess - a new submission was
        // recorded after the last verify, so we should re-check.
      }

      // ── Gate 4: must be verifiable (search-form with searchUrl + pattern) ─
      const resolved = brokerForPerson(person, broker);
      if (!resolved.broker) {
        unverifiable.push({ broker: broker.name, person, reason: resolved.reason });
        continue;
      }
      const personBroker = resolved.broker;
      const canSearch =
        personBroker.method === 'search-form' &&
        personBroker.searchUrl &&
        personBroker.listingPattern;

      if (!canSearch) {
        unverifiable.push({
          broker: broker.name,
          person,
          reason: 'no automated search signal (direct-form / email / manual or missing searchUrl/listingPattern)',
        });
        continue;
      }

      // ── Search ────────────────────────────────────────────────────────────
      const page = await context.newPage();
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
        unverifiable.push({
          broker: broker.name,
          person,
          reason: `search failed: ${searchError}`,
        });
        continue;
      }

      // Contract with findListingUrl: null means the search page loaded fine and
      // has no matching listing; a string is the listing. Anything else is a
      // contract breach and must never read as "verified clear".
      if (listingUrl !== null && !(typeof listingUrl === 'string' && listingUrl)) {
        unverifiable.push({
          broker: broker.name,
          person,
          reason: `search failed: unexpected result from listing search (${typeof listingUrl})`,
        });
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
        still_listed.push({ broker: broker.name, person });
      } else {
        state.optOuts[key] = {
          ...record,
          verifiedDeletedAt: at,
          verifyHistory: [...prevHistory, { at, outcome: 'verified_clear' }].slice(-HISTORY_MAX),
        };
        verified_clear.push({ broker: broker.name, person });
      }
    }
  }

  return { verified_clear, still_listed, unverifiable, skipped };
}

module.exports = { runVerify };

/**
 * @typedef {{
 *   verified_clear: Array<{broker: string, person: object}>,
 *   still_listed:   Array<{broker: string, person: object}>,
 *   unverifiable:   Array<{broker: string, person: object, reason: string}>,
 *   skipped:        Array<{broker: string, reason: string}>,
 * }} VerifyLoopResult
 */
