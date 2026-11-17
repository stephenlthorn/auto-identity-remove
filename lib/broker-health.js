'use strict';
/**
 * lib/broker-health.js
 *
 * The broker health check: does each explicit broker's opt-out page still look
 * the way brokers.js says it does?
 *
 * It is a SHAPE check. It opens the opt-out page, looks at what answered and
 * whether the selectors the definition relies on exist, and nothing else. It
 * never types into a field, never clicks and never submits, so it cannot tell
 * whether a submission would delete anything. It also carries no personal data:
 * the broker list is built for a placeholder person (so every selector exists)
 * and only the opt-out URL is ever loaded, never a search URL.
 *
 * Labels:
 *   ok       the page loads and every selector matches a VISIBLE element. A
 *            manual broker is `ok` when its page answers: its form is not checked.
 *   drifted  the page loads, but a selector the definition relies on matches
 *            nothing visible (the detail names them), or the page is on another
 *            domain than the opt-out URL (the detail says "redirected to <host>")
 *   blocked  a bot wall, a CAPTCHA that hides the form (every selector missing
 *            beside a CAPTCHA or bot-manager marker), 403 / 429 / a challenge
 *            style 503. NEVER reported as drift: we did not see the real page.
 *            Some selectors matching beside a widget is drift, not a block.
 *   dead     the host does not resolve, the connection is refused, or 404 / 410
 *   error    a timeout, a 5xx that is not a challenge, a reset, a blank page
 *   n/a      email brokers: there is no page to check
 *
 * Why a fifth label instead of calling a timeout "dead": `dead` claims the page
 * is gone, and one slow response says nothing of the kind. Sites time out and
 * 502 for a minute every week. `error` is shown in the table but never opens an
 * issue, and the next weekly check overwrites it.
 *
 * This module ships with the package (`aidr doctor --brokers` uses it); the CI
 * driver is scripts/broker-health.js.
 */

const { detectBotWall, probeSearchPage } = require('./forms');
// One rule for "the same site", shared with the search step and the DROP coverage rule.
const { registrableDomain } = require('./domains');
const { isFillableElement } = require('./field-resolver');
const { detectCaptchaType, detectUnsupportedChallenge } = require('./captcha');

const STATUSES = ['ok', 'drifted', 'blocked', 'dead', 'error'];
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SETTLE_MS = 3000;
const SETTLE_STEP_MS = 500;

// A page with less visible text than this rendered nothing we can judge.
const BLANK_PAGE_CHARS = 20;

