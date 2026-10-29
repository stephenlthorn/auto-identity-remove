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
const { handleCaptcha, manualTimeoutSec, captchaFailureDetail, announceCaptchaWait } = require('./manual-captcha');
const { desktopNotify } = require('./notify');
const { detectConfirmationRequired, looksLikeConfirmationRequired } = require('./confirm');
const { classifyPostSubmit } = require('./success');
const { langOf } = require('./locale-patterns');
const { withRetry } = require('./retry');
const { jitterSleep } = require('./timing');
const { captureSubmitSnapshot } = require('./snapshot');
const { acceptOptOutDialogs } = require('./browser');
const { isUnreachableError } = require('./defunct');

// Playwright's default is 30 s PER ACTION. A missed selector or a hidden input
// would stall a broker for half a minute each; navigations keep their own
// explicit timeouts (goto below, findListingUrl).
const ACTION_TIMEOUT_MS = 5000;

// `manual`: a person may be asked to solve a CAPTCHA (lib/manual-captcha.js
// resolveManualMode, decided once by the watcher). `headless` and `isTTY` only
// shape the message when nobody can be asked.
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1, personIndex: undefined, config: null, submissionEmail: null, brokersFor: null, manual: false, headless: false, isTTY: undefined };

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

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return 'url'; }
}

/**
 * An error message that is safe to log. Playwright appends the URL it was
 * loading ("net::ERR_X at https://site/Jane-Doe/Austin-TX"), and these URLs carry
 * the person's name and city, so every URL is reduced to its host. Messages end
 * up in stdout, the run log and the dashboard stream.
 */
