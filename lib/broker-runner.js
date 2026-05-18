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

const { execSync } = require('child_process');

const { RECHECK_DAYS, lastOptOutDaysAgo, recordSuccess } = require('./config');
const { logResult } = require('./logger');
const { fillForm, findListingUrl } = require('./forms');
const { detectAndSolveCaptcha } = require('./captcha');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let opts = { dryRun: false, person: null, capsolver: null };

function configure(o) {
  opts = { ...opts, ...o };
}

async function processBroker(context, broker) {
  const daysAgo = lastOptOutDaysAgo(broker.name);

  // Skip if recently opted out and still within the re-check window
  if (daysAgo < RECHECK_DAYS) {
    const daysLeft = Math.round(RECHECK_DAYS - daysAgo);
    logResult(broker.name, 'skipped', `Last removed ${Math.round(daysAgo)}d ago — re-check in ${daysLeft}d`);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && (opts.person?.country || 'US') !== 'US') {
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

    // Step 2: navigate to opt-out page
    await page.goto(broker.optOutUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1500);

    // Inject listing URL into any "profile URL" field
    if (listingUrl) {
      const urlSel = 'input[name*="url" i],input[placeholder*="url" i],input[placeholder*="link" i],input[name*="link" i]';
      await page.locator(urlSel).first().fill(listingUrl).catch(() => {});
    }

    // Step 3: fill personal info (pass person so intl province/postal aliases fire)
    if (broker.formFields) {
      await fillForm(page, broker.formFields, opts.person);
      await sleep(500);
    }

    // Step 4: solve CAPTCHA if needed
    if (broker.captchaLikely) {
      const solved = await detectAndSolveCaptcha(page, opts.capsolver);
      if (!solved) {
        logResult(broker.name, 'captcha_failed', broker.optOutUrl);
        await page.close();
        return;
      }
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

function sendEmailOptOuts(brokers) {
  const person = opts.person;
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

module.exports = { configure, processBroker, sendEmailOptOuts };