// Not a real person. Only here so every `${value}` in brokers.js has something to
// interpolate and every formFields key therefore exists. The values are never typed.
const PLACEHOLDER_PERSON = Object.freeze({
  firstName: 'Jane',
  lastName: 'Sample',
  fullName: 'Jane Sample',
  email: 'jane.sample@example.com',
  phone: '2025550123',
  country: 'US',
  city: 'Sampleville',
  state: 'CA',
  zip: '90001',
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}


/**
 * The selectors the definition relies on: the formFields keys plus the submit
 * selector. A `manual` broker has no form we drive, so it relies on none: the
 * page only has to answer.
 */
function expectedSelectors(broker) {
  if (!broker || broker.method === 'manual') return [];
  const keys = broker.formFields && typeof broker.formFields === 'object' ? Object.keys(broker.formFields) : [];
  if (broker.submitSelector) keys.push(broker.submitSelector);
  return [...new Set(keys)];
}

const DNS_ERROR = /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_NODATA|getaddrinfo/i;
const REFUSED_ERROR = /ERR_CONNECTION_REFUSED|ECONNREFUSED/i;
const TIMEOUT_ERROR = /timeout|timed out|ETIMEDOUT/i;

/** Short, URL-free reason for a failed navigation. URLs can carry a person, so none is echoed. */
function describeNavigationError(message) {
  const text = String(message || '');
  const code = (text.match(/net::(ERR_[A-Z_]+)/) || text.match(/\b(E[A-Z]{3,}[A-Z_]*)\b/) || [])[1];
  return code ? `could not load the page (${code})` : 'could not load the page';
}

function classifyNavigationError(message) {
  if (DNS_ERROR.test(message)) return { status: 'dead', detail: 'host does not resolve' };
  if (REFUSED_ERROR.test(message)) return { status: 'dead', detail: 'connection refused' };
  if (TIMEOUT_ERROR.test(message)) return { status: 'error', detail: 'timed out loading the page' };
  return { status: 'error', detail: describeNavigationError(message) };
}

// A wall whose only evidence is wording ("security check" ...) loses to a page
// that really has the form on it; a wall detected from the page's structure,
// title or redirect does not.
const wordingOnly = (wall) => /text/.test(wall.reason);

/**
 * Which label does one page load get? Pure: takes the facts checkBroker gathered.
 *
 * @param {object} facts
 *   outcome   'response' | 'error'
 *   message   (error) the navigation error text
 *   status    HTTP status of the main document, or null when unknown
 *   url, title, text, textLength, markers   from probeSearchPage
 *   headers   lower-cased response headers
 *   captchaPresent   a CAPTCHA widget or detect-only challenge script is on the page
 *   selectors  the selectors the definition relies on
 *   missing    the ones that matched no visible element
 *   method     the broker's method (a manual broker's form is not checked)
 *   requestedUrl  the opt-out URL that was loaded; `url` is where it ended up
 * @returns {{ status: string, detail: string, missing?: string[], redirectedTo?: string }}
 */
function classifyHealth(facts) {
  if (facts.outcome === 'error') return classifyNavigationError(facts.message);

  const code = Number.isFinite(facts.status) ? facts.status : 200;
  if (code === 404 || code === 410) return { status: 'dead', detail: `HTTP ${code}: the page is gone` };

  const selectors = facts.selectors || [];
  const missing = facts.missing || [];
  const markers = facts.markers || [];
  const headers = facts.headers || {};
  const host = hostOf(facts.url);
  const wall = detectBotWall({
    url: facts.url, title: facts.title, text: String(facts.text || '').toLowerCase(),
    textLength: facts.textLength, markers,
  }, host);
  const mitigated = Boolean(headers['cf-mitigated']);

  if ([401, 403, 429, 451].includes(code)) return { status: 'blocked', detail: `HTTP ${code}: the site refused this address` };
  if (code >= 500) {
    if (mitigated || (wall && wall.strong)) {
      return { status: 'blocked', detail: `HTTP ${code} with a bot challenge${wall ? ` (${wall.reason})` : ''}` };
    }
    return { status: 'error', detail: `HTTP ${code} from the site` };
  }
  if (code >= 400) return { status: 'error', detail: `HTTP ${code} from the site` };

  const formIsHere = selectors.length > 0 && missing.length === 0;
  if (wall && wall.strong && !(formIsHere && wordingOnly(wall))) {
    return { status: 'blocked', detail: `bot wall: ${wall.reason}` };
  }
  if (mitigated) return { status: 'blocked', detail: 'bot challenge (cf-mitigated)' };

  // A 2xx page on ANOTHER site (a parking page, a sold domain, a company that
  // moved its privacy portal) is not the page the definition describes, whatever
  // method the broker has and whatever its selectors happen to match there.
  const requestedHost = hostOf(facts.requestedUrl);
  if (host && requestedHost && registrableDomain(host) !== registrableDomain(requestedHost)) {
    return { status: 'drifted', detail: `redirected to ${host}`, redirectedTo: host };
  }

  if (missing.length === 0) {
    const widget = facts.captchaPresent ? ', a CAPTCHA is on the page' : '';
    if (facts.method === 'manual') return { status: 'ok', detail: `the page answers; a manual broker's form is not checked${widget}` };
    if (selectors.length === 0) return { status: 'ok', detail: `the page answers${widget}` };
    return { status: 'ok', detail: `the page loads and all ${selectors.length} selectors match${widget}` };
  }

  // Selectors are missing from here on. Before calling that drift, rule out a
  // page we cannot judge: a CAPTCHA may be hiding the form, a blank page may be
  // a check that renders nothing.
  //
  // A CAPTCHA or bot-manager marker is NORMAL on a live opt-out form (an inline
  // reCAPTCHA or Turnstile widget, a v3 script, a passive DataDome tag), so its
  // presence alone says nothing. It only means "we did not see the form" when
  // not one selector matched. If some match and some do not, the form is on the
  // page and part of it changed: that is drift, and the issue must open.
  const everyMissing = selectors.length > 0 && missing.length >= selectors.length;
  if (everyMissing && (facts.captchaPresent || (wall && !wall.strong))) {
    return { status: 'blocked', detail: 'a CAPTCHA is on the page and the form is not visible behind it' };
  }
  if (Number(facts.textLength) < BLANK_PAGE_CHARS) {
    return { status: 'error', detail: 'the page rendered no content, so the form could not be checked' };
  }
  const where = host && requestedHost && requestedHost !== host ? ` (redirected to ${host})` : '';
  return {
    status: 'drifted',
    detail: `${missing.length} of ${selectors.length} selectors match nothing visible: ${missing.join(' | ')}${where}`,
    missing,
  };
}

// ── Page checks (read-only) ──────────────────────────────────────────────────

// Inputs a person does not type into: only Playwright's own visibility applies to them.
const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'];

/**
 * Page side: which of these selectors match NO VISIBLE element right now. Runs
 * inside the page via page.evaluate, so it must stay self-contained (no closure
 * variables; the field-visibility test arrives as source text, the way
 * lib/field-resolver.js rebuilds its scorer). An invalid selector counts as a
 * miss rather than throwing.
 *
 * "Visible" is the test the runner applies before it fills or clicks (see
 * lib/forms.js): Playwright's isVisible (a non-empty box that is not
 * visibility:hidden), and for a text field also isFillableElement (not parked
 * off-screen, not aria-hidden, not faded out, not tabindex -1, not tiny). A
 * plain document.querySelector counts a display:none field as a match, and a
 * form whose real fields were swapped for a hidden template would pass.
 *
 * @param {{ selectors: string[], fillableSrc: string, nonText: string[] }} arg
 */
function collectMissingSelectors(arg) {
  // eslint-disable-next-line no-new-func
  const isFillable = new Function('return (' + arg.fillableSrc + ')')();
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    if (window.getComputedStyle(el).visibility === 'hidden') return false;
    const tag = el.tagName.toLowerCase();
    const textEntry = tag === 'textarea' || (tag === 'input' && arg.nonText.indexOf((el.type || '').toLowerCase()) === -1);
    if (!textEntry) return true;
    try { return isFillable(el) !== false; } catch (_) { return true; }
  };
  return arg.selectors.filter((selector) => {
    try { return !Array.from(document.querySelectorAll(selector)).some(shown); } catch (_) { return true; }
  });
}

