#!/usr/bin/env node
/**
 * auto-identity-remove — watcher.js
 *
 * Automated data broker opt-out runner.
 * Reads config.json (your personal info) and state.json (opt-out history).
 *
 * Per broker:
 *   1. Skips if successfully opted out within the re-check window (90 days)
 *   2. Finds your listing URL (for search-form brokers)
 *   3. Fills and submits the opt-out form
 *   4. Solves CAPTCHAs via CapSolver if configured
 *   5. Logs result to state.json and logs/
 *   6. Sends iMessage summary + opens manual-required sites in browser
 *
 * Run: node watcher.js
 * Schedule: set up via `node setup.js`
 */

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execSync } = require('child_process');

// ─── Config & state ───────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH  = path.join(__dirname, 'state.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ config.json not found. Run `node setup.js` first.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { person, capsolver, notify, profileDir } = config;

// state.json tracks opt-out history so completed opt-outs aren't re-submitted
// every single run (brokers re-add data every ~90 days, so we re-check then).
let state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { optOuts: {} };

const RECHECK_DAYS = 90; // how often to re-submit to a broker

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function lastOptOutDaysAgo(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry?.lastSuccess) return Infinity;
  return (Date.now() - new Date(entry.lastSuccess).getTime()) / (1000 * 60 * 60 * 24);
}

function recordSuccess(brokerName, detail = '') {
  state.optOuts[brokerName] = {
    lastSuccess: new Date().toISOString(),
    totalRuns: ((state.optOuts[brokerName]?.totalRuns) || 0) + 1,
    detail,
  };
  saveState();
}

// ─── Playwright ───────────────────────────────────────────────────────────────

// Try local node_modules first, then fall back to global openclaw install
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
  ({ chromium } = require(fallback));
}

if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `run-${new Date().toISOString().slice(0, 10)}.json`);

const results = {
  runAt: new Date().toISOString(),
  succeeded: [],
  skipped: [],
  notFound: [],
  captchaFailed: [],
  manual: [],
  errors: [],
};

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌' };

function logResult(broker, status, detail = '') {
  const entry = { broker, status, detail, time: new Date().toLocaleTimeString() };
  const bucket = {
    success:       'succeeded',
    skipped:       'skipped',
    notFound:      'notFound',
    captcha_failed:'captchaFailed',
    manual:        'manual',
    error:         'errors',
  }[status] || 'errors';
  results[bucket].push(entry);
  console.log(`${ICONS[status] || '?'} [${broker}] ${status}${detail ? ' — ' + detail : ''}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

function sendText(message) {
  if (!notify?.textTo) return;
  const s = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Messages"\nset sv to first service whose service type = iMessage\nset b to buddy "${s(notify.textTo)}" of sv\nsend "${s(message)}" to b\nend tell`;
  try { execSync(`osascript << 'OSASCRIPT'\n${script}\nOSASCRIPT`); } catch(_) {}
}

function macNotify(title, message) {
  try {
    const s = t => t.replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${s(message)}" with title "${s(title)}"'`);
  } catch(_) {}
}

function openInBrowser(urls) {
  for (const url of urls) {
    try { execSync(`open "${url}"`); } catch(_) {}
    execSync('sleep 0.4');
  }
}

// ─── CapSolver CAPTCHA solving ────────────────────────────────────────────────

async function solveRecaptcha(page) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     ℹ  No CapSolver key — add one to config.json to auto-solve CAPTCHAs');
    return false;
  }

  try {
    const axios  = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() =>
      document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null
    );
    if (!siteKey) return false;

    console.log('     🔑 Solving CAPTCHA via CapSolver…');

    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'ReCaptchaV2TaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse;
        await page.evaluate(t => {
          const el = document.querySelector('#g-recaptcha-response');
          if (el) el.value = t;
          try { window.___grecaptcha_cfg.clients[0].aa.l.callback(t); } catch(_) {}
        }, token);
        console.log('     ✓ CAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     ⚠  CapSolver: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function detectAndSolveCaptcha(page) {
  const hasCaptcha = await page.evaluate(() => !!(
    document.querySelector('.g-recaptcha,[data-sitekey],#recaptcha,iframe[src*="recaptcha"]') ||
    document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]')
  ));
  if (!hasCaptcha) return true;
  return solveRecaptcha(page);
}

