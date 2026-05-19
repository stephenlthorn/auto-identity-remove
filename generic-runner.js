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

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const CONFIG_PATH     = path.join(__dirname, 'config.json');
const STATE_PATH      = path.join(__dirname, 'state.json');
const MARKUP_PATH     = path.join(__dirname, 'data', 'markup-parsed.json');
const BADBOOL_PATH    = path.join(__dirname, 'data', 'badbool-extra.json');
const DEAD_URLS_PATH  = path.join(__dirname, 'data', 'dead-urls.json');

const { detectConfirmationRequired } = require('./lib/confirm');
const { CONFIRM_RECHECK_DAYS } = require('./lib/config');
const { withRetry } = require('./lib/retry');

// Config is loaded lazily so that modules importing only the pure helpers
// (classifyNavError, isDeadStatus, loadDeadSet) don't require config.json.
let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return _config;
}

const RECHECK_DAYS = 90;

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
 * @param {number} code
 * @returns {boolean}
 */
function isDeadStatus(code) {
  return code >= 400;
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

async function clickDoNotSell(page) {
  for (const sel of DNS_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible({ timeout: 500 }))) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(1500);
        return true;
      }
    } catch(_) {}
  }
  return false;
}

// ─── OneTrust / TrustArc / Osano preference opt-out ─────────────────────────

async function handlePrivacyManager(page) {
  // OneTrust toggle — turn off all non-essential categories
  const toggles = await page.locator('.ot-tgl input[type="checkbox"]:checked').all();
  for (const t of toggles) {
    try { await t.click(); } catch(_) {}
  }
  // Confirm / save
  const saveBtn = page.locator(
    '#accept-recommended-btn-handler, .save-preference-btn-handler, button:has-text("Confirm"), button:has-text("Save")'
  ).first();
  if ((await saveBtn.count()) > 0) {
    await saveBtn.click().catch(() => {});
    return true;
  }
  // TrustArc — "Required Only" button
  const reqOnly = page.locator('button:has-text("Required Only"), button:has-text("Reject All")').first();
  if ((await reqOnly.count()) > 0) {
    await reqOnly.click().catch(() => {});
    return true;
  }
  return false;
}

// ─── Generic form filler ──────────────────────────────────────────────────────

function getFieldMap() {
  const { firstName: F, lastName: L, fullName: N, email: E, state: ST, zip: Z } = getConfig().person;
  return [
    // email (try first — many sites only need this)
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
    // request type — select "Delete" or "Do Not Sell" where applicable
    {
      selectors: ['select[name*="request" i]', 'select[name*="type" i]', 'select[id*="request" i]'],
      value: null,  // handled specially below
      special: 'selectDeleteOrOptOut',
    },
  ];
}