const sleepOn = (page, ms) => (typeof page.waitForTimeout === 'function'
  ? page.waitForTimeout(ms)
  : new Promise((resolve) => setTimeout(resolve, ms)));

// Playwright's own selector extensions. document.querySelector cannot parse
// them, so a selector that uses one is asked of Playwright instead of being
// reported as missing (brokers.js uses :has-text on a few submit buttons).
const PLAYWRIGHT_ONLY = /:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible|:nth-match\(|:has\(|^text=|^xpath=|^css=|^role=|>>/;

// How many matches of a Playwright-only selector are looked at for a visible one.
const MAX_LOCATOR_MATCHES = 20;

/** Does a Playwright locator match at least one element a person could use? */
async function locatorHasVisibleMatch(locator) {
  const count = Math.min(await locator.count(), MAX_LOCATOR_MATCHES);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (!(await el.isVisible())) continue;
    const fillable = await el.evaluate(isFillableElementIfTextEntry, { nonText: NON_TEXT_INPUT_TYPES, src: isFillableElement.toString() }).catch(() => true);
    if (fillable !== false) return true;
  }
  return false;
}

// Runs in the page (closure-free): the text-field test, only for fields people type in.
function isFillableElementIfTextEntry(el, arg) {
  const tag = el.tagName.toLowerCase();
  const textEntry = tag === 'textarea' || (tag === 'input' && arg.nonText.indexOf((el.type || '').toLowerCase()) === -1);
  if (!textEntry) return true;
  // eslint-disable-next-line no-new-func
  return new Function('return (' + arg.src + ')')()(el);
}

async function stillMissing(page, selectors) {
  const missing = await page.evaluate(collectMissingSelectors, {
    selectors, fillableSrc: isFillableElement.toString(), nonText: NON_TEXT_INPUT_TYPES,
  });
  if (typeof page.locator !== 'function') return missing;
  const out = [];
  for (const selector of missing) {
    if (!PLAYWRIGHT_ONLY.test(selector)) { out.push(selector); continue; }
    let found = false;
    try { found = await locatorHasVisibleMatch(page.locator(selector)); } catch (_) { found = false; }
    if (!found) out.push(selector);
  }
  return out;
}

/** Selectors still missing after giving a script-rendered form a moment to appear. */
async function waitForSelectors(page, selectors, settleMs) {
  if (selectors.length === 0) return [];
  let missing = await stillMissing(page, selectors);
  for (let waited = 0; missing.length > 0 && waited < settleMs; waited += SETTLE_STEP_MS) {
    await sleepOn(page, SETTLE_STEP_MS);
    missing = await stillMissing(page, selectors);
  }
  return missing;
}

const orNull = (promise) => promise.catch(() => null);

/**
 * Check one broker. Opens its opt-out URL ONCE and only looks: it never types,
 * clicks or submits, and never loads a search URL.
 *
 * @param {import('playwright').Page} page
 * @param {object} broker
 * @param {{ timeoutMs?: number, settleMs?: number }} [opts]
 * @returns {Promise<{ status: string, detail: string, missing?: string[] }>}
 */
async function checkBroker(page, broker, opts = {}) {
  if (broker.method === 'email') return { status: 'n/a', detail: 'removal is an email, there is no page to check' };
  if (!broker.optOutUrl) return { status: 'n/a', detail: 'no opt-out page in the definition' };

  const selectors = expectedSelectors(broker);
  const timeout = opts.timeoutMs || broker.timeoutMs || DEFAULT_TIMEOUT_MS;
  const settleMs = opts.settleMs !== undefined ? opts.settleMs : DEFAULT_SETTLE_MS;

  let response;
  try {
    response = await page.goto(broker.optOutUrl, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    return classifyHealth({ outcome: 'error', message: err && err.message });
  }

  const status = response && typeof response.status === 'function' ? response.status() : null;
  if (status === 404 || status === 410) return classifyHealth({ outcome: 'response', status, selectors, missing: [] });

  const probe = await orNull(page.evaluate(probeSearchPage, { src: '(?!)', flags: '' })) || {};
  const [captcha, unsupported] = await Promise.all([
    orNull(detectCaptchaType(page)),
    orNull(detectUnsupportedChallenge(page)),
  ]);
  const missing = (await orNull(waitForSelectors(page, selectors, settleMs))) || selectors;

  return classifyHealth({
    outcome: 'response',
    status,
    method: broker.method,
    requestedUrl: broker.optOutUrl,
    url: probe.url || broker.optOutUrl,
    title: probe.title || '',
    text: probe.text || '',
    textLength: probe.textLength || 0,
    markers: probe.markers || [],
    headers: response && typeof response.headers === 'function' ? response.headers() : {},
    captchaPresent: Boolean(captcha || unsupported || (probe.markers || []).some((m) => ['recaptcha', 'hcaptcha', 'turnstile'].includes(m))),
    selectors,
    missing,
  });
}

// ── Whole-list run and the file it produces ──────────────────────────────────

/** The explicit brokers, built for the placeholder person. No personal data is read. */
function explicitBrokers(brokers) {
  return brokers.forPerson(PLACEHOLDER_PERSON);
}

/**
 * Check every broker, one page at a time. Each broker gets a fresh page that is
 * closed afterwards, and exactly one load: a block is reported, not retried.
 *
 * @param {object} args
 * @param {object[]} args.brokers
 * @param {() => Promise<import('playwright').Page>} args.newPage
 * @param {() => number} [args.now]
 * @param {number} [args.pauseMs]   politeness gap between brokers
 * @param {(entry: { name: string, status: string, detail: string }) => void} [args.onResult]
 * @param {object} [args.checkOpts]
 * @returns {Promise<Array<{ name: string, status: string, detail: string, missing?: string[], checkedAt: string }>>}
 */
async function checkAllBrokers({ brokers, newPage, now = Date.now, pauseMs = 0, onResult, checkOpts }) {
  const out = [];
  for (const broker of brokers) {
    let result;
    let page = null;
    try {
      page = broker.method === 'email' || !broker.optOutUrl ? null : await newPage();
      result = await checkBroker(page, broker, checkOpts);
    } catch (err) {
      result = { status: 'error', detail: `the check itself failed: ${describeNavigationError(err && err.message)}` };
    } finally {
      if (page) await page.close().catch(() => {});
    }
    const entry = { name: broker.name, ...result, checkedAt: new Date(now()).toISOString() };
    out.push(entry);
    if (onResult) onResult(entry);
    if (pauseMs && page) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return out;
}

/**
 * Counts per label. `total` counts the brokers that HAVE a page to check
 * (everything except n/a), so "ok of total" is the honest headline.
 */
function summarize(results) {
  const summary = { ok: 0, drifted: 0, blocked: 0, dead: 0, error: 0, na: 0, total: 0 };
  for (const entry of Object.values(results)) {
    if (entry.status === 'n/a') summary.na += 1;
    else if (STATUSES.includes(entry.status)) { summary[entry.status] += 1; summary.total += 1; }
  }
  return summary;
}

/**
 * The data/broker-health.json document for one run. `previousStatus` is the
 * label the same broker had in the file as it was before this run (null when it
 * had none, or when the file came from a different kind of runner), which is
 * what lets the issue sync wait for two checks in a row from the same runner.
 *
 * Results for names that are not in `known` (the current broker list) are
 * dropped, and the summary is computed from what is kept only. Otherwise a broker
 * removed from brokers.js lingers in the file, and the README badges (which read
 * the summary) disagree with STATUS.md (which only lists the current brokers).
 *
 * @param {{ checked: object[], previous?: object, runner: 'ci'|'local', checkedAt: string, known?: string[] }} args
 */
function buildHealthFile({ checked, previous, runner, checkedAt, known }) {
  const keep = Array.isArray(known) ? new Set(known) : null;
  // Only a file written by the same kind of runner counts as history. The file
  // committed to the repo is usually `local` (a developer's machine), and a CI
  // data centre address sees a different web (it is blocked more, and sees other
  // experiments); letting the first CI run inherit a `drifted` from a local run
  // would open an issue after ONE CI check instead of two.
  const sameRunner = previous && previous.runner === runner;
  const before = sameRunner && previous.results && typeof previous.results === 'object' ? previous.results : {};
  const results = {};
  for (const entry of checked) {
    if (keep && !keep.has(entry.name)) continue;
    const prior = before[entry.name];
    results[entry.name] = {
      status: entry.status,
      detail: entry.detail,
      checkedAt: entry.checkedAt,
      previousStatus: prior && typeof prior.status === 'string' ? prior.status : null,
    };
    if (entry.missing && entry.missing.length > 0) results[entry.name].missing = entry.missing;
    if (entry.redirectedTo) results[entry.name].redirectedTo = entry.redirectedTo;
  }
  return { checkedAt, runner, summary: summarize(results), results };
}

module.exports = {
  STATUSES,
  PLACEHOLDER_PERSON,
  classifyHealth,
  expectedSelectors,
  checkBroker,
  checkAllBrokers,
  explicitBrokers,
  summarize,
  buildHealthFile,
  collectMissingSelectors,
};
