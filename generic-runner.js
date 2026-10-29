/**
 * generic-runner.js
 *
 * Handles the ~460 brokers from The Markup's 499-URL dataset and BADBOOL
 * that aren't explicitly mapped in brokers.js.
 *
 * Strategy per site:
 *   1. Navigate to the opt-out URL
 *   2. Dismiss cookie banners
 *   3. Try these in order:
 *      a. "Do Not Sell My Personal Information" button → click it
 *      b. OneTrust / TrustArc / Osano preference manager → opt out all
 *      c. Form with email field only → fill + submit
 *      d. Form with name + email fields → fill + submit
 *      e. DSAR / data request form → fill + submit
 *   4. If nothing automatable → manual list
 *
 * Returns: { succeeded, skipped, manual, errors }
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const dns  = require('dns');

const CONFIG_PATH     = path.join(__dirname, 'config.json');
const STATE_PATH      = path.join(__dirname, 'state.json');
const MARKUP_PATH     = path.join(__dirname, 'data', 'markup-parsed.json');
const BADBOOL_PATH    = path.join(__dirname, 'data', 'badbool-extra.json');
const FEEDS_PATH      = path.join(__dirname, 'data', 'feeds-brokers.json');
const DEAD_URLS_PATH  = path.join(__dirname, 'data', 'dead-urls.json');

const { looksLikeConfirmationRequired, PATTERN: CONFIRM_PATTERN } = require('./lib/confirm');
const { classifyPostSubmit } = require('./lib/success');
const { patternsFor, langOf } = require('./lib/locale-patterns');
const { CONFIRM_RECHECK_DAYS, loadConfig } = require('./lib/config');
const { withRetry } = require('./lib/retry');
const { isAllowlisted } = require('./lib/filter');

// Config is loaded lazily so that modules importing only the pure helpers
// (classifyNavError, isDeadStatus, loadDeadSet) don't require config.json.
// Routed through loadConfig (not raw JSON.parse) so that encrypted configs
// (--encrypt-config) are decrypted transparently via AIDR_PASSPHRASE.
let _config = null;
function getConfig() {
  if (!_config) {
    // loadConfig() calls process.exit(1) when config is absent; avoid that by
    // checking existence first so callers that wrap in try/catch can handle it.
    const encPath = CONFIG_PATH + '.enc';
    if (!fs.existsSync(encPath) && !fs.existsSync(CONFIG_PATH)) {
      throw new Error('No config found; run node setup.js to create one');
    }
    _config = loadConfig();
  }
  return _config;
}
// Test-only: inject a pre-parsed config object to avoid I/O and allow test
// isolation without patching fs. Reset to null to re-enable lazy loading.
function _setConfig(cfg) {
  _config = cfg || null;
}

const RECHECK_DAYS = 90;

// Default Playwright action timeout for the working page (BRK-12).
const ACTION_TIMEOUT_MS = 5000;

// ─── Dead-URL cache ───────────────────────────────────────────────────────────
// Loaded once at module init; missing / malformed file treated as empty set.

function loadDeadSet(deadUrlsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(deadUrlsPath, 'utf8'));
    return new Set(Array.isArray(raw.hosts) ? raw.hosts : []);
  } catch (_) {
    return new Set();
  }
}

const deadSet = loadDeadSet(DEAD_URLS_PATH);

// ─── Navigation-error classifier (pure, exported for testing) ─────────────────

const DEAD_ERROR_PATTERNS = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_CLOSED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_TIMED_OUT',
  'ENOTFOUND',
];

/**
 * Classify a navigation error message as 'dead' or 'error'.
 * Returns the short code if dead, or null if it should stay 'error'.
 * @param {string} message
 * @returns {string|null}
 */
