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
const { armSubmitWatch } = require('./submit-watch');
const { isUnreachableError } = require('./defunct');

// Playwright's default is 30 s PER ACTION. A missed selector or a hidden input
// would stall a broker for half a minute each; navigations keep their own
// explicit timeouts (goto below, findListingUrl).
const ACTION_TIMEOUT_MS = 5000;

// `manual`: a person may be asked to solve a CAPTCHA (lib/manual-captcha.js
// resolveManualMode, decided once by the watcher). `headless` and `isTTY` only
// shape the message when nobody can be asked.
//
// `partial`: this is an explicit-filter run (--only, --retry-failed, --captchas). It
// neither writes nor clears the --resume checkpoint, which belongs to a full run:
// a killed monthly run must still find its own resume point afterwards (CLI2-10).
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1, personIndex: undefined, config: null, submissionEmail: null, brokersFor: null, manual: false, headless: false, isTTY: undefined, partial: false };

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
 * 2. A filled field that is in NO form (a React page of bare divs): the nearest
 *    container around it that holds a matching control outside every <form>.
 *    Never another form's button: the header newsletter's "Join" is a submit
 *    button too, and clicking it filed the "request" with the wrong form (BRK2-6).
 * 3. Only when no filled field can be found at all: any <form>, every comma
 *    alternative scoped to it (scopeSelectorToForm), then the bare selector.
 *
 * Only a visible control counts. Returns a Playwright locator, never a guess.
 */
async function locateSubmitButton(page, broker) {
  const visible = async (loc) => (await loc.count()) > 0 && (await loc.isVisible());

  const filled = await findFilledField(page, broker.formFields);
  if (filled && filled.form) {
    const inFilled = filled.form.locator(broker.submitSelector).first();
    if (await visible(inFilled).catch(() => false)) return inFilled;
  } else if (filled && filled.field) {
    return submitControlNear(filled.field, broker.submitSelector);
  }

  const scoped = page.locator(scopeSelectorToForm(broker.submitSelector)).first();
  if (await visible(scoped).catch(() => false)) return scoped;

  const bare = page.locator(broker.submitSelector).first();
  if (await visible(bare).catch(() => false)) return bare;
  return null;
}

// How far up from a form-less field to look for its submit control.
const MAX_CONTAINER_LEVELS = 8;
const MAX_CONTROL_CANDIDATES = 10;

/**
 * The first visible control matching `selector` that sits outside every <form>,
 * in the nearest ancestor of `field` that has one. Null when there is none.
 */
async function submitControlNear(field, selector) {
  try {
    const ancestors = field.locator('xpath=ancestor::*');
    const total = await ancestors.count();
    for (let i = total - 1; i >= 0 && total - i <= MAX_CONTAINER_LEVELS; i--) {
      const candidates = ancestors.nth(i).locator(selector);
      const found = Math.min(await candidates.count(), MAX_CONTROL_CANDIDATES);
      for (let j = 0; j < found; j++) {
        const candidate = candidates.nth(j);
        if (!(await candidate.isVisible())) continue;
        if (!(await candidate.evaluate((el) => !el.closest('form')))) continue;
        return candidate;
      }
    }
  } catch (_) {
    // A page that cannot answer: no control, which the caller reports as such.
  }
  return null;
}

/**
 * The first visible field named in `formFields`, with the <form> it sits in:
 * `{ field, form }` where `form` is null when the field has no <form> ancestor.
 * Null when it cannot be determined (no fields, none visible, or a minimal mock
 * without chaining).
 */
