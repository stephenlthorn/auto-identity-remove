/**
 * lib/broker-runner.js
 *
 * Per-broker processing (`processBroker`) and email opt-outs
 * (`sendEmailOptOuts`). Verbatim logic from the monolith.
 *
 * The original closed over module-level `DRY_RUN`, `person`, and `capsolver`.
 * Here those are injected once via `configure({ dryRun, person, capsolver })`
 * before the run starts — preserving singleton semantics with no circular
 * requires (this module imports config/logger/forms/captcha; none import back).
 */

const { recordSuccess, recordPendingConfirmation, recordFailure, shouldSkip, saveCheckpoint } = require('./config');
const { logResult } = require('./logger');
const { fillForm, findListingUrl } = require('./forms');
const { detectAndSolveCaptcha } = require('./captcha');
const { detectConfirmationRequired } = require('./confirm');
const { classifyPostSubmit } = require('./success');
const { withRetry } = require('./retry');
const { jitterSleep } = require('./timing');

let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false };

function configure(o) {
  opts = { ...opts, ...o };
}

async function processBroker(context, broker) {
  return processBrokerWithPerson(context, broker, opts.person);
}

/**
 * processBrokerWithPerson — run a single broker opt-out with an explicitly
 * provided person object.  Used by noise mode to submit bogus records without
 * altering the global `opts.person`.
 *
 * @param {object} context  - Playwright browser context
 * @param {object} broker   - broker definition
 * @param {object} person   - person data to fill into the form
 */
async function processBrokerWithPerson(context, broker, person) {
  // Save checkpoint so --resume knows where we are when resuming an interrupted run.
  saveCheckpoint(broker.name);

  // Centralized skip logic — handles both regular re-check window AND
  // WP4 pending-confirmation 14-day retry window.
  const skip = shouldSkip(broker.name);
  if (skip) {
    logResult(broker.name, 'skipped', skip.reason);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && (person?.country || 'US') !== 'US') {
    logResult(broker.name, 'skipped', 'US-only broker — skipped for non-US user');
    return;
  }

  if (broker.method === 'manual') {
    logResult(broker.name, 'manual', broker.notes || broker.optOutUrl || '');
    return;
  }

  if (broker.method === 'email') {
    // Handled in sendEmailOptOuts()
    return;
  }

  const page = await context.newPage();
  try {
    let listingUrl = null;

    // Step 1: find your specific listing
    if (broker.method === 'search-form' && broker.searchUrl) {
      listingUrl = await findListingUrl(page, broker).catch(() => null);
      if (!listingUrl) {
        logResult(broker.name, 'notFound', 'Not listed — nothing to remove');
        recordSuccess(broker.name, 'not found in search');
        await page.close();
        return;
      }
      console.log(`     🔗 Listing: ${listingUrl.slice(0, 70)}`);
    }

    // Step 2: navigate to opt-out page (with retry on transient errors)
    await withRetry(() => page.goto(broker.optOutUrl, { waitUntil: 'domcontentloaded', timeout: broker.timeoutMs || 15000 }));
    await jitterSleep(1200, 2200);

    // Inject listing URL into any "profile URL" field
    if (listingUrl) {
      const urlSel = 'input[name*="url" i],input[placeholder*="url" i],input[placeholder*="link" i],input[name*="link" i]';
      await page.locator(urlSel).first().fill(listingUrl).catch(() => {});
    }

    // Step 3: fill personal info (pass person so intl province/postal aliases fire)
    if (broker.formFields) {
      await fillForm(page, broker.formFields, person);
      await jitterSleep(400, 800);
    }

    // Step 4: solve CAPTCHA if needed
    if (broker.captchaLikely) {
      if (opts.noCapsolver) {
        logResult(broker.name, 'manual', broker.optOutUrl || '');
        await page.close();
        return;
      }
      const solved = await detectAndSolveCaptcha(page, opts.capsolver);
      if (!solved) {
        logResult(broker.name, 'captcha_failed', broker.optOutUrl);
        recordFailure(broker.name, 'captcha_failed');
        await page.close();
        return;
      }
    }

    // Step 4b: preview — dump resolved field values before any submit
    if (opts.preview) {
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll('input,select,textarea')]
          .map(el => ({ name: el.name || el.id, value: el.value, type: el.type }))
      );
      const fieldPairs = fields
        .filter(f => f.name && f.value)
        .map(f => `input[${f.name}]="${f.value}"`)
        .join(' ');
      const detail = `${fieldPairs}${fieldPairs ? ' ' : ''}→ would POST to ${broker.optOutUrl}`;
      logResult(broker.name, 'preview', detail);
      await page.close();
      return;
    }

    // Step 5: submit (skipped in dry-run mode)
    if (opts.dryRun) {
      logResult(broker.name, 'skipped', 'dry-run — form filled but not submitted');
      await page.close();
      return;
    }
    if (broker.submitSelector) {
      const btn = page.locator(broker.submitSelector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
        await jitterSleep(1500, 2500);
      }
    }

    // Step 6: check post-submit page. First check for email-confirmation
    // requirement, then verify success via DOM text. Click-then-assume is a
    // false-positive source - forms can fail silently on the client side.
    const body = await Promise.resolve().then(() => page.evaluate(() => document.body?.innerText || '')).catch(() => '');
    const confirm = await detectConfirmationRequired(page);
    if (confirm.pending) {
      logResult(broker.name, 'pending_confirm', confirm.snippet || 'check your email to confirm');
      recordPendingConfirmation(broker.name, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(body);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown
        logResult(broker.name, 'error', snippet || 'form submission may have failed');
        recordFailure(broker.name, 'error');
      } else {
        // 'success' = explicit confirmation text found
        // 'unknown' = no feedback text (common on many brokers) - record success,
        //             tagged so audit reports can flag for manual verification
        const detail = outcome === 'success' ? snippet : 'no explicit confirmation - assumed ok';
        logResult(broker.name, 'success', detail);
        recordSuccess(broker.name);
      }
    }

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : err.message?.slice(0, 80) || 'unknown';
    logResult(broker.name, 'error', msg);
    recordFailure(broker.name, 'error');
  } finally {
    await page.close().catch(() => {});
    await jitterSleep(5000, 15000);
  }
}

module.exports = { configure, processBroker, processBrokerWithPerson };