function classifyNavError(message) {
  for (const pattern of DEAD_ERROR_PATTERNS) {
    if (message.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * Returns true when an HTTP status code indicates a dead/gone URL.
 * 4xx codes that indicate a live-but-blocking site (403 bot-block, 429 rate-limit,
 * 401 auth required, 451 legal block) are NOT treated as dead - the site exists and
 * the opt-out may succeed on a retry. Only 404 (Not Found), 410 (Gone), and 5xx
 * (server error) are considered permanently dead.
 * @param {number} code
 * @returns {boolean}
 */
function isDeadStatus(code) {
  return code === 404 || code === 410 || code >= 500;
}

// ─── Target-URL guard (codex #2) ──────────────────────────────────────────────
//
// Registry and dataset rows are only "URLs that start with http". Left alone, a
// hostile or broken row (loopback, RFC1918, cloud metadata, a host that redirects
// to one) gets the browser pointed at an internal service, and the first form on
// the page gets the user's name, email and address. Every broker URL is checked
// before navigation and the page's final URL is checked again after it.

// Reserved / internal-only names. None of these is ever a public data broker.
const INTERNAL_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'lan', 'intranet', 'corp'];
const DNS_LOOKUP_TIMEOUT_MS = 5000;
// RFC 2606 / 6761 names never resolve to a real broker. With the default resolver
// they are not worth a DNS query (the navigation fails on its own), which also
// keeps tests and docs that use them off the network.
const RESERVED_NAME_SUFFIXES = ['example', 'invalid', 'test', 'example.com', 'example.net', 'example.org'];

function parseIPv4(str) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every(n => n <= 255) ? octets : null;
}

function isBlockedIPv4([a, b]) {
  return a === 0                              // 0.0.0.0/8 unspecified / "this network"
    || a === 10                               // 10.0.0.0/8 private
    || a === 127                              // 127.0.0.0/8 loopback
    || (a === 100 && b >= 64 && b <= 127)     // 100.64.0.0/10 CGNAT
    || (a === 169 && b === 254)               // 169.254.0.0/16 link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)      // 172.16.0.0/12 private
    || (a === 192 && b === 168)               // 192.168.0.0/16 private
    || a >= 224;                              // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
}

// Expand an IPv6 literal into its 8 16-bit groups, or null when it is not one.
function parseIPv6(str) {
  let s = String(str).split('%')[0];
  if (!net.isIPv6(s)) return null;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const groupsOf = (part) => (part === '' ? [] : part.split(':'));
  let groups;
  if (s.includes('::')) {
    const [head, tail] = s.split('::');
    const h = groupsOf(head);
    const t = groupsOf(tail);
    const missing = 8 - h.length - t.length;
    if (missing < 0) return null;
    groups = [...h, ...Array(missing).fill('0'), ...t];
  } else {
    groups = groupsOf(s);
  }
  if (groups.length !== 8) return null;
  const nums = groups.map(g => parseInt(g, 16));
  return nums.some(n => Number.isNaN(n)) ? null : nums;
}

function isBlockedIPv6(g) {
  const allZero = (from, to) => g.slice(from, to).every(n => n === 0);
  const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (allZero(0, 8)) return true;                               // ::  unspecified
  if (allZero(0, 7) && g[7] === 1) return true;                 // ::1 loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true;                  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                  // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                  // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true;                  // ff00::/8 multicast
  if (g[0] === 0x100 && allZero(1, 4)) return true;             // 100::/64 discard-only
  // Addresses that carry an IPv4 address: judge them by the IPv4 inside.
  if (allZero(0, 5) && g[5] === 0xffff) return isBlockedIPv4(v4Of(g[6], g[7]));   // ::ffff:a.b.c.d mapped
  if (allZero(0, 6)) return isBlockedIPv4(v4Of(g[6], g[7]));                       // ::a.b.c.d compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return isBlockedIPv4(v4Of(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(v4Of(g[1], g[2]));                     // 2002::/16 6to4
  return false;
}

/**
 * True when an address must never be a broker target. Anything that is not
 * recognisably an IP address is refused rather than trusted.
 * @param {string} address
 * @returns {boolean}
 */
function isDisallowedAddress(address) {
  const family = net.isIP(String(address || '').split('%')[0]);
  if (family === 4) return isBlockedIPv4(parseIPv4(address));
  if (family === 6) {
    const groups = parseIPv6(address);
    return groups ? isBlockedIPv6(groups) : true;
  }
  return true;
}

async function resolveAll(host, lookup, timeoutMs) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns lookup timed out')), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const found = await Promise.race([lookup(host, { all: true }), timedOut]);
    return Array.isArray(found) ? found : [found];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a URL may be navigated to / may be where the page ended up.
 *
 * A failed or timed-out DNS lookup is NOT a rejection: an unresolvable host is
 * just a dead broker, and the browser's own navigation error is what classifies
 * it as 'dead' (ERR_NAME_NOT_RESOLVED). Only a lookup that succeeds and returns a
 * disallowed address blocks the row.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: Function, timeoutMs?: number }} [opts] lookup is dns.promises.lookup-shaped
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function checkBrokerUrl(rawUrl, opts = {}) {
  const lookup = opts.lookup || dns.promises.lookup;
  const timeoutMs = opts.timeoutMs || DNS_LOOKUP_TIMEOUT_MS;
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return { ok: false, reason: 'unparseable url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol.replace(/:$/, '')} is not http(s)` };
  }
  if (url.username || url.password) return { ok: false, reason: 'url embeds credentials' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'url has no host' };
  if (net.isIP(host)) return { ok: false, reason: `ip literal ${host}` };
  for (const suffix of INTERNAL_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { ok: false, reason: `internal host name ${host}` };
  }

  if (!opts.lookup && RESERVED_NAME_SUFFIXES.some(r => host === r || host.endsWith(`.${r}`))) return { ok: true };

  let addresses;
  try {
    addresses = await resolveAll(host, lookup, timeoutMs);
  } catch (_) {
    return { ok: true };
  }
  for (const entry of addresses) {
    const address = entry && entry.address;
    if (isDisallowedAddress(address)) return { ok: false, reason: `${host} resolves to ${address}` };
  }
  return { ok: true };
}

/**
 * A checker that remembers its verdict per host for one broker, so the redirect
 * re-checks (after navigation, after a click) do not repeat the DNS lookup.
 */
function makeUrlChecker(opts = {}) {
  const verdicts = new Map();
  return async (rawUrl) => {
    let key = rawUrl;
    try { key = new URL(rawUrl).origin; } catch (_) {}
    if (verdicts.has(key)) return verdicts.get(key);
    const verdict = await checkBrokerUrl(rawUrl, opts);
    verdicts.set(key, verdict);
    return verdict;
  };
}

// ─── Cookie banner + CCPA pop-up dismisser ────────────────────────────────────

const DECLINE_COOKIE_SELECTORS = [
  // Generic decline / reject buttons
  'button[id*="reject" i]', 'button[id*="decline" i]',
  'button[class*="reject" i]', 'button[class*="decline" i]',
  'button[aria-label*="reject" i]', 'button[aria-label*="decline" i]',
  // "Accept only necessary"
  'button[id*="necessary" i]', 'button[id*="essential" i]',
  // OneTrust
  '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler',
  // Osano
  '.osano-cm-deny',
  // Cookiebot
  '#CybotCookiebotDialogBodyButtonDecline',
  // Generic close
  'button[aria-label="Close"]',
];

async function dismissBanners(page) {
  for (const sel of DECLINE_COOKIE_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible({ timeout: 500 }))) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(500);
        break;
      }
    } catch(_) {}
  }
}

// ─── Do Not Sell button detector ─────────────────────────────────────────────

const DNS_SELECTORS = [
  // Common text patterns
  'a:has-text("Do Not Sell")', 'button:has-text("Do Not Sell")',
  'a:has-text("Do Not Share")', 'button:has-text("Do Not Share")',
  'a:has-text("Opt Out of Sale")', 'button:has-text("Opt Out of Sale")',
  'a:has-text("Submit a Request")', 'a:has-text("Data Subject Request")',
  // ID / class patterns
  '[id*="donotsell" i]', '[id*="do-not-sell" i]',
  '[class*="donotsell" i]', '[class*="do-not-sell" i]',
  // OneTrust opt-out link
  '.optanon-toggle-display',
];

// beforeClick runs right before the click so the caller can snapshot the forms
// that were already on the page: a form that only appears afterwards was opened
// by the control we just clicked.
async function clickDoNotSell(page, { beforeClick } = {}) {
  for (const sel of DNS_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible({ timeout: 500 }))) {
        if (beforeClick) await beforeClick();
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(1500);
        return true;
      }
    } catch(_) {}
  }
  return false;
}

// ─── OneTrust / TrustArc preference opt-out ─────────────────────────────────

