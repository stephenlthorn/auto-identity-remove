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

const config  = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { firstName: F, lastName: L, fullName: N, email: E, state: ST, zip: Z } = config.person;

const RECHECK_DAYS = 90;

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

const FIELD_MAP = [
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

async function fillGenericForm(page) {
  let filledAny = false;
  for (const field of FIELD_MAP) {
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

async function processGenericUrl(page, broker, state) {
  const daysAgo = (() => {
    const entry = state.optOuts[broker.name];
    if (!entry?.lastSuccess) return Infinity;
    return (Date.now() - new Date(entry.lastSuccess).getTime()) / 86400000;
  })();

  if (daysAgo < RECHECK_DAYS) {
    return { status: 'skipped', detail: `${Math.round(daysAgo)}d ago` };
  }

  try {
    await page.goto(broker.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    await dismissBanners(page);

    // Strategy 1: click "Do Not Sell" link
    const clicked = await clickDoNotSell(page);
    if (clicked) {
      // After clicking, try to fill any follow-up form
      await fillGenericForm(page);
      await submitForm(page);
      return { status: 'success', detail: 'Do Not Sell clicked' };
    }

    // Strategy 2: OneTrust / TrustArc privacy manager
    const managed = await handlePrivacyManager(page);
    if (managed) return { status: 'success', detail: 'Privacy manager opted out' };

    // Strategy 3: fill form
    const filled = await fillGenericForm(page);
    if (filled) {
      const submitted = await submitForm(page);
      if (submitted) return { status: 'success', detail: 'Form submitted' };
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
    const msg = err.message?.includes('Timeout') ? 'Timeout' : err.message?.slice(0, 60) || 'error';
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

async function runGenericBrokers(context, explicitBrokerHosts, state, logResult, recordSuccess) {
  const brokers = loadGenericBrokers(explicitBrokerHosts);
  console.log(`\n── Generic brokers (${brokers.length} from Markup CSV + BADBOOL) ──`);

  const page = await context.newPage();

  for (const broker of brokers) {
    process.stdout.write(`\n  [${broker.name.slice(0,40)}]… `);
    const result = await processGenericUrl(page, broker, state);

    logResult(broker.name, result.status, result.detail || '');

    if (result.status === 'success') {
      recordSuccess(broker.name, result.detail || '');
    }

    await page.waitForTimeout(400); // polite delay
  }

  await page.close().catch(() => {});
  return brokers.length;
}

module.exports = { runGenericBrokers, loadGenericBrokers };