// ─── Smart form filler ────────────────────────────────────────────────────────

async function fillForm(page, formFields) {
  for (const [selector, value] of Object.entries(formFields)) {
    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          if (tag === 'select') {
            await el.selectOption({ label: value }).catch(() => el.selectOption(value));
          } else if (type === 'checkbox' || type === 'radio') {
            await el.check();
          } else {
            await el.fill(value);
          }
          filled = true;
          break;
        }
      } catch(_) {}
    }
    if (!filled) {
      const kw = selector.match(/\*="([^"]+)"/)?.[1];
      if (kw) {
        await page.getByLabel(new RegExp(kw, 'i')).first().fill(value).catch(() => {});
      }
    }
  }
}

// ─── Find your specific listing URL ──────────────────────────────────────────

async function findListingUrl(page, broker) {
  await page.goto(broker.searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(2000);
  const links = await page.evaluate(src => {
    const re = new RegExp(src);
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => re.test(h));
  }, broker.listingPattern.source);
  return links[0] || null;
}

// ─── Process one broker ───────────────────────────────────────────────────────

async function processBroker(context, broker) {
  const daysAgo = lastOptOutDaysAgo(broker.name);

  // Skip if recently opted out and still within the re-check window
  if (daysAgo < RECHECK_DAYS) {
    const daysLeft = Math.round(RECHECK_DAYS - daysAgo);
    logResult(broker.name, 'skipped', `Last removed ${Math.round(daysAgo)}d ago — re-check in ${daysLeft}d`);
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

    // Step 2: navigate to opt-out page
    await page.goto(broker.optOutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1500);

    // Inject listing URL into any "profile URL" field
    if (listingUrl) {
      const urlSel = 'input[name*="url" i],input[placeholder*="url" i],input[placeholder*="link" i],input[name*="link" i]';
      await page.locator(urlSel).first().fill(listingUrl).catch(() => {});
    }

    // Step 3: fill personal info
    if (broker.formFields) {
      await fillForm(page, broker.formFields);
      await sleep(500);
    }

    // Step 4: solve CAPTCHA if needed
    if (broker.captchaLikely) {
      const solved = await detectAndSolveCaptcha(page);
      if (!solved) {
        logResult(broker.name, 'captcha_failed', broker.optOutUrl);
        await page.close();
        return;
      }
    }

    // Step 5: submit
    if (broker.submitSelector) {
      const btn = page.locator(broker.submitSelector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
        await sleep(2000);
      }
    }

    // Step 6: record
    logResult(broker.name, 'success');
    recordSuccess(broker.name);

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : err.message?.slice(0, 80) || 'unknown';
    logResult(broker.name, 'error', msg);
  } finally {
    await page.close().catch(() => {});
    await sleep(700);
  }
}

// ─── Email opt-outs ───────────────────────────────────────────────────────────