// A consent manager is only "present" when its own container is on the page and
// visible. Matching a bare "Save" / "Confirm" button anywhere (the old check)
// accepted "Save job" on a careers page as a privacy manager, then reported an
// opt-out that never happened (BRK-2).
const PRIVACY_MANAGER_CONTAINERS = [
  // OneTrust
  '#onetrust-pc-sdk', '#onetrust-consent-sdk',
  // TrustArc
  '#truste-consent-track', '#teconsent', '#consent_blackbar', '.truste_box_overlay',
];

// Opt-out controls INSIDE the container, in order of preference. Deliberately
// absent: #accept-recommended-btn-handler. In OneTrust's preference centre that
// id is "Allow All", and the old list clicked it right after switching the
// toggles off, which turned them all back on.
const PRIVACY_MANAGER_SAVE_SELECTORS = [
  '.save-preference-btn-handler',
  '.ot-pc-refuse-all-handler',
  'button:has-text("Confirm My Choices")',
  'button:has-text("Required Only")',
  'button:has-text("Reject All")',
];

async function findPrivacyManager(page) {
  for (const sel of PRIVACY_MANAGER_CONTAINERS) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible())) return el;
    } catch (_) {}
  }
  return null;
}

/**
 * Turn off the optional categories in a real OneTrust / TrustArc manager and save.
 * Returns true only when a save control inside the manager was actually clicked;
 * false (nothing found, or the click failed) lets the caller fall through to the
 * next strategy instead of reporting a click that never happened.
 */
