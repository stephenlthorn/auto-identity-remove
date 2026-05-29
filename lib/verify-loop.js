/**
 * lib/verify-loop.js
 *
 * T+7 day post-submit verification loop (audit section 2.1).
 *
 * runVerify(context, brokers, persons, opts) re-searches each (person, broker)
 * pair where an opt-out was submitted >= 7 days ago and the listing has not
 * already been confirmed gone since that submission.  It writes outcome fields
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
 * @returns {Promise<VerifyLoopResult>}
 */
async function runVerify(context, brokers, persons, opts = {}) {
  const { state, findUrl: injectedFindUrl } = opts;
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

  for (const broker of brokers) {
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
          reason: `too recent — verify in ${daysLeft}d (submitted ${Math.floor(daysSinceSuccess)}d ago)`,
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
      const canSearch =
        broker.method === 'search-form' &&
        broker.searchUrl &&
        broker.listingPattern;

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
        listingUrl = await findUrl(page, broker, person);
      } catch (err) {
        searchError = (err.message || String(err)).slice(0, 200);
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