function sendEmailOptOuts(brokers) {
  const emailBrokers = brokers.filter(b => b.method === 'email');
  for (const broker of emailBrokers) {
    if (lastOptOutDaysAgo(broker.name) < RECHECK_DAYS) {
      logResult(broker.name, 'skipped', 'Email already sent recently');
      continue;
    }
    const body = [
      `To Whom It May Concern,`,
      ``,
      `I am requesting the removal of all records associated with my personal information`,
      `from your database, under CCPA and applicable privacy laws.`,
      ``,
      `Name: ${person.fullName}`,
      `Location: ${person.city}, ${person.state} ${person.zip}`,
      `Email: ${person.email}`,
      `Phone: ${person.phoneFormatted}`,
      ``,
      `Please remove all profiles, records, and personally identifiable information`,
      `and confirm removal within 30 days.`,
      ``,
      `Thank you,`,
      `${person.fullName}`,
    ].join('\\n');

    const script = `
tell application "Mail"
  set m to make new outgoing message with properties {subject:"Personal Data Removal Request – ${person.fullName}",content:"${body}",visible:false}
  tell m
    make new to recipient at end of to recipients with properties {address:"${broker.emailTo}"}
  end tell
  send m
end tell`;
    try {
      execSync(`osascript -e '${script}'`);
      logResult(broker.name, 'success', `Email → ${broker.emailTo}`);
      recordSuccess(broker.name, `email to ${broker.emailTo}`);
    } catch(err) {
      logResult(broker.name, 'error', `Email failed: ${err.message.slice(0, 60)}`);
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function buildSummary() {
  const manualNeeded = [...results.captchaFailed, ...results.manual];
  return [
    `🔒 Privacy Watcher — ${new Date().toLocaleDateString()}`,
    ``,
    `✅ Removed:          ${results.succeeded.length}`,
    `⏭  Skipped (fresh):  ${results.skipped.length}`,
    `🔍 Not listed:       ${results.notFound.length}`,
    `📋 Manual needed:    ${manualNeeded.length}`,
    `❌ Errors:           ${results.errors.length}`,
    manualNeeded.length > 0
      ? [``, `── Action Required ──────────────────────────────`, ...manualNeeded.map(r => `  • ${r.broker}${r.detail ? '\n    ' + r.detail : ''}`)].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function main() {
  const brokers = require('./brokers');

  const { runGenericBrokers } = require('./generic-runner');

  console.log('\n🔒 auto-identity-remove — starting run');
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log(`📋 ${brokers.length} explicit brokers + 500+ generic | re-check window: ${RECHECK_DAYS} days\n`);

  // Email opt-outs (no browser needed)
  console.log('── Email opt-outs ─────────────────────────────────────────');
  sendEmailOptOuts(brokers);

  // Launch persistent browser (reuses profile / saved logins)
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const sorted = [...brokers]
    .filter(b => b.method !== 'email')
    .sort((a, b) => (a.priority || 9) - (b.priority || 9));

  console.log('\n── Explicit broker opt-outs ───────────────────────────────');
  for (const broker of sorted) {
    process.stdout.write(`\n[${stamp()}] ${broker.name}… `);
    await processBroker(context, broker);
  }

  // Build the set of explicit broker hostnames so generic-runner can skip them
  const explicitHosts = new Set(
    brokers.map(b => {
      try {
        return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, '');
      } catch(_) { return ''; }
    }).filter(Boolean)
  );

  await runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess);

  await context.close().catch(() => {});

  // Save run log
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));

  // Open manual-required sites
  const manualUrls = [...results.captchaFailed, ...results.manual]
    .map(r => r.detail || '')
    .filter(u => u.startsWith('http'));
  if (manualUrls.length > 0) {
    console.log(`\n🖥  Opening ${manualUrls.length} manual site(s) in browser…`);
    openInBrowser(manualUrls);
  }

  // Print summary
  const summary = buildSummary();
  console.log('\n' + '═'.repeat(54));
  console.log(summary);
  console.log('═'.repeat(54));
  console.log(`\n📄 Log: ${logFile}`);
  console.log(`💾 State: ${STATE_PATH}\n`);

  // iMessage
  const totalProcessed = results.succeeded.length + results.skipped.length + results.notFound.length + results.captchaFailed.length + results.manual.length + results.errors.length;
  const short = `🔒 Privacy Watcher (${new Date().toLocaleDateString()}):\n✅ Removed: ${results.succeeded.length}\n⏭  Skipped: ${results.skipped.length}\n📋 Manual: ${results.captchaFailed.length + results.manual.length}\n📊 Total: ${totalProcessed} brokers checked`;
  sendText(short);
  macNotify('Privacy Watcher', `Done — ${results.succeeded.length} removed, ${results.captchaFailed.length + results.manual.length} need manual action (${totalProcessed} total)`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  sendText(`❌ Privacy Watcher crashed: ${err.message.slice(0, 100)}`);
  process.exit(1);
});
