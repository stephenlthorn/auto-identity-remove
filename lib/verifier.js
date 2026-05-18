/**
 * lib/verifier.js
 *
 * Spot-check whether previous opt-outs are still effective.
 * Invoked via `node watcher.js --verify`.
 *
 * IMPORTANT LIMITATIONS (be honest with users):
 *   - Only search-form brokers with a searchUrl + listingPattern can be checked.
 *   - "verified_clear" means your name wasn't found in one search today; it is
 *     NOT a legal guarantee of deletion.  Data-brokers re-ingest regularly.
 *   - "still_listed" can mean the opt-out failed OR the broker re-added your
 *     data since the last successful opt-out.
 *   - No form is submitted, no state is mutated.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { setDryRun } = require('./config');
const { findListingUrl } = require('./forms');

const LOG_DIR = path.join(__dirname, '..', 'logs');

/**
 * Run a read-only spot-check for all brokers that have a recorded success in
 * state.  Writes a dated JSON report to logs/ and prints a human-readable
 * summary.  Never touches state.json or submits anything.
 *
 * @param {import('playwright').BrowserContext} context   Live Playwright context
 * @param {object[]}                            brokers   Full broker definitions array
 * @param {{ optOuts: Record<string, object> }} state     Shared state object (read-only)
 * @param {Function}                            [_findUrl] Injectable override for tests
 * @returns {Promise<VerifyResult>}
 */
async function runVerify(context, brokers, state, _findUrl) {
  // Belt-and-suspenders: ensure nothing can write to disk even if called
  // in an unexpected way.
  setDryRun(true);

  const findUrl = _findUrl || findListingUrl;

  /** @type {VerifyEntry[]} */
  const verifiedClear  = [];
  /** @type {VerifyEntry[]} */
  const stillListed    = [];
  /** @type {VerifyEntry[]} */
  const unverifiable   = [];

  console.log('\n🔍 auto-identity-remove — verify mode (read-only spot-check)');
  console.log('   No forms will be submitted. No state will be saved.\n');

  for (const broker of brokers) {
    const record = state.optOuts && state.optOuts[broker.name];

    // Skip brokers with no recorded success — nothing to verify.
    if (!record || !record.lastSuccess) {
      continue;
    }

    const canSearch =
      broker.method === 'search-form' &&
      broker.searchUrl &&
      broker.listingPattern;

    if (!canSearch) {
      unverifiable.push({
        broker: broker.name,
        status: 'unverifiable',
        detail: 'no automated signal — cannot confirm (direct-form / email / manual method)',
      });
      process.stdout.write(`  ⬜ ${broker.name} — unverifiable (no search signal)\n`);
      continue;
    }

    process.stdout.write(`  🔍 ${broker.name}… `);
    const page = await context.newPage();
    let listingUrl = null;
    let errMsg = null;

    try {
      listingUrl = await findUrl(page, broker);
    } catch (err) {
      errMsg = err.message || String(err);
    } finally {
      await page.close().catch(() => {});
    }

    if (errMsg) {
      // Network/timeout errors — treat as unverifiable rather than false positives.
      unverifiable.push({
        broker: broker.name,
        status: 'unverifiable',
        detail: `search failed: ${errMsg.slice(0, 120)}`,
      });
      process.stdout.write(`unverifiable (search error)\n`);
      continue;
    }

    if (listingUrl) {
      stillListed.push({
        broker: broker.name,
        status: 'still_listed',
        detail: 'opt-out may have failed or data was re-added since last removal',
        url: listingUrl,
      });
      process.stdout.write(`STILL LISTED — ${listingUrl}\n`);
    } else {
      verifiedClear.push({
        broker: broker.name,
        status: 'verified_clear',
        detail: 'name not found in search today',
      });
      process.stdout.write(`clear\n`);
    }
  }

  // ── Print summary ────────────────────────────────────────────────────────
  const divider = '─'.repeat(54);
  console.log('\n' + '═'.repeat(54));
  console.log('🔍 Verify Report — ' + new Date().toLocaleString());
  console.log('═'.repeat(54));

  console.log(`\n✅ VERIFIED CLEAR   (${verifiedClear.length})`);
  if (verifiedClear.length === 0) {
    console.log('   (none)');
  } else {
    for (const e of verifiedClear) console.log(`   • ${e.broker}`);
  }

  console.log(`\n⚠️  STILL LISTED    (${stillListed.length})`);
  if (stillListed.length === 0) {
    console.log('   (none)');
  } else {
    for (const e of stillListed) console.log(`   • ${e.broker} — ${e.url || e.detail}`);
  }

  console.log(`\n⬜ UNVERIFIABLE     (${unverifiable.length})`);
  if (unverifiable.length === 0) {
    console.log('   (none)');
  } else {
    for (const e of unverifiable) console.log(`   • ${e.broker} — ${e.detail}`);
  }

  console.log('\n' + divider);
  console.log('NOTE: "verified clear" is a best-effort spot-check, not proof');
  console.log('of deletion. Brokers routinely re-ingest data. Re-run watcher.js');
  console.log('if any listings are still found.');
  console.log(divider + '\n');

  // ── Write log file ───────────────────────────────────────────────────────
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const dateStr  = new Date().toISOString().slice(0, 10);
  const logFile  = path.join(LOG_DIR, `verify-${dateStr}.json`);

  /** @type {VerifyResult} */
  const result = {
    runAt: new Date().toISOString(),
    summary: {
      verifiedClear:  verifiedClear.length,
      stillListed:    stillListed.length,
      unverifiable:   unverifiable.length,
    },
    verifiedClear,
    stillListed,
    unverifiable,
  };

  fs.writeFileSync(logFile, JSON.stringify(result, null, 2));
  console.log(`📄 Verify log: ${logFile}\n`);

  return result;
}

module.exports = { runVerify };

/**
 * @typedef {{ broker: string, status: string, detail: string, url?: string }} VerifyEntry
 * @typedef {{
 *   runAt: string,
 *   summary: { verifiedClear: number, stillListed: number, unverifiable: number },
 *   verifiedClear: VerifyEntry[],
 *   stillListed: VerifyEntry[],
 *   unverifiable: VerifyEntry[],
 * }} VerifyResult
 */
