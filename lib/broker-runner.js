/**
 * lib/broker-runner.js
 *
 * Per-broker processing (`processBroker`) and email opt-outs
 * (`sendEmailOptOuts`). Verbatim logic from the monolith.
 *
 * The original closed over module-level `DRY_RUN`, `person`, and `capsolver`.
 * Here those are injected once via `configure({ dryRun, person, capsolver })`
 * before the run starts - preserving singleton semantics with no circular
 * requires (this module imports config/logger/forms/captcha; none import back).
 */

const { recordSuccess, recordPendingConfirmation, recordFailure, shouldSkip, saveCheckpoint, stateKey } = require('./config');
const { logResult } = require('./logger');
const { fillForm, findListingUrl } = require('./forms');
const { isAllowlisted } = require('./filter');
const { detectAndSolveCaptcha } = require('./captcha');
const { detectConfirmationRequired, looksLikeConfirmationRequired } = require('./confirm');
const { classifyPostSubmit } = require('./success');
const { langOf } = require('./locale-patterns');
const { withRetry } = require('./retry');
const { jitterSleep } = require('./timing');
const { captureSubmitSnapshot } = require('./snapshot');

let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1, config: null, submissionEmail: null };

function configure(o) {
  opts = { ...opts, ...o };
}

/**
 * Split a selector list on its TOP-LEVEL commas. A comma inside :is(...),
 * [attr="a,b"] or a quoted string belongs to the selector, not to the list.
 *
 * @param {string} selector
 * @returns {string[]}
 */
