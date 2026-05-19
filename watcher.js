#!/usr/bin/env node
/**
 * auto-identity-remove — watcher.js (thin orchestrator)
 *
 * Automated data broker opt-out runner. Internals live in lib/ (config,
 * logger, notify, captcha, forms, broker-runner, platform).
 * Run: node watcher.js   (add --dry-run to fill forms without submitting)
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { STATE_PATH, RECHECK_DAYS, loadConfig, loadState, recordSuccess, setDryRun } = require('./lib/config');
const { results, logResult, buildSummary } = require('./lib/logger');
const { sendText, desktopNotify, openInBrowser } = require('./lib/notify');
const brokerRunner = require('./lib/broker-runner');
const { sendOptOutEmails } = require('./lib/email');
const lock = require('./lib/lock');

const PREVIEW           = process.argv.includes('--preview');
const DRY_RUN           = process.argv.includes('--dry-run') || PREVIEW; // --preview implies --dry-run
const VERIFY            = process.argv.includes('--verify');
const INSTALL_SCHEDULER = process.argv.includes('--install-scheduler');

// --pollute N: submit N fake records to brokers tagged acceptsBogus: true
const polluteFlagIdx = process.argv.indexOf('--pollute');
const POLLUTE_COUNT  = polluteFlagIdx !== -1
  ? Math.max(0, parseInt(process.argv[polluteFlagIdx + 1], 10) || 0)
  : 0;

setDryRun(DRY_RUN); // makes recordSuccess/saveState no-op-on-disk in dry-run

// ── --install-scheduler: register with OS scheduler and exit ─────────────────
if (INSTALL_SCHEDULER) {
  const { installScheduleForPlatform } = require('./lib/scheduler');
  const { getPlatform } = require('./lib/platform');
  const scriptPath = path.join(__dirname, 'run.sh');
  const logDir     = path.join(__dirname, 'logs');
  const platform   = getPlatform();
  const result     = installScheduleForPlatform({ platform, scriptPath, logDir });
  console.log(`\nScheduler installed via ${result.method}:`);
  console.log(`  ${result.detail}\n`);
  process.exit(0);
}

const config = loadConfig();
const { notify } = config;
const profileDir = (config.profileDir || '~/.config/auto-identity-remove')
  .replace(/^~(?=\/|$)/, os.homedir());
const state = loadState();
brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: config.person, capsolver: config.capsolver });

// Try local node_modules first, then fall back to global openclaw install
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
  ({ chromium } = require(fallback));
}

const isMac = process.platform === 'darwin';

if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = isMac
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
}

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `run-${new Date().toISOString().slice(0, 10)}.json`);
const stamp = () => new Date().toLocaleTimeString();

const LOCK_PATH = STATE_PATH + '.lock';

async function main() {
  // Acquire process lock to prevent concurrent runs racing on state.json
  try {
    lock.acquire(LOCK_PATH);
  } catch (err) {
    const pidMatch = err.message.match(/pid (\d+)/);
    const pid = pidMatch ? pidMatch[1] : '?';
    console.error(`Another instance is running, pid=${pid}. Exiting.`);
    process.exit(1);
  }

  try {
    return await _mainBody();
  } finally {
    lock.release(LOCK_PATH);
  }
}

async function _mainBody() {
  const brokers = require('./brokers');
  const { runGenericBrokers } = require('./generic-runner');

  console.log('\n🔒 auto-identity-remove — starting run');
  if (PREVIEW)       console.log('👀 PREVIEW — field values and target URLs will be printed before submit. No state will be saved.');
  else if (DRY_RUN)  console.log('🧪 DRY RUN — forms will be filled but NOT submitted. No state will be saved.');
  if (VERIFY)        console.log('🔍 VERIFY — read-only spot-check. No forms submitted. No state saved.');
  if (POLLUTE_COUNT) console.log(`⚠️  NOISE MODE — ${POLLUTE_COUNT} bogus record(s) will be submitted to acceptsBogus brokers.`);
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log(`📋 ${brokers.length} explicit brokers + 500+ generic | re-check window: ${RECHECK_DAYS} days\n`);

  // Email opt-outs (no browser needed — skipped in verify mode)
  if (!VERIFY) {
    console.log('── Email opt-outs ─────────────────────────────────────────');
    await sendOptOutEmails(brokers, config);
  }

  // Launch persistent browser (reuses profile / saved logins)
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // ── Verify mode: read-only spot-check, no opt-out submission ─────────────
  if (VERIFY) {
    const { runVerify } = require('./lib/verifier');
    await runVerify(context, brokers, state);
    await context.close().catch(() => {});
    return;
  }

  const sorted = [...brokers]
    .filter(b => b.method !== 'email')
    .sort((a, b) => (a.priority || 9) - (b.priority || 9));

  console.log('\n── Explicit broker opt-outs ───────────────────────────────');
  for (const broker of sorted) {
    process.stdout.write(`\n[${stamp()}] ${broker.name}… `);
    await brokerRunner.processBroker(context, broker);
  }

  // Build the set of explicit broker hostnames so generic-runner can skip them
  const explicitHosts = new Set(
    brokers.map(b => {
      try {
        return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, '');
      } catch(_) { return ''; }
    }).filter(Boolean)
  );

  // generic-runner.js returns { count, genericStats }; store stats so they
  // appear in the summary and in the run-log JSON.
  const genericResult = await runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, { dryRun: DRY_RUN });
  if (genericResult && genericResult.genericStats) {
    results.genericStats = genericResult.genericStats;
  }

  // ── Noise / pollution mode (--pollute N) ──────────────────────────────────
  // Submits N randomly-generated fake records to brokers tagged acceptsBogus.
  // Off by default (POLLUTE_COUNT === 0). See README for ToS warning.
  if (POLLUTE_COUNT > 0) {
    const { generateBogusPerson } = require('./lib/noise');
    const bogBrokers = brokers.filter(b => b.acceptsBogus === true);

    if (bogBrokers.length === 0) {
      console.log('\n⚠️  --pollute: no brokers tagged acceptsBogus: true — nothing to do.');
    } else {
      console.log(`\n── Noise mode — submitting ${POLLUTE_COUNT} bogus record(s) to ${bogBrokers.length} broker(s) ─`);
      for (let i = 0; i < POLLUTE_COUNT; i++) {
        const fakePerson = generateBogusPerson();
        console.log(`\n   [bogus ${i + 1}/${POLLUTE_COUNT}] ${fakePerson.firstName} ${fakePerson.lastName} (${fakePerson.city}, ${fakePerson.state})`);
        for (const broker of bogBrokers) {
          process.stdout.write(`     ${broker.name}… `);
          await brokerRunner.processBrokerWithPerson(context, broker, fakePerson);
        }
      }
    }
  }

  await context.close().catch(() => {});

  // Save run log (skipped in dry-run)
  if (!DRY_RUN) fs.writeFileSync(logFile, JSON.stringify(results, null, 2));

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
  sendText(short, notify);
  desktopNotify('Privacy Watcher', `Done — ${results.succeeded.length} removed, ${results.captchaFailed.length + results.manual.length} need manual action (${totalProcessed} total)`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  sendText(`❌ Privacy Watcher crashed: ${err.message.slice(0, 100)}`, notify);
  process.exit(1);
});