async function fillGenericForm(page) {
  let filledAny = false;
  for (const field of getFieldMap()) {
    if (field.special === 'selectDeleteOrOptOut') {
      // Try to pick "Delete", "Opt-Out", or "Do Not Sell" from a dropdown
      for (const sel of field.selectors) {
        try {
          const el = page.locator(sel).first();
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
    for (const sel of field.selectors) {
      try {
        const el = page.locator(sel).first();
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

async function submitForm(page) {
  const submitSel = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Send")',
    'button:has-text("Opt Out")',
    'button:has-text("Delete My Data")',
    'button:has-text("Remove My Data")',
    'button:has-text("Send Request")',
  ].join(', ');
  try {
    const btn = page.locator(submitSel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible({ timeout: 1000 }))) {
      await btn.click();
      await page.waitForTimeout(2000);
      return true;
    }
  } catch(_) {}
  return false;
}

// ─── Process one generic URL ──────────────────────────────────────────────────

async function processGenericUrl(page, broker, state, dryRun = false, injectedDeadSet) {
  // WP4: if the entry is in pending-confirmation state, use the shorter 14-day
  // re-check window so the user has a chance to click the confirmation link.
  const entry = state.optOuts[broker.name];
  if (entry) {
    const stamp = entry.lastAttempt || entry.lastSuccess;
    if (stamp) {
      const ageDays = (Date.now() - new Date(stamp).getTime()) / 86400000;
      if (entry.pendingConfirmation) {
        if (ageDays < CONFIRM_RECHECK_DAYS) {
          return { status: 'skipped', detail: `pending confirm — retry in ${Math.max(0, Math.round(CONFIRM_RECHECK_DAYS - ageDays))}d` };
        }
        // window elapsed → fall through to re-attempt
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

  try {
    const response = await withRetry(() => page.goto(broker.url, { waitUntil: 'domcontentloaded', timeout: 20000 }));
    if (response && isDeadStatus(response.status())) {
      return { status: 'dead', detail: `HTTP ${response.status()}` };
    }
    await page.waitForTimeout(1500);

    await dismissBanners(page);

    // Dry-run: navigation + banner dismissal are read-only and confirm the URL
    // is reachable, but every strategy below is mutating (clicks a Do Not Sell
    // button or submits a form). Stop here so --dry-run is genuinely safe.
    if (dryRun) {
      return { status: 'skipped', detail: 'dry-run — generic opt-out not submitted' };
    }

    // Helper: convert a "success" result into "pending_confirm" if the
    // resulting page asks the user to confirm via email (WP4).
    const finalize = async (detail) => {
      const c = await detectConfirmationRequired(page);
      if (c.pending) return { status: 'pending_confirm', detail: c.snippet || detail };
      return { status: 'success', detail };
    };

    // Strategy 1: click "Do Not Sell" link
    const clicked = await clickDoNotSell(page);
    if (clicked) {
      // After clicking, try to fill any follow-up form
      await fillGenericForm(page);
      await submitForm(page);
      return finalize('Do Not Sell clicked');
    }

    // Strategy 2: OneTrust / TrustArc privacy manager
    const managed = await handlePrivacyManager(page);
    if (managed) return finalize('Privacy manager opted out');

    // Strategy 3: fill form
    const filled = await fillGenericForm(page);
    if (filled) {
      const submitted = await submitForm(page);
      if (submitted) return finalize('Form submitted');
      // Filled but no submit button found — still counts as partial
      return { status: 'success', detail: 'Form filled (no submit button found)' };
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

  return brokers;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Map a processGenericUrl status to a genericStats outcome bucket key.
 *
 * Outcome buckets (WP5):
 *   submitted        — form found and submitted (success / pending_confirm)
 *   no_form_found    — page loaded but nothing automatable (manual / dead)
 *   error            — exception during processing
 *   dry-run-skipped  — submit deferred because dryRun=true
 *   skipped-recent   — site visited recently, skipped by recheck window
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
  // Allow tests to inject a custom broker list and/or process function.
  const brokers = opts.injectedBrokers !== undefined
    ? opts.injectedBrokers
    : loadGenericBrokers(explicitBrokerHosts);
  const processFn = opts.injectedProcessFn || processGenericUrl;

  console.log(`\n── Generic brokers (${brokers.length} from Markup CSV + BADBOOL)${dryRun ? ' [DRY RUN]' : ''} ──`);

  const page = await context.newPage();

  const stats = {
    attempted: 0,
    submitted: 0,
    no_form_found: 0,
    error: 0,
    'dry-run-skipped': 0,
    'skipped-recent': 0,
    dead: 0,
  };

  for (const broker of brokers) {
    process.stdout.write(`\n  [${broker.name.slice(0,40)}]… `);
    const result = await processFn(page, broker, state, dryRun);

    logResult(broker.name, result.status, result.detail || '');

    stats.attempted++;
    const bucket = classifyOutcome(result.status, result.detail || '');
    // dead is stored separately; re-map no_form_found subdivisions
    if (result.status === 'dead') {
      stats.dead++;
    } else {
      stats[bucket] = (stats[bucket] || 0) + 1;
    }

    if (result.status === 'success') {
      recordSuccess(broker.name, result.detail || '');
    } else if (result.status === 'pending_confirm') {
      const { recordPendingConfirmation } = require('./lib/config');
      recordPendingConfirmation(broker.name, result.detail || '');
    }

    await page.waitForTimeout(400); // polite delay
  }

  await page.close().catch(() => {});

  return {
    count: brokers.length,
    genericStats: {
      attempted: stats.attempted,
      submitted: stats.submitted,
      no_form_found: stats.no_form_found,
      error: stats.error,
      'dry-run-skipped': stats['dry-run-skipped'],
      'skipped-recent': stats['skipped-recent'],
      dead: stats.dead,
    },
  };
}

module.exports = { runGenericBrokers, loadGenericBrokers, classifyNavError, classifyOutcome, isDeadStatus, loadDeadSet, DEAD_URLS_PATH };