function safeErrorDetail(err, fallback = 'unknown') {
  const raw = (err && err.message) || fallback;
  return String(raw).replace(/https?:\/\/[^\s'")]+/gi, hostOf).replace(/\s+/g, ' ').trim();
}

/** URL with its query string and fragment removed; opt-out URLs can carry the person's details there. */
function withoutQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?<params withheld>' : ''}`;
  } catch (_) {
    return 'unknown URL';
  }
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

/** The page's current URL, or undefined when it cannot say (a minimal stub, a closed page). */
function pageUrl(page) {
  try {
    return typeof page.url === 'function' ? page.url() : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Did the person submit the form themselves while the CAPTCHA wait was on? Only
 * when the page moved on from where the wait began AND the form's submit control
 * is gone: a page that merely reloaded with the form still on it (a challenge
 * interstitial passing the visitor through) is still ours to submit.
 */
async function personSubmittedForm(page, broker, urlAtWait) {
  if (urlAtWait === undefined || urlAtWait === null) return false;
  if (pageUrl(page) === urlAtWait) return false;
  return (await locateSubmitButton(page, broker)) === null;
}

async function processBroker(context, broker) {
  return processBrokerWithPerson(context, broker, opts.person);
}

// A noise (--pollute) submission has no opt-out state to read or write.
const NO_STATE = { success() {}, pending() {}, failure() {} };

// Noise outcomes are printed for the operator but kept out of logResult: the run
// results feed the report, drift and the "removed" counts, and a bogus
// submission to a real broker must never look like the user's own removal.
function reportNoise(name, status, detail) {
  console.log(`🎭 [${name}] noise ${status}${detail ? ' - ' + detail : ''}`);
}

// The broker as built for the FAKE person. watcher.js holds brokers built once
// for the real person, so their formFields/searchUrl carry the real PII.
function brokerForFakePerson(broker, person) {
  try {
    const build = opts.brokersFor || require('../brokers').forPerson;
    return build(person).find(b => b.name === broker.name) || null;
  } catch (_) {
    return null;
  }
}

/**
 * processBrokerWithPerson - run a single broker opt-out with an explicitly
 * provided person object.  Used by noise mode to submit bogus records without
 * altering the global `opts.person`.
 *
 * A bogus person (`person.isBogus`, as generateBogusPerson() returns) or
 * `options.noState` makes this a NOISE submission: the broker's values are
 * re-derived from the fake person, the relay email is not substituted, and no
 * state, checkpoint or run result is read or written (BRK-7 / CORE-3 / NET-7).
 *
 * @param {object} context  - Playwright browser context
 * @param {object} requestedBroker - broker definition
 * @param {object} person   - person data to fill into the form
 * @param {{ noState?: boolean }} [options]
 */
async function processBrokerWithPerson(context, requestedBroker, person, options = {}) {
  const noise = options.noState === true || (!!person && person.isBogus === true);
  const report = noise ? reportNoise : logResult;
  const state = noise
    ? NO_STATE
    : { success: recordSuccess, pending: recordPendingConfirmation, failure: recordFailure };
  const submissionEmail = noise ? undefined : (opts.submissionEmail || undefined);

  let broker = requestedBroker;
  if (noise) {
    broker = brokerForFakePerson(requestedBroker, person);
    if (!broker) {
      report(requestedBroker.name, 'skipped', 'broker could not be built for the fake person');
      return;
    }
  }

  // Compute the canonical state key for this (broker, person) pair.
  // Single-person mode: bare broker name. Multi-person: "BrokerName|First Last".
  const key = noise ? null : stateKey(broker.name, person, opts.personCount);

  // Save checkpoint so --resume knows where we are when resuming an interrupted run.
  if (!noise) saveCheckpoint(key);

  // Allowlist: the user explicitly wants to STAY listed on this broker, so never
  // submit an opt-out. Logged as 'allowlisted' (routed to the skipped bucket).
  if (isAllowlisted(broker.name, opts.config)) {
    report(broker.name, 'allowlisted', 'on allowlist - keeping listing, no opt-out submitted');
    return;
  }

  // Centralized skip logic - handles both regular re-check window AND
  // WP4 pending-confirmation 14-day retry window. Looked up per person so
  // persons[0] keeps the bare-key history written before a second person was
  // added; passing the composite key alone orphaned it and re-submitted everything.
  const skip = noise ? null : shouldSkip(broker.name, { person, personCount: opts.personCount, personIndex: opts.personIndex });
  if (skip) {
    report(broker.name, 'skipped', skip.reason);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && String(person?.country || 'US').trim().toUpperCase() !== 'US') {
    report(broker.name, 'skipped', 'US-only broker - skipped for non-US user');
    return;
  }

  // brokers.js sets skipReason when this person lacks a value the form needs
  // (a phone number). Submitting the form empty would only fail every run.
  if (broker.skipReason) {
    report(broker.name, 'skipped', broker.skipReason);
    return;
  }

  if (broker.method === 'manual') {
    report(broker.name, 'manual', broker.notes || broker.optOutUrl || '');
    return;
  }

  if (broker.method === 'email') {
    // Handled in sendEmailOptOuts()
    return;
  }

  const page = await context.newPage();
  if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(broker.actionTimeoutMs || ACTION_TIMEOUT_MS);
  // Accept "Are you sure?" confirm() dialogs: Playwright dismisses them, which
  // silently aborts the opt-out.
  acceptOptOutDialogs(page);
  try {
    let listingUrl = null;

    // Step 1: find your specific listing
    if (broker.method === 'search-form' && broker.searchUrl) {
      try {
        listingUrl = await findListingUrl(page, broker);
      } catch (err) {
        // BRK-9: a timeout, DNS failure or bot wall is not "you are not listed".
        // Reporting it as notFound hid live listings behind a clean result.
        const why = safeErrorDetail(err, 'lookup failed').slice(0, 100);
        report(broker.name, 'error', `could not check whether you are listed (${why}) - not treated as "not listed"`);
        // A bot wall means the site is UP: record it so it cannot count toward defunct.
        state.failure(key, err && err.code === 'UNVERIFIABLE' && !isUnreachableError(err.message) ? 'form_error' : 'error');
        return;
      }
      if (!listingUrl) {
        report(broker.name, 'notFound', 'Not listed - nothing to remove');
        return;
      }
      // Host only: the path is /First-Last/City-ST/... on most people-search sites.
      console.log(`     🔗 Listing found on ${hostOf(listingUrl)}`);
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
        report(broker.name, 'error', `opt-out URL returned HTTP ${code}`);
        state.failure(key, 'error');
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
      // Skip hidden inputs (a `return_url` field): filling one waits out the
      // whole action timeout for it to become editable (BRK-12).
      const urlField = page.locator(urlSel).first();
      const visibleUrlField = await Promise.resolve()
        .then(async () => (await urlField.count()) > 0 && (await urlField.isVisible()))
        .catch(() => false);
      if (visibleUrlField) await urlField.fill(listingUrl).catch(() => {});
    }

    // Step 3: fill personal info (pass person so intl province/postal aliases fire)
    if (broker.formFields) {
      await fillForm(page, broker.formFields, person, submissionEmail);
      await jitterSleep(400, 800);
    }

    // Step 4: solve CAPTCHA if needed
    let urlAtWait = null;
    if (broker.captchaLikely) {
      // A fake-person (noise) submission is never worth a person's time.
      const manual = !noise && opts.manual === true;
      if (opts.noCapsolver && !manual) {
        report(broker.name, 'manual', captchaFailureDetail({
          outcome: 'skipped', url: broker.optOutUrl, noSolver: true, headless: opts.headless, isTTY: opts.isTTY, config: opts.config,
        }));
        await page.close();
        return;
      }
      let outcome = 'none';
      // Where the page was before anyone was asked, to tell a person who submitted
      // the form themselves (the page moved on) from one who only solved the CAPTCHA.
      const urlBeforeWait = pageUrl(page);
      // Dry-run and preview never submit, so they must not spend CapSolver credit
      // or keep a person waiting at a window.
      if (!(opts.dryRun || opts.preview)) {
        outcome = await handleCaptcha(page, {
          capsolver: opts.noCapsolver ? null : opts.capsolver,
          manual,
          broker,
          onWaiting: (info) => announceCaptchaWait(info, { notify: desktopNotify }),
          timeoutMs: manualTimeoutSec(opts.config) * 1000,
          solve: detectAndSolveCaptcha,
        });
      }
      if (outcome !== 'none' && outcome !== 'solved') {
        report(broker.name, 'captcha_failed', captchaFailureDetail({
          outcome,
          url: broker.optOutUrl,
          timeoutSec: manualTimeoutSec(opts.config),
          headless: opts.headless,
          isTTY: opts.isTTY,
          config: opts.config,
        }));
        state.failure(key, 'captcha_failed');
        await page.close();
        return;
      }
      if (manual && outcome === 'solved') urlAtWait = urlBeforeWait;
    }

    // Step 4b: preview - dump resolved field values before any submit
    if (opts.preview) {
      // Names and fill status only: the values are the user's PII and this line
      // goes to stdout, the run log and the dashboard stream (codex #6). `filled`
      // is computed in the page so the value never leaves it.
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll('input,select,textarea')]
          .filter(el => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type))
          .map(el => ({
            name: el.name || el.id,
            type: el.type,
            filled: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value !== '',
          }))
      );
      const summary = (Array.isArray(fields) ? fields : [])
        .filter(f => f && f.name)
        .map(f => `${f.name}=${(f.filled !== undefined ? f.filled : !!f.value) ? 'filled' : 'empty'}`)
        .join(' ');
      const detail = `${summary ? `fields: ${summary} ` : ''}→ would POST to ${withoutQuery(broker.optOutUrl)}`;
      report(broker.name, 'preview', detail);
      await page.close();
      return;
    }

    // Step 5: submit (skipped in dry-run mode)
    if (opts.dryRun) {
      report(broker.name, 'skipped', 'dry-run - form filled but not submitted');
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
      report(broker.name, 'unverified', 'no submit step configured - page loaded, nothing confirmed' + snapshotSuffix);
      return;
    }

    // A person who finished the form themselves during the CAPTCHA wait has
    // already submitted: classify the page they landed on, never click a second time.
    let textBefore = '';
    if (!(await personSubmittedForm(page, broker, urlAtWait))) {
      const btn = await locateSubmitButton(page, broker);
      if (!btn) {
        report(broker.name, 'error', 'submit button not found or not visible - nothing was submitted' + snapshotSuffix);
        return;
      }

      textBefore = await readBodyText(page);
      await btn.click();
      await jitterSleep(1500, 2500);
    }

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
      report(broker.name, 'unverified', 'submit clicked but the page did not change - re-check next run' + snapshotSuffix);
      return;
    }

    const confirm = await detectConfirmationRequired(page, pageLang);
    // detectConfirmationRequired() scans the whole page, which can include
    // "you will receive a confirmation email" instructions printed on the form.
    // Only wording that showed up after the click makes this pending.
    const pending = confirm.pending &&
      (typeof looksLikeConfirmationRequired !== 'function' || looksLikeConfirmationRequired(freshText, pageLang));
    if (pending) {
      report(broker.name, 'pending_confirm', (confirm.snippet || 'check your email to confirm') + snapshotSuffix);
      state.pending(key, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(freshText, pageLang);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown.
        // Kind 'form_error', not 'error': the site answered, so this must not
        // count toward the defunct (unreachable) check (BRK-10).
        report(broker.name, 'error', (snippet || 'form submission may have failed') + snapshotSuffix);
        state.failure(key, 'form_error');
      } else if (outcome === 'success') {
        // Explicit confirmation text found - start 90-day cooldown
        report(broker.name, 'success', snippet + snapshotSuffix);
        state.success(key);
      } else {
        // 'unknown' = no confirmation text found - do NOT start 90-day cooldown;
        // next run will re-check so we don't hide silent failures
        report(broker.name, 'unverified', 'no explicit confirmation - re-check next run' + snapshotSuffix);
      }
    }

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : safeErrorDetail(err).slice(0, 80);
    report(broker.name, 'error', msg);
    state.failure(key, 'error');
  } finally {
    await page.close().catch(() => {});
    await jitterSleep(5000, 15000);
  }
}

module.exports = { configure, processBroker, processBrokerWithPerson, scopeSelectorToForm, splitTopLevelCommas, newTextSince };