async function handlePrivacyManager(page) {
  const manager = await findPrivacyManager(page);
  if (!manager) return false;

  // Only visible, enabled toggles: a hidden or disabled (strictly necessary)
  // toggle cannot be clicked and used to burn the full 30 s default wait (BRK-12).
  const toggles = await manager.locator('.ot-tgl input[type="checkbox"]:checked:not([disabled])').all();
  for (const t of toggles) {
    try {
      if (await t.isVisible()) await t.click({ timeout: 2000 });
    } catch (_) {}
  }

  for (const sel of PRIVACY_MANAGER_SAVE_SELECTORS) {
    try {
      const btn = manager.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 5000 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ─── Page text evidence (BRK-1) ───────────────────────────────────────────────
//
// A click is not an opt-out. What happened after it is judged from the text that
// APPEARED because of the click, never from copy that was already on the page
// ("once your request has been received we will..." is static marketing text).

// Named, self-contained functions: Playwright serialises them into the page.
function readBodyInPage() {
  return (document.body && document.body.innerText) || '';
}
function readLangInPage() {
  return (document.documentElement && document.documentElement.getAttribute('lang')) || '';
}

async function readBodyText(page) {
  try {
    const text = await page.evaluate(readBodyInPage);
    return typeof text === 'string' ? text : '';
  } catch (_) {
    return '';
  }
}

async function readPageLang(page) {
  try {
    const raw = await page.evaluate(readLangInPage);
    return langOf(typeof raw === 'string' ? raw : '');
  } catch (_) {
    return '';
  }
}

const normalizeLines = (text) =>
  String(text || '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

/**
 * The lines in `after` that were not in `before` (a multiset diff, so a line that
 * appears one more time than before counts as new). A page that was replaced
 * outright is entirely new text.
 * @param {string} before
 * @param {string} after
 * @returns {string}
 */
function newTextSince(before, after) {
  const remaining = new Map();
  for (const line of normalizeLines(before)) remaining.set(line, (remaining.get(line) || 0) + 1);
  const fresh = [];
  for (const line of normalizeLines(after)) {
    const left = remaining.get(line) || 0;
    if (left > 0) remaining.set(line, left - 1);
    else fresh.push(line);
  }
  return fresh.join('\n');
}

function snippetOf(text, patterns) {
  for (const re of patterns) {
    const m = re && text.match(re);
    if (m) return text.slice(Math.max(0, m.index - 30), m.index + 120).replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * Judge what a click did from the text it added to the page.
 *   confirmation-email wording -> pending_confirm (existing path)
 *   success wording            -> success
 *   failure / validation text  -> error
 *   anything else              -> unverified (never a cooldown)
 * @returns {Promise<{ status: string, detail: string }>}
 */
async function judgeNewText(page, beforeText, label) {
  const fresh = newTextSince(beforeText, await readBodyText(page));
  const lang = await readPageLang(page);
  if (looksLikeConfirmationRequired(fresh, lang)) {
    const locale = patternsFor(lang);
    return { status: 'pending_confirm', detail: snippetOf(fresh, [CONFIRM_PATTERN, locale && locale.confirm]) || 'check your email to confirm' };
  }
  const { outcome, snippet } = classifyPostSubmit(fresh, lang);
  if (outcome === 'success') return { status: 'success', detail: snippet || label };
  if (outcome === 'failure') return { status: 'error', detail: snippet || 'form submission may have failed' };
  return { status: 'unverified', detail: `${label}: no explicit confirmation - re-check next run` };
}

// ─── Which form is an opt-out form? (codex #3) ────────────────────────────────
//
// The generic runner used to type the person's details into the first form on the
// page and click the first submit button, so a footer newsletter or contact form
// got a name, email and zip instead of a removal request. A form is now submitted
// only if it looks like an opt-out / deletion / privacy-request form AND does not
// look like a newsletter / login / search / contact / checkout form.

const MAX_FORMS = 10;

// Runs INSIDE the page (via locator.evaluate): it must stay self-contained.
function describeFormElement(form) {
  const squash = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const textOf = (n) => squash(n && (n.innerText || n.textContent));
  const attr = (n, a) => (n && n.getAttribute && n.getAttribute(a)) || '';
  const lower = (v) => String(v || '').toLowerCase();

  const controls = Array.from(form.querySelectorAll('input, select, textarea, button'));
  const typeOf = (c) => lower(c.getAttribute('type'));
  const isAction = (c) => c.tagName === 'BUTTON' || ['submit', 'button', 'image', 'reset'].includes(typeOf(c));
  const isData = (c) => !isAction(c) && typeOf(c) !== 'hidden';
  const fields = controls.filter(isData);

  const fieldHints = fields.map((c) => {
    const labels = c.labels ? Array.from(c.labels).map(textOf).join(' ') : '';
    return [attr(c, 'name'), c.id, attr(c, 'placeholder'), attr(c, 'aria-label'), attr(c, 'autocomplete'), labels].join(' ');
  }).join(' ');

  const submitTexts = controls.filter(isAction).map((c) => (
    c.tagName === 'INPUT' ? squash(c.value) : squash(c.innerText || c.value || attr(c, 'aria-label'))
  )).filter(Boolean);

  const legends = Array.from(form.querySelectorAll('legend, h1, h2, h3, h4, h5, h6, [role="heading"]'))
    .map(textOf).filter(Boolean).join(' | ');

  // The heading that introduces this form when it sits outside it (a modal title,
  // a section heading): climb while this is the only form in the container.
  let heading = '';
  let node = form;
  for (let i = 0; i < 4 && node.parentElement; i++) {
    const parent = node.parentElement;
    if (/^(BODY|HTML)$/.test(parent.tagName) || parent.querySelectorAll('form').length > 1) break;
    const found = Array.from(parent.querySelectorAll('h1, h2, h3, h4, [role="heading"]')).find(n => !form.contains(n));
    if (found) { heading = textOf(found); break; }
    node = parent;
  }

  const dialog = form.closest('dialog, [role="dialog"], [aria-modal="true"]');
  let dialogLabel = attr(dialog, 'aria-label');
  if (!dialogLabel && dialog) {
    const labelledBy = attr(dialog, 'aria-labelledby');
    dialogLabel = labelledBy ? textOf(document.getElementById(labelledBy)) : '';
  }

  let action = '';
  try { action = new URL(attr(form, 'action') || '', document.baseURI).href; } catch (_) { action = attr(form, 'action'); }

  const fieldNames = fields.map(c => lower(attr(c, 'name') || c.id));
  const shown = !!(form.offsetWidth || form.offsetHeight || form.getClientRects().length)
    && window.getComputedStyle(form).visibility !== 'hidden';

  return {
    visible: shown,
    text: textOf(form).slice(0, 1500),
    legends: legends.slice(0, 300),
    heading: heading.slice(0, 200),
    dialogLabel: squash(dialogLabel).slice(0, 200),
    action,
    id: form.id || '',
    className: typeof form.className === 'string' ? form.className : '',
    name: attr(form, 'name'),
    ariaLabel: attr(form, 'aria-label'),
    submitTexts: submitTexts.slice(0, 6),
    fieldHints: squash(fieldHints).slice(0, 400),
    hasPassword: !!form.querySelector('input[type="password"]'),
    hasSearch: !!form.querySelector('input[type="search"]') || lower(attr(form, 'role')) === 'search'
      || !!form.closest('[role="search"]') || fieldNames.some(n => /^(q|s|query|search|keyword|keywords)$/.test(n)),
    hasPayment: !!form.querySelector('input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]'),
    chrome: !!form.closest('footer, header, nav, aside, [role="contentinfo"], [role="banner"], [role="navigation"], [role="complementary"]'),
    fillable: fields.length,
  };
}

// Text is lower-cased and camelCase / punctuation split, so ids and classes like
// "doNotSell", "opt-out_form" and "ccpa-request" read the same as prose.
function vocabText(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPT_OUT_VOCAB = /\b(opt ?out|optout|remov(e|es|ed|al|ing)|delet(e|es|ed|ion|ing)|eras(e|ure)|do not (sell|share)|donotsell|dont sell|privacy (requests?|rights?|choices?|portal)|(data|subject|consumer|access|deletion|information) requests?|dsar|ccpa|cpra|gdpr|suppress(ion)?|right to (know|delete|be forgotten)|unlist|unpublish)\b/;

const NOT_OPT_OUT_VOCAB = /\b(subscribe|subscribers?|subscription|newsletters?|mailing list|sign ?up|signup|join (us|our|the)|stay (in touch|connected|updated|informed)|get (updates|offers|deals|the latest)|log ?in|login|sign ?in|signin|password|passcode|search|look ?up|lookup|find (a |your |someone|people|person)|contact us|contact form|get in touch|feedback|check ?out|cart|basket|payment|credit card|billing|coupon|promo code|register|create (an )?account|careers|apply now|support ticket)\b/;

function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname} ${u.search}`;
  } catch (_) {
    return String(url || '');
  }
}

function formSignature(d) {
  return [d.id, d.className, d.name, pathOf(d.action), String(d.text || '').slice(0, 80)].join('|');
}

/**
 * Decide whether a described form may receive the person's details.
 *
 * "Strong" signals are the form's own id/class/name/aria-label, its action path,
 * its legend / heading / dialog title and its button labels. "Weak" signals are
 * its body text and field hints. A newsletter-style word in a strong signal always
 * rejects; in a weak one it rejects unless a strong signal says opt-out. Opt-out
 * wording in the page URL/title only vouches for the sole non-footer form.
 *
 * @param {object} d   result of describeFormElement()
 * @param {{ pageUrl?: string, pageTitle?: string, visibleFormCount?: number,
 *           afterOptOutClick?: boolean, isNewSinceClick?: boolean }} [ctx]
 * @returns {{ eligible: boolean, reason: string }}
 */
function classifyOptOutForm(d, ctx = {}) {
  const reject = (reason) => ({ eligible: false, reason });
  const accept = (reason) => ({ eligible: true, reason });
  if (!d || d.visible === false) return reject('form is not visible');
  if (d.hasPassword) return reject('looks like a login form');
  if (d.hasPayment) return reject('looks like a payment form');

  const strong = vocabText([d.id, d.className, d.name, d.ariaLabel, pathOf(d.action), d.legends, d.heading, d.dialogLabel, ...(d.submitTexts || [])].join(' '));
  const weak = vocabText([d.text, d.fieldHints].join(' '));
  const strongOptOut = OPT_OUT_VOCAB.test(strong);
  const strongNot = NOT_OPT_OUT_VOCAB.exec(strong);
  const weakNot = NOT_OPT_OUT_VOCAB.exec(weak);

  if (strongNot) return reject(`looks like a ${strongNot[0]} form`);
  if (d.hasSearch && !strongOptOut) return reject('looks like a search form');
  if (weakNot && !strongOptOut) return reject(`looks like a ${weakNot[0]} form`);
  if (strongOptOut) return accept('opt-out wording in its heading, action or button');
  if (!d.chrome && OPT_OUT_VOCAB.test(weak)) return accept('opt-out wording in its text');

  const page = vocabText(`${pathOf(ctx.pageUrl)} ${ctx.pageTitle || ''}`);
  if (!d.chrome && ctx.visibleFormCount === 1 && OPT_OUT_VOCAB.test(page)) return accept('the only form on an opt-out page');
  if (!d.chrome && ctx.afterOptOutClick && ctx.isNewSinceClick) return accept('form opened by the Do Not Sell control');
  return reject(d.chrome ? 'footer/header form with no opt-out wording of its own' : 'no opt-out wording');
}

async function describeForms(page) {
  const found = [];
  let forms;
  let count = 0;
  try {
    forms = page.locator('form');
    count = await forms.count();
  } catch (_) {
    return found;
  }
  for (let i = 0; i < Math.min(count, MAX_FORMS); i++) {
    try {
      const locator = forms.nth(i);
      const desc = await locator.evaluate(describeFormElement);
      if (desc && typeof desc === 'object') found.push({ locator, desc });
    } catch (_) {}
  }
  return found;
}

// A registry row for a bare homepage is not a request form. Strategy 3 never
// runs on one; Do Not Sell, consent managers and DSAR links still do.
function isHomepageUrl(url) {
  try {
    const u = new URL(url);
    return ['', '/', '/index.html', '/index.htm', '/index.php', '/home'].includes(u.pathname.toLowerCase()) && !u.search && !u.hash;
  } catch (_) {
    return false;
  }
}

// ─── Generic form filler ──────────────────────────────────────────────────────

/**
 * Resolve the person whose details go into generic opt-out forms.
 *
 * Prefer an explicit person: fillGenericForm() submits a real name, email, state
 * and zip, so "generic" does not mean person-agnostic. Falling back to
 * config.person / persons[0] keeps older call sites (and single-person setups)
 * working unchanged.
 *
 * @param {object} [person] the person the caller is currently processing
 * @returns {{ firstName, lastName, fullName, email, state, zip }}
 */
function activePerson(person) {
  if (person) return person;
  const cfg = getConfig();
  if (cfg.person) return cfg.person;
  if (Array.isArray(cfg.persons) && cfg.persons.length > 0) return cfg.persons[0];
  throw new Error('No person/persons in config.json');
}

/**
 * @param {object} [person]
 * @param {{ submissionEmail?: string }} [opts] submissionEmail is the relay alias.
 *   When set it goes into every email field and person.email is never typed:
 *   the generic pass reaches ~490 sites, which is the largest exposure of the
 *   real address if the relay is skipped here.
 */
function getFieldMap(person, opts = {}) {
  const p = activePerson(person);
  const { firstName: F, lastName: L, fullName: N, state: ST, zip: Z } = p;
  const E = opts.submissionEmail || p.email;
  return [
    // email (try first - many sites only need this)
    { selectors: ['input[type="email"]', 'input[name*="email" i]', 'input[placeholder*="email" i]'], value: E },
    // first name
    { selectors: ['input[name="firstName"]', 'input[name*="first" i]', 'input[placeholder*="first name" i]'], value: F },
    // last name
    { selectors: ['input[name="lastName"]', 'input[name*="last" i]', 'input[placeholder*="last name" i]'], value: L },
    // full name
    { selectors: ['input[name="name"]', 'input[name*="full" i]', 'input[placeholder*="full name" i]', 'input[placeholder*="your name" i]'], value: N },
    // state
    { selectors: ['select[name*="state" i]', 'input[name*="state" i]'], value: ST },
    // zip
    { selectors: ['input[name*="zip" i]', 'input[name*="postal" i]'], value: Z },
    // phone - supplementary: filled only alongside a name or email, never on
    // its own. A lone phone box is usually a reverse-lookup search, and
    // submitting it would be recorded as a removal.
    {
      selectors: ['input[type="tel"]', 'input[name*="phone" i]', 'input[placeholder*="phone" i]'],
      value: p.phoneFormatted || p.phone,
      supplementary: true,
    },
    // request type - select "Delete" or "Do Not Sell" where applicable
    {
      selectors: ['select[name*="request" i]', 'select[name*="type" i]', 'select[id*="request" i]'],
      value: null,  // handled specially below
      special: 'selectDeleteOrOptOut',
    },
  ];
}

/**
 * Fill one form. Every lookup is scoped to `opts.scope` (a <form> locator) so
 * nothing outside it is touched; without a scope it searches the whole page (kept
 * for older callers).
 * @param {object} page
 * @param {object} [person]
 * @param {{ submissionEmail?: string, scope?: object }} [opts]
 * @returns {Promise<boolean>} true if at least one field was filled
 */
async function fillGenericForm(page, person, opts = {}) {
  const root = opts.scope || page;
  let filledAny = false;
  for (const field of getFieldMap(person, opts)) {
    if (field.special === 'selectDeleteOrOptOut') {
      // Try to pick "Delete", "Opt-Out", or "Do Not Sell" from a dropdown
      for (const sel of field.selectors) {
        try {
          const el = root.locator(sel).first();
          if ((await el.count()) > 0) {
            await el.selectOption({ label: /delete|opt.out|do not sell|remove/i }).catch(async () => {
              // If label match fails try by index (usually first substantive option)
              const opts = await el.locator('option').allTextContents();
              const match = opts.findIndex(o => /delete|opt.out|do not sell|remove/i.test(o));
              if (match > 0) await el.selectOption({ index: match });
            });
          }
        } catch(_) {}
      }
      continue;
    }
    // Supplementary fields sit after the primary ones in getFieldMap(), so this
    // only types the phone into a form that already took a name or email.
    if (field.supplementary && (!field.value || !filledAny)) continue;
    if (!field.value) continue;
    for (const sel of field.selectors) {
      try {
        const el = root.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible({ timeout: 300 }))) {
          const tag = await el.evaluate(n => n.tagName.toLowerCase());
          if (tag === 'select') {
            await el.selectOption(field.value).catch(() => {});
          } else {
            await el.fill(field.value);
          }
          filledAny = true;
          break;
        }
      } catch(_) {}
    }
  }
  return filledAny;
}

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit")',
  'button:has-text("Send")',
  'button:has-text("Opt Out")',
  'button:has-text("Delete My Data")',
  'button:has-text("Remove My Data")',
  'button:has-text("Send Request")',
].join(', ');

/**
 * Click the submit control that lives INSIDE `form`.
 * @returns {Promise<{ found: boolean, clicked?: boolean, error?: string }>}
 */
async function clickFormSubmit(form) {
  const btn = form.locator(SUBMIT_SELECTORS).first();
  try {
    if (!((await btn.count()) > 0 && (await btn.isVisible()))) return { found: false };
  } catch (_) {
    return { found: false };
  }
  try {
    await btn.click({ timeout: 5000 });
    return { found: true, clicked: true };
  } catch (err) {
    const message = (err && err.message) || '';
    return { found: true, clicked: false, error: message.includes('Timeout') ? 'Timeout' : message.slice(0, 60) };
  }
}

/**
 * Find the opt-out form on the page, fill it, click ITS submit control, and judge
 * the outcome from the text that appeared. Returns null when no eligible form
 * with a fillable field exists, so the caller can fall through to the next
 * strategy; otherwise a { status, detail } result.
 */
async function submitOptOutForm(page, { person, submissionEmail, checkUrl, formCtx = {}, label }) {
  const found = await describeForms(page);
  if (found.length === 0) return null;

  const pageUrl = typeof page.url === 'function' ? page.url() : '';
  let pageTitle = '';
  try { pageTitle = typeof page.title === 'function' ? await page.title() : ''; } catch (_) {}
  const visibleFormCount = found.filter(f => f.desc.visible && !f.desc.chrome).length;
  const skipped = [];

  for (const { locator, desc } of found) {
    const verdict = classifyOptOutForm(desc, {
      pageUrl,
      pageTitle,
      visibleFormCount,
      afterOptOutClick: !!formCtx.afterOptOutClick,
      isNewSinceClick: formCtx.beforeSigs ? !formCtx.beforeSigs.has(formSignature(desc)) : false,
    });
    if (!verdict.eligible) { skipped.push(verdict.reason); continue; }

    // Never post the person's details to an internal address, whatever the page said.
    if (checkUrl && desc.action) {
      const target = await checkUrl(desc.action);
      if (!target.ok) { skipped.push(`form posts to a blocked address (${target.reason})`); continue; }
    }

    const filled = await fillGenericForm(page, person, { submissionEmail, scope: locator });
    if (!filled) { skipped.push('no fillable field'); continue; }

    const before = await readBodyText(page);
    const click = await clickFormSubmit(locator);
    // A click that never happened is an error, not a result to be inferred: the
    // person's details were typed into a form and nothing was sent.
    if (!click.found) return { status: 'error', detail: 'Form filled but no submit control found - finish this one by hand' };
    if (!click.clicked) return { status: 'error', detail: `Form filled but the submit click failed (${click.error || 'error'})` };
    await page.waitForTimeout(2000);
    return judgeNewText(page, before, label);
  }

  if (skipped.length > 0) process.stdout.write(`(skipped ${skipped.length} form(s): ${skipped[0]}) `);
  return null;
}

// ─── Process one generic URL ──────────────────────────────────────────────────

async function processGenericUrl(page, broker, state, dryRun = false, injectedDeadSet, opts = {}) {
  // The person whose PII gets typed in, and the state key their history lives
  // under. Defaults keep single-person and older call sites identical.
  const person = opts.person;
  const submissionEmail = opts.submissionEmail || undefined;
  const key = opts.stateKey || broker.name;
  // Allowlist: the user explicitly wants to stay listed on this host, so never
  // navigate or submit. Returned before any network request.
  let allowCfg = null;
  try { allowCfg = getConfig(); } catch (_) { allowCfg = null; }
  if (isAllowlisted(broker.name, allowCfg)) {
    return { status: 'allowlisted', detail: 'on allowlist - keeping listing, no opt-out submitted' };
  }

  // WP4: if the entry is in pending-confirmation state, use the shorter 14-day
  // re-check window so the user has a chance to click the confirmation link.
  const entry = state.optOuts[key];
  if (entry) {
    const stamp = entry.lastAttempt || entry.lastSuccess;
    if (stamp) {
      const ageDays = (Date.now() - new Date(stamp).getTime()) / 86400000;
      // Check the canonical pendingConfirm object (set by recordPendingConfirmation).
      // The old pendingConfirmation boolean is intentionally ignored here - it is
      // never written by current code and its presence should not alter behavior.
      if (entry.pendingConfirm && entry.pendingConfirm.since) {
        if (ageDays < CONFIRM_RECHECK_DAYS) {
          return { status: 'skipped', detail: `pending confirm - retry in ${Math.max(0, Math.round(CONFIRM_RECHECK_DAYS - ageDays))}d` };
        }
        // confirmation window elapsed → fall through to re-attempt
      } else if (ageDays < RECHECK_DAYS) {
        return { status: 'skipped', detail: `${Math.round(ageDays)}d ago` };
      }
    }
  }

  // Short-circuit without a network request when the host is known-dead.
  const activeDeadSet = injectedDeadSet !== undefined ? injectedDeadSet : deadSet;
  let hostname;
  try { hostname = new URL(broker.url).hostname.replace(/^www\./, ''); } catch (_) {}
  if (hostname && activeDeadSet.has(hostname)) {
    return { status: 'dead', detail: 'cached dead-url, skipped' };
  }

  // codex #2: never point the browser at (or type PII into) a disallowed target.
  const checkUrl = makeUrlChecker({ lookup: opts.dnsLookup });
  const target = await checkUrl(broker.url);
  if (!target.ok) return { status: 'error', detail: `blocked: ${target.reason}` };

  // Re-check wherever the page actually is: HTTP redirects, meta refresh and JS
  // redirects can all end on a host the registry row never named.
  const guardLanding = async () => {
    const landed = typeof page.url === 'function' ? page.url() : '';
    if (!landed || landed === 'about:blank') return null;
    const verdict = await checkUrl(landed);
    if (verdict.ok) return null;
    try { await page.goto('about:blank'); } catch (_) {}
    return { status: 'error', detail: `blocked: redirected to ${verdict.reason}` };
  };

  try {
    const response = await withRetry(() => page.goto(broker.url, { waitUntil: 'domcontentloaded', timeout: 20000 }));
    if (response && isDeadStatus(response.status())) {
      return { status: 'dead', detail: `HTTP ${response.status()}` };
    }
    const landedBad = await guardLanding();
    if (landedBad) return landedBad;
    await page.waitForTimeout(1500);
    const driftedBad = await guardLanding();
    if (driftedBad) return driftedBad;

    await dismissBanners(page);

    // Dry-run: navigation + banner dismissal are read-only and confirm the URL
    // is reachable, but every strategy below is mutating (clicks a Do Not Sell
    // button or submits a form). Stop here so --dry-run is genuinely safe.
    if (dryRun) {
      return { status: 'skipped', detail: 'dry-run - generic opt-out not submitted' };
    }

    // Strategy 1: click "Do Not Sell" link
    const dnsBaseline = await readBodyText(page);
    let formsBeforeClick = null;
    const clicked = await clickDoNotSell(page, {
      beforeClick: async () => {
        const before = await describeForms(page);
        formsBeforeClick = new Set(before.filter(f => f.desc.visible).map(f => formSignature(f.desc)));
      },
    });
    if (clicked) {
      // Clicking that link is not an opt-out. It usually opens a modal or a
      // follow-up page. This branch used to ignore both return values below and
      // report success unconditionally, which earned a recordSuccess() and a
      // 90-day cooldown for a broker that received nothing.
      const movedBad = await guardLanding();
      if (movedBad) return movedBad;
      const submitted = await submitOptOutForm(page, {
        person, submissionEmail, checkUrl,
        formCtx: { afterOptOutClick: true, beforeSigs: formsBeforeClick },
        label: 'Do Not Sell clicked, form submitted',
      });
      if (submitted) return submitted;
      // The click may still have flipped a preference with no form at all, so a
      // confirmation or success message that APPEARED counts. Otherwise a human
      // has to finish it.
      const shown = await judgeNewText(page, dnsBaseline, 'Do Not Sell clicked');
      if (shown.status === 'pending_confirm' || shown.status === 'success') return shown;
      return { status: 'manual', detail: 'Do Not Sell clicked but nothing was submitted - finish this one by hand' };
    }

    // Strategy 2: OneTrust / TrustArc privacy manager (only a real, visible one)
    const managerBaseline = await readBodyText(page);
    const managed = await handlePrivacyManager(page);
    if (managed) {
      await page.waitForTimeout(1000);
      return judgeNewText(page, managerBaseline, 'Privacy manager saved');
    }

    // Strategy 3: fill the opt-out form. Not for rows the feed classified manual
    // or that point at a bare homepage (codex #3), and only for a form that looks
    // like an opt-out request.
    if (broker.method !== 'manual' && !isHomepageUrl(broker.url)) {
      const submitted = await submitOptOutForm(page, {
        person, submissionEmail, checkUrl,
        formCtx: { afterOptOutClick: false },
        label: 'Form submitted',
      });
      if (submitted) return submitted;
    }

    // Strategy 4: look for a DSAR / privacy request link on privacy policy pages
    const dsarLink = page.locator('a:has-text("Submit a Request"), a:has-text("Privacy Request"), a:has-text("Data Request")').first();
    if ((await dsarLink.count()) > 0) {
      const href = await dsarLink.getAttribute('href');
      return { status: 'manual', detail: href || broker.url };
    }

    return { status: 'manual', detail: broker.url };
  } catch (err) {
    const message = err.message || '';
    const deadCode = classifyNavError(message);
    if (deadCode) {
      return { status: 'dead', detail: deadCode };
    }
    const msg = message.includes('Timeout') ? 'Timeout' : message.slice(0, 60) || 'error';
    return { status: 'error', detail: msg };
  }
}

// ─── Load all generic brokers (deduped against explicit broker list) ──────────

function loadGenericBrokers(explicitBrokerHosts) {
  const brokers = [];
  const seen = new Set(explicitBrokerHosts);

  // The Markup dataset (494 entries)
  if (fs.existsSync(MARKUP_PATH)) {
    const markup = JSON.parse(fs.readFileSync(MARKUP_PATH, 'utf8'));
    for (const row of markup) {
      if (!row.urlFinal || !row.urlFinal.startsWith('http')) continue;
      try {
        const host = new URL(row.urlFinal).hostname.replace(/^www\./, '');
        if (seen.has(host)) continue;
        seen.add(host);
        brokers.push({ name: row.name || host, url: row.urlFinal, source: 'markup' });
      } catch(_) {}
    }
  }

  // BADBOOL extras (27 additional people-search sites)
  if (fs.existsSync(BADBOOL_PATH)) {
    const extra = JSON.parse(fs.readFileSync(BADBOOL_PATH, 'utf8'));
    for (const url of extra) {
      if (!url.startsWith('http')) continue;
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (seen.has(host)) continue;
        seen.add(host);
        brokers.push({ name: host, url, source: 'badbool' });
      } catch(_) {}
    }
  }

  // Live registry feeds (California + Vermont), written by
  // `node watcher.js --update-brokers` to data/feeds-brokers.json. Loaded after
  // Markup/BADBOOL so the Markup dataset stays the fallback and feed entries are
  // deduped against everything already loaded. Each row is the normalized shape
  // { name, optOutUrl, method, source }; the generic runner navigates `url`, so
  // url-less manual rows are skipped here.
  if (fs.existsSync(FEEDS_PATH)) {
    try {
      const feeds = JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
      if (Array.isArray(feeds)) {
        for (const row of feeds) {
          const url = row && row.optOutUrl;
          if (!url || !url.startsWith('http')) continue;
          try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            if (seen.has(host)) continue;
            seen.add(host);
            brokers.push({ name: row.name || host, url, source: row.source || 'feed', method: row.method });
          } catch(_) {}
        }
      }
    } catch(_) {}
  }

  return brokers;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Map a processGenericUrl status to a genericStats outcome bucket key.
 *
 * Outcome buckets (WP5):
 *   submitted        - form found and submitted (success / pending_confirm)
 *   unverified       - submitted but not confirmed; never a success, no cooldown
 *   no_form_found    - page loaded but nothing automatable (manual / dead)
 *   error            - exception during processing
 *   dry-run-skipped  - submit deferred because dryRun=true
 *   skipped-recent   - site visited recently, skipped by recheck window
 */
function classifyOutcome(status, detail) {
  switch (status) {
    case 'success':
    case 'pending_confirm':
      return 'submitted';
    case 'manual':
    case 'dead':
      return 'no_form_found';
    case 'error':
      return 'error';
    case 'unverified':
      return 'unverified';
    case 'allowlisted':
      return 'allowlisted';
    case 'skipped':
      // Distinguish dry-run skips from recently-visited skips via detail text
      if (detail && detail.includes('dry-run')) return 'dry-run-skipped';
      return 'skipped-recent';
    default:
      return 'error';
  }
}

async function runGenericBrokers(context, explicitBrokerHosts, state, logResult, recordSuccess, opts = {}) {
  const dryRun = !!opts.dryRun;
  // Which person this pass is for. fillGenericForm() submits a real name and
  // email, so a household needs one pass per person: previously the pass ran once
  // with persons[0] and keyed state on the bare broker name, which left everyone
  // else unsubmitted while marking the broker done for all of them.
  //
  // Resolve it LAZILY: do not call activePerson() here. That reads config.json,
  // which turns "no config on disk" into a hard failure for every caller that
  // injects its own brokers or process function - CI has no config.json, so an
  // eager read passed locally and broke the Node matrix. getFieldMap(person)
  // already falls back to config.person / persons[0] at the moment a form is
  // actually filled, and stateKey() returns the bare broker name whenever there
  // is no person or only one, so neither path needs config up front.
  const { stateKey } = require('./lib/config');
  const person = opts.person;
  const personCount = opts.personCount || 1;
  const keyFor = (name) => stateKey(name, person, personCount);
  // Allow tests to inject a custom broker list and/or process function.
  const brokers = opts.injectedBrokers !== undefined
    ? opts.injectedBrokers
    : loadGenericBrokers(explicitBrokerHosts);
  const processFn = opts.injectedProcessFn || processGenericUrl;
  // CORE-4: --only / --skip / --retry-failed arrive as one predicate. Excluded
  // brokers are dropped here, before any log line, navigation or state write.
  const include = typeof opts.include === 'function' ? opts.include : () => true;
  const queue = brokers.filter(b => include(b.name));

  console.log(`\n── Generic brokers (${queue.length} from Markup CSV + BADBOOL)${dryRun ? ' [DRY RUN]' : ''} ──`);

  // BRK-12: Playwright's default wait is 30 s per action, so one hidden toggle or
  // missing control stalled a broker for half a minute. Navigations keep their
  // own explicit (longer) timeout in processGenericUrl.
  const newWorkingPage = async () => {
    const fresh = await context.newPage();
    if (typeof fresh.setDefaultTimeout === 'function') fresh.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return fresh;
  };

  let page = await newWorkingPage();

  const stats = {
    attempted: 0,
    submitted: 0,
    no_form_found: 0,
    unverified: 0,
    error: 0,
    'dry-run-skipped': 0,
    'skipped-recent': 0,
    dead: 0,
  };

  // Broker sites frequently spawn popups / _blank tabs / consent / OAuth windows.
  // Those open as extra pages in the persistent context and are never closed, so
  // their renderer processes accumulate across the ~500-site list and can exhaust
  // the host (observed: ~1200 stray Chromium processes on a full run). Close any
  // page that isn't our working page after each broker.
  const prunePopups = async () => {
    if (typeof context.pages !== 'function') return; // tolerate minimal/mock contexts
    for (const p of context.pages()) {
      if (p !== page) { try { await p.close(); } catch (_) {} }
    }
  };

  const RECYCLE_EVERY = 25; // periodically replace the working page to bound renderer growth
  let processed = 0;

  try {
    for (const broker of queue) {
      process.stdout.write(`\n  [${broker.name.slice(0,40)}]… `);

      let result;
      try {
        result = await processFn(page, broker, state, dryRun, opts.injectedDeadSet, { person, stateKey: keyFor(broker.name), submissionEmail: opts.submissionEmail || undefined, dnsLookup: opts.dnsLookup });
      } catch (err) {
        // One broker must never abort the whole run or skip the cleanup below.
        result = { status: 'error', detail: (err && err.message ? err.message.slice(0, 80) : 'error') };
        // If the working page itself crashed, replace it so the run can continue.
        if (typeof page.isClosed === 'function' && page.isClosed()) {
          try { page = await newWorkingPage(); } catch (_) {}
        }
      }

      logResult(broker.name, result.status, result.detail || '');

      stats.attempted++;
      const bucket = classifyOutcome(result.status, result.detail || '');
      // dead is stored separately; re-map no_form_found subdivisions
      if (result.status === 'dead') {
        stats.dead++;
      } else {
        stats[bucket] = (stats[bucket] || 0) + 1;
      }

      // All three record under the per-person key so one household member's
      // success never suppresses another's submission.
      const recordKey = keyFor(broker.name);
      if (result.status === 'success') {
        recordSuccess(recordKey, result.detail || '');
      } else if (result.status === 'pending_confirm') {
        const { recordPendingConfirmation } = require('./lib/config');
        recordPendingConfirmation(recordKey, result.detail || '');
      } else if (result.status === 'error' || result.status === 'dead') {
        const { recordFailure } = require('./lib/config');
        // B24: record the real status so defunct/drift can tell a gone site
        // ('dead') from a transient error, rather than collapsing both to 'error'.
        recordFailure(recordKey, result.status === 'dead' ? 'dead' : 'error');
      }

      await prunePopups(); // reap any popups / tabs this broker opened

      // Recycle the working page every N brokers to release accumulated
      // renderer / site-isolation processes that survive same-page navigation.
      if (++processed % RECYCLE_EVERY === 0) {
        try { await page.close(); } catch (_) {}
        page = await newWorkingPage();
      }

      try { await page.waitForTimeout(400); } catch (_) {} // polite delay
    }
  } finally {
    await page.close().catch(() => {});
    await prunePopups();
  }

  return {
    count: queue.length,
    genericStats: {
      attempted: stats.attempted,
      submitted: stats.submitted,
      no_form_found: stats.no_form_found,
      unverified: stats.unverified,
      error: stats.error,
      'dry-run-skipped': stats['dry-run-skipped'],
      'skipped-recent': stats['skipped-recent'],
      dead: stats.dead,
      allowlisted: stats.allowlisted || 0,
    },
  };
}

module.exports = { runGenericBrokers, loadGenericBrokers, processGenericUrl, classifyNavError, classifyOutcome, isDeadStatus, loadDeadSet, DEAD_URLS_PATH, _setConfig, getFieldMap, fillGenericForm, checkBrokerUrl, isDisallowedAddress, newTextSince, classifyOptOutForm, describeFormElement, isHomepageUrl };