function splitTopLevelCommas(selector) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '\\') { cur += ch + (selector[i + 1] || ''); i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

// Playwright selector engines that cannot be descendants of a CSS "form " prefix.
const NON_CSS_SELECTOR = /^(?:text|xpath|role|css|id|data-testid|internal:[\w-]+)\s*=|^\/\/|^\.\.|>>/i;

/**
 * Prefix EVERY alternative of a selector list with "form ". `form a, b` only
 * scopes `a` (the comma ends the first selector), which let a header "Subscribe"
 * input[type=submit] win over the opt-out form's own button (BRK-5).
 *
 * A list holding a non-CSS Playwright selector (text=, xpath=, >>) is returned
 * unchanged: "form " + that is not a valid selector.
 *
 * @param {string} selector
 * @returns {string}
 */
function scopeSelectorToForm(selector) {
  const parts = splitTopLevelCommas(selector);
  if (parts.some(p => NON_CSS_SELECTOR.test(p))) return selector;
  return parts.map(p => `form ${p}`).join(', ');
}

/**
 * Lines of `after` that were not on the page before. The success/failure
 * classifiers must only see what THIS click produced: a page that already said
 * "we will remove your listing" before anything was submitted is not evidence.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string}
 */
function newTextSince(before, after) {
  const lines = (t) => String(t || '').split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const seen = new Set(lines(before));
  return lines(after).filter(l => !seen.has(l)).join('\n');
}

async function readBodyText(page) {
  const text = await Promise.resolve()
    .then(() => page.evaluate(() => document.body?.innerText || ''))
    .catch(() => '');
  return typeof text === 'string' ? text : '';
}

/**
 * Find the control that submits THIS broker's form, or null.
 *
 * 1. The <form> that holds a field we filled, searched for the submit selector.
 *    A page can carry several forms (newsletter, site search, the opt-out form);
 *    the one we typed into is the one to submit.
 * 2. Any <form>, every comma alternative scoped to it (scopeSelectorToForm).
 * 3. The bare selector, for pages whose controls sit outside a <form>.
 *
 * Only a visible control counts. Returns a Playwright locator, never a guess.
 */
async function locateSubmitButton(page, broker) {
  const visible = async (loc) => (await loc.count()) > 0 && (await loc.isVisible());

  const filledForm = await formOfFilledField(page, broker.formFields);
  if (filledForm) {
    const inFilled = filledForm.locator(broker.submitSelector).first();
    if (await visible(inFilled).catch(() => false)) return inFilled;
  }

  const scoped = page.locator(scopeSelectorToForm(broker.submitSelector)).first();
  if (await visible(scoped).catch(() => false)) return scoped;

  const bare = page.locator(broker.submitSelector).first();
  if (await visible(bare).catch(() => false)) return bare;
  return null;
}

/**
 * The <form> ancestor of the first visible field named in `formFields`, as a
 * locator, or null when it cannot be determined (no fields, none visible, the
 * field is not in a <form>, or a minimal mock without chaining).
 */
async function formOfFilledField(page, formFields) {
  for (const selector of Object.keys(formFields || {})) {
    for (const alt of splitTopLevelCommas(selector)) {
      try {
        const field = page.locator(alt).first();
        if ((await field.count()) === 0 || !(await field.isVisible())) continue;
        if (typeof field.locator !== 'function') return null;
        const form = field.locator('xpath=ancestor::form[1]').first();
        return (await form.count()) > 0 ? form : null;
      } catch (_) {
        // try the next selector
      }
    }
  }
  return null;
}

async function processBroker(context, broker) {
  return processBrokerWithPerson(context, broker, opts.person);
}

/**
 * processBrokerWithPerson - run a single broker opt-out with an explicitly
 * provided person object.  Used by noise mode to submit bogus records without
 * altering the global `opts.person`.
 *
 * @param {object} context  - Playwright browser context
 * @param {object} broker   - broker definition
 * @param {object} person   - person data to fill into the form
 */
async function processBrokerWithPerson(context, broker, person) {
  // Compute the canonical state key for this (broker, person) pair.
  // Single-person mode: bare broker name. Multi-person: "BrokerName|First Last".
  const key = stateKey(broker.name, person, opts.personCount);

  // Save checkpoint so --resume knows where we are when resuming an interrupted run.
  saveCheckpoint(key);

  // Allowlist: the user explicitly wants to STAY listed on this broker, so never
  // submit an opt-out. Logged as 'allowlisted' (routed to the skipped bucket).
  if (isAllowlisted(broker.name, opts.config)) {
    logResult(broker.name, 'allowlisted', 'on allowlist - keeping listing, no opt-out submitted');
    return;
  }

  // Centralized skip logic - handles both regular re-check window AND
  // WP4 pending-confirmation 14-day retry window.
  const skip = shouldSkip(key);
  if (skip) {
    logResult(broker.name, 'skipped', skip.reason);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && (person?.country || 'US') !== 'US') {
    logResult(broker.name, 'skipped', 'US-only broker - skipped for non-US user');
    return;
  }

  // brokers.js sets skipReason when this person lacks a value the form needs
  // (a phone number). Submitting the form empty would only fail every run.
  if (broker.skipReason) {
    logResult(broker.name, 'skipped', broker.skipReason);
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
        logResult(broker.name, 'notFound', 'Not listed - nothing to remove');
        await page.close();
        return;
      }
      console.log(`     🔗 Listing: ${listingUrl.slice(0, 70)}`);
    }

    // Step 2: navigate to opt-out page (with retry on transient errors)
    const navResp = await withRetry(() => page.goto(broker.optOutUrl, { waitUntil: 'domcontentloaded', timeout: broker.timeoutMs || 15000 }));
    // B13: do not fill/submit against an error page. A 404/410/5xx opt-out URL
    // loads a broker error page; without this guard the form-fill runs against
    // it and can be misclassified as unverified/success. (resp is null for
    // same-document navigations and undefined in mocked tests - both skip here.)
    if (navResp && typeof navResp.status === 'function') {
      const code = navResp.status();
      if (code === 404 || code === 410 || code >= 500) {
        logResult(broker.name, 'error', `opt-out URL returned HTTP ${code}`);
        recordFailure(key, 'error');
        return;
      }
    }
    await jitterSleep(1200, 2200);

    // Some forms need a first click before they take input (Sync.ME's modal
    // cookie dialog). A missing button is not fatal: the form may already be
    // usable, e.g. when the persistent profile accepted cookies last month.
    if (broker.preClickSelector) {
      const pre = page.locator(broker.preClickSelector).first();
      if ((await pre.count()) > 0 && (await pre.isVisible())) {
        await pre.click();
        await jitterSleep(1200, 2200);
      }
    }

    // Inject listing URL into any "profile URL" field
    if (listingUrl) {
      const urlSel = 'input[name*="url" i],input[placeholder*="url" i],input[placeholder*="link" i],input[name*="link" i]';
      await page.locator(urlSel).first().fill(listingUrl).catch(() => {});
    }

    // Step 3: fill personal info (pass person so intl province/postal aliases fire)
    if (broker.formFields) {
      await fillForm(page, broker.formFields, person, opts.submissionEmail || undefined);
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
        recordFailure(key, 'captcha_failed');
        await page.close();
        return;
      }
    }

    // Step 4b: preview - dump resolved field values before any submit
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
      logResult(broker.name, 'skipped', 'dry-run - form filled but not submitted');
      await page.close();
      return;
    }

    // Step 5b: capture pre-submit snapshot for audit trail (if --snapshot enabled).
    // Runs after dry-run guard so PII screenshots are never taken in test/dry-run runs.
    let snapshotFile = null;
    if (opts.snapshot) {
      snapshotFile = await captureSubmitSnapshot(page, broker.name);
    }

    const snapshotSuffix = snapshotFile ? ` [snapshot: ${snapshotFile}]` : '';

    // BRK-4: only classify what a real click produced. Every path below used to
    // read the whole page body whether or not anything had been submitted, so a
    // page that merely promised "we will remove your listing" was logged success
    // and started the 90-day cooldown.
    if (!broker.submitSelector) {
      // No submit step is defined, so the opt-out URL was only loaded. A request
      // may have gone out another way (a GET opt-out), but nothing confirms it.
      logResult(broker.name, 'unverified', 'no submit step configured - page loaded, nothing confirmed' + snapshotSuffix);
      return;
    }

    const btn = await locateSubmitButton(page, broker);
    if (!btn) {
      logResult(broker.name, 'error', 'submit button not found or not visible - nothing was submitted' + snapshotSuffix);
      return;
    }

    const textBefore = await readBodyText(page);
    await btn.click();
    await jitterSleep(1500, 2500);

    // Step 6: classify the text the click added. First detect the page language
    // from <html lang> so non-English brokers classify correctly, then check for
    // an email-confirmation requirement, then verify success via DOM text.
    // Click-then-assume is a false-positive source - forms can fail silently.
    const pageLang = langOf(
      await page.evaluate(
        () => (document.documentElement && document.documentElement.getAttribute('lang')) || ''
      ).catch(() => '')
    );
    const freshText = newTextSince(textBefore, await readBodyText(page));
    if (!freshText) {
      // The click left the page exactly as it was: a dead button, a blocked
      // script, or a result rendered elsewhere. None of those is a removal.
      logResult(broker.name, 'unverified', 'submit clicked but the page did not change - re-check next run' + snapshotSuffix);
      return;
    }

    const confirm = await detectConfirmationRequired(page, pageLang);
    // detectConfirmationRequired() scans the whole page, which can include
    // "you will receive a confirmation email" instructions printed on the form.
    // Only wording that showed up after the click makes this pending.
    const pending = confirm.pending &&
      (typeof looksLikeConfirmationRequired !== 'function' || looksLikeConfirmationRequired(freshText, pageLang));
    if (pending) {
      logResult(broker.name, 'pending_confirm', (confirm.snippet || 'check your email to confirm') + snapshotSuffix);
      recordPendingConfirmation(key, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(freshText, pageLang);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown.
        // Kind 'form_error', not 'error': the site answered, so this must not
        // count toward the defunct (unreachable) check (BRK-10).
        logResult(broker.name, 'error', (snippet || 'form submission may have failed') + snapshotSuffix);
        recordFailure(key, 'form_error');
      } else if (outcome === 'success') {
        // Explicit confirmation text found - start 90-day cooldown
        logResult(broker.name, 'success', snippet + snapshotSuffix);
        recordSuccess(key);
      } else {
        // 'unknown' = no confirmation text found - do NOT start 90-day cooldown;
        // next run will re-check so we don't hide silent failures
        logResult(broker.name, 'unverified', 'no explicit confirmation - re-check next run' + snapshotSuffix);
      }
    }

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : err.message?.slice(0, 80) || 'unknown';
    logResult(broker.name, 'error', msg);
    recordFailure(key, 'error');
  } finally {
    await page.close().catch(() => {});
    await jitterSleep(5000, 15000);
  }
}

module.exports = { configure, processBroker, processBrokerWithPerson, scopeSelectorToForm, splitTopLevelCommas, newTextSince };