async function findFilledField(page, formFields) {
  for (const selector of Object.keys(formFields || {})) {
    for (const alt of splitTopLevelCommas(selector)) {
      try {
        const field = page.locator(alt).first();
        if ((await field.count()) === 0 || !(await field.isVisible())) continue;
        if (typeof field.locator !== 'function') return null;
        const form = field.locator('xpath=ancestor::form[1]').first();
        return { field, form: (await form.count()) > 0 ? form : null };
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

/** Lowercase <html lang> of the page, or '' when it cannot say. */
async function readPageLang(page) {
  return langOf(
    await Promise.resolve()
      .then(() => page.evaluate(() => (document.documentElement && document.documentElement.getAttribute('lang')) || ''))
      .catch(() => '')
  );
}

/** Text that reads as a result: success wording or "check your email to confirm". */
function showsResultWording(text, lang) {
  if (!text) return false;
  if (classifyPostSubmit(text, lang).outcome === 'success') return true;
  return typeof looksLikeConfirmationRequired === 'function' && looksLikeConfirmationRequired(text, lang);
}

/**
 * Was the form submitted while the CAPTCHA wait was on (by the person pressing Send,
 * or by the callback CapSolver fires)? Then the tool must not click a second time:
 * that is a second request at the broker (BRK2-3). Any one of these says so:
 *
 *   - the page-side watch saw the submit control clicked or a submit happen
 *   - the control that was on the page when the wait began is gone (the form was
 *     replaced by its confirmation, or the page moved on)
 *
 * Wording that merely appears on the page is NOT taken as a submission here: a
 * solved-CAPTCHA banner ("Verification complete...") must never read as the broker's
 * answer. (After the page was REPLACED, wording is the only evidence there is:
 * see the 'navigated' handling in processBrokerWithPerson.)
 */
async function submittedDuringWait(page, broker, { watch, hadControl, urlBeforeWait }) {
  if (watch && (await watch.observed())) return true;
  const control = await locateSubmitButton(page, broker).catch(() => null);
  if (control === null) {
    if (hadControl) return true;
    if (urlBeforeWait !== undefined && urlBeforeWait !== null && pageUrl(page) !== urlBeforeWait) return true;
  }
  return false;
}

/** Close a page without letting one that will not close hold the run. */
async function closePage(page) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(page.close({ runBeforeUnload: false })),
      new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
  } catch (_) {
    // already closed
  } finally {
    clearTimeout(timer);
  }
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
  // Every write below passes the person it is for, so the entry carries their
  // identity fingerprint and a later change of zip or email counts as never run (R5).
  const stamp = { person };

  // Save checkpoint so --resume knows where we are when resuming an interrupted run.
  if (!noise && !opts.partial) saveCheckpoint(key);

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

  // CLI2-5: a browser that died under the run (an out-of-memory kill, a window the
  // person closed) fails THIS broker with a clear detail. It is not the broker's
  // fault, so no failure is recorded against it, and the run goes on: the caller
  // gets { browserClosed: true } and relaunches the browser for the next broker.
  let page;
  try {
    page = await context.newPage();
  } catch (err) {
    report(broker.name, 'error', `browser closed - could not open a page (${safeErrorDetail(err, 'no detail').slice(0, 80)})`);
    return { browserClosed: true };
  }
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
        state.failure(key, err && err.code === 'UNVERIFIABLE' && !isUnreachableError(err.message) ? 'form_error' : 'error', stamp);
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
        state.failure(key, 'error', stamp);
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
    let submittedMeanwhile = false;
    let waitBaseline = '';
    if (broker.captchaLikely) {
      // A fake-person (noise) submission is never worth a person's time.
      const manual = !noise && opts.manual === true;
      if (opts.noCapsolver && !manual) {
        report(broker.name, 'manual', captchaFailureDetail({
          outcome: 'skipped', url: broker.optOutUrl, noSolver: true, headless: opts.headless, isTTY: opts.isTTY, config: opts.config,
        }));
        await closePage(page);
        return;
      }
      let outcome = 'none';
      // Before anyone is asked: where the page is, what it says, and whether the
      // submit control is there. The solver or the person may submit the form
      // themselves, and what follows is judged against this picture, not by clicking
      // blind (BRK2-3).
      const urlBeforeWait = pageUrl(page);
      const waits = !(opts.dryRun || opts.preview);
      let watch = null;
      let hadControl = false;
      if (waits && broker.submitSelector) {
        const control = await locateSubmitButton(page, broker).catch(() => null);
        hadControl = control !== null;
        watch = await armSubmitWatch(page, control);
        waitBaseline = await readBodyText(page);
      }
      // Dry-run and preview never submit, so they must not spend CapSolver credit
      // or keep a person waiting at a window.
      if (waits) {
        outcome = await handleCaptcha(page, {
          capsolver: opts.noCapsolver ? null : opts.capsolver,
          manual,
          broker,
          onWaiting: (info) => announceCaptchaWait(info, { notify: desktopNotify }),
          timeoutMs: manualTimeoutSec(opts.config) * 1000,
          solve: detectAndSolveCaptcha,
        });
      }
      // The CAPTCHA went away because the page was REPLACED, not solved (BRK2-5).
      // Only wording of a result that was not there before says the form was sent.
      if (outcome === 'navigated') {
        if (showsResultWording(newTextSince(waitBaseline, await readBodyText(page)), await readPageLang(page))) {
          outcome = 'solved';
          submittedMeanwhile = true;
        }
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
        state.failure(key, 'captcha_failed', stamp);
        await closePage(page);
        return;
      }
      if (outcome === 'solved' && !submittedMeanwhile && broker.submitSelector) {
        submittedMeanwhile = await submittedDuringWait(page, broker, { watch, hadControl, urlBeforeWait });
      }
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
      await closePage(page);
      return;
    }

    // Step 5: submit (skipped in dry-run mode)
    if (opts.dryRun) {
      report(broker.name, 'skipped', 'dry-run - form filled but not submitted');
      await closePage(page);
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

    // A form that was submitted during the CAPTCHA wait (by the person, or by the
    // solver's callback) has already been sent: classify what it produced against the
    // page as it was before the wait, and never click a second time.
    let textBefore = '';
    if (submittedMeanwhile) {
      textBefore = waitBaseline;
    } else {
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
    const pageLang = await readPageLang(page);
    const freshText = newTextSince(textBefore, await readBodyText(page));
    if (!freshText) {
      // The click left the page exactly as it was: a dead button, a blocked
      // script, or a result rendered elsewhere. None of those is a removal.
      report(broker.name, 'unverified', (submittedMeanwhile
        ? 'form was submitted during the CAPTCHA wait but the page shows no result - re-check next run'
        : 'submit clicked but the page did not change - re-check next run') + snapshotSuffix);
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
      state.pending(key, confirm.snippet, stamp);
    } else {
      const { outcome, snippet } = classifyPostSubmit(freshText, pageLang);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown.
        // Kind 'form_error', not 'error': the site answered, so this must not
        // count toward the defunct (unreachable) check (BRK-10).
        report(broker.name, 'error', (snippet || 'form submission may have failed') + snapshotSuffix);
        state.failure(key, 'form_error', stamp);
      } else if (outcome === 'success') {
        // Explicit confirmation text found - start 90-day cooldown
        report(broker.name, 'success', snippet + snapshotSuffix);
        state.success(key, '', stamp);
      } else {
        // 'unknown' = no confirmation text found - do NOT start 90-day cooldown;
        // next run will re-check so we don't hide silent failures
        report(broker.name, 'unverified', 'no explicit confirmation - re-check next run' + snapshotSuffix);
      }
    }

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : safeErrorDetail(err).slice(0, 80);
    report(broker.name, 'error', msg);
    state.failure(key, 'error', stamp);
  } finally {
    await closePage(page);
    await jitterSleep(5000, 15000);
  }
}

module.exports = { configure, processBroker, processBrokerWithPerson, scopeSelectorToForm, splitTopLevelCommas, newTextSince };
