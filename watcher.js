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

const { STATE_PATH, RECHECK_DAYS, loadConfig, loadState, recordSuccess, setDryRun, getPersonsFromConfig, loadCheckpoint, clearCheckpoint } = require('./lib/config');
const { results, logResult, buildSummary, setDefunctBrokers } = require('./lib/logger');
const { findDefunct, DEFUNCT_THRESHOLD } = require('./lib/defunct');
const { sendText, desktopNotify, openInBrowser } = require('./lib/notify');
const brokerRunner = require('./lib/broker-runner');
const { sendOptOutEmails } = require('./lib/email');
const lock = require('./lib/lock');
const { applyFilter, loadLastLog, extractFailedBrokers } = require('./lib/filter');
const { diffResults, loadPreviousLog } = require('./lib/diff');
const { renderAuditMarkdown, writeAuditFile } = require('./lib/audit');
const { buildStealthScript } = require('./lib/stealth');

const PREVIEW           = process.argv.includes('--preview');
const DRY_RUN           = process.argv.includes('--dry-run') || PREVIEW; // --preview implies --dry-run
const VERIFY            = process.argv.includes('--verify');
const INSTALL_SCHEDULER = process.argv.includes('--install-scheduler');
const DOCTOR            = process.argv[2] === 'doctor' || process.argv.includes('--doctor');

// ── Filter flags ──────────────────────────────────────────────────────────────
const onlyIdx   = process.argv.indexOf('--only');
const ONLY_ARG  = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] || '') : null;
const skipIdx   = process.argv.indexOf('--skip');
const SKIP_ARG  = skipIdx !== -1 ? (process.argv[skipIdx + 1] || '') : null;
const RETRY_FAILED = process.argv.includes('--retry-failed');
const LIST_MODE    = process.argv.includes('--list');

const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');

// ── --list: print all brokers + status from state.json, then exit ────────────
if (LIST_MODE) {
  const brokers = require('./brokers');
  const state   = loadState();
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('Broker', 40) + pad('Status', 18) + 'Last opt-out');
  console.log('-'.repeat(80));
  for (const b of brokers) {
    const entry = state.optOuts && state.optOuts[b.name];
    const status = entry ? (entry.lastSuccess ? 'success' : 'pending') : 'never run';
    const last   = entry && entry.lastSuccess ? entry.lastSuccess.slice(0, 10) : '-';
    console.log(pad(b.name, 40) + pad(status, 18) + last);
  }
  console.log('');
  process.exit(0);
}

// ── --pending: print brokers awaiting email confirmation, then exit ──────────
if (PENDING_MODE) {
  const brokers = require('./brokers');
  const { getPendingConfirmations } = require('./lib/config');
  const pending = getPendingConfirmations(brokers);
  if (pending.length === 0) {
    console.log('\nNo brokers are currently awaiting email confirmation.\n');
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n' + pad('Broker', 40) + pad('Pending since', 14) + 'Confirmation hint');
    console.log('-'.repeat(90));
    for (const p of pending) {
      const since = p.since.slice(0, 10);
      const hint = p.expectedSender || (p.snippet ? p.snippet.slice(0, 40) : '(check your inbox)');
      console.log(pad(p.name, 40) + pad(since, 14) + hint);
    }
    console.log(`\n${pending.length} broker(s) awaiting confirmation. Check your inbox for opt-out confirmation emails.\n`);
  }
  process.exit(0);
}

// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
  const { runDoctor } = require('./lib/doctor');
  runDoctor().then(results => {
    process.exit(results.exitCode);
  }).catch(err => {
    console.error('doctor error:', err.message);
    process.exit(1);
  });
} else {

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
const persons = getPersonsFromConfig(config);
brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER });

// Detect brokers that have been consistently unreachable across recent runs.
// Defunct brokers still run — the warning is informational so the user can
// prune stale entries from brokers.js if the site is truly gone.
const defunctNames = findDefunct(state.optOuts || {});
if (defunctNames.length > 0) {
  setDefunctBrokers(defunctNames);
  console.log(`\n⚰️  ${defunctNames.length} broker(s) flagged as defunct (${DEFUNCT_THRESHOLD}+ consecutive unreachable errors):`);
  console.log(`   ${defunctNames.join(', ')}`);
  console.log('   These will still run. Remove from brokers.js if site is gone.\n');
}

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

  // Launch persistent browser (reuses profile / saved logins)
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  await context.addInitScript(buildStealthScript());

  // ── Verify mode: read-only spot-check, no opt-out submission ─────────────
  if (VERIFY) {
    const { runVerify } = require('./lib/verifier');
    await runVerify(context, brokers, state);
    await context.close().catch(() => {});
    return;
  }

  // ── Resolve --retry-failed broker set ──────────────────────────────────────
  let retryFailedFromLog;
  if (RETRY_FAILED) {
    const log = loadLastLog(LOG_DIR);
    if (!log) {
      console.log('⚠️  --retry-failed: no previous log found in logs/ — running all brokers.');
    } else {
      retryFailedFromLog = extractFailedBrokers(log);
      console.log(`🔄 --retry-failed: ${retryFailedFromLog.size} broker(s) from last log`);
    }
  }

  for (const person of persons) {
    if (persons.length > 1) {
      console.log(`\n${'='.repeat(54)}`);
      console.log(`Running for: ${person.firstName} ${person.lastName}`);
      console.log('='.repeat(54));
    }

    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER });

    // Email opt-outs (no browser needed — skipped in verify mode)
    if (!VERIFY) {
      console.log('── Email opt-outs ─────────────────────────────────────────');
      await sendOptOutEmails(brokers, config);
    }

    const filterOpts = {
      only:             ONLY_ARG,
      skip:             SKIP_ARG,
      retryFailedFromLog,
    };

    let sorted = applyFilter(
      [...brokers]
        .filter(b => b.method !== 'email')
        .sort((a, b) => (a.priority || 9) - (b.priority || 9)),
      filterOpts
    );

    if (RESUME) {
      const ckpt = loadCheckpoint();
      if (ckpt) {
        const ckptIdx = sorted.findIndex(b => b.name === ckpt);
        if (ckptIdx > 0) {
          console.log(`\n--resume: skipping ${ckptIdx} broker(s) before "${ckpt}"`);
          sorted = sorted.slice(ckptIdx);
        } else if (ckptIdx === -1) {
          console.log(`\n--resume: checkpoint broker "${ckpt}" not found in list, running all`);
        }
      } else {
        console.log('\n--resume: no checkpoint found, running all brokers');
      }
    }

    if (ONLY_ARG || SKIP_ARG || RETRY_FAILED) {
      console.log(`🔎 Filter applied — ${sorted.length} broker(s) will run`);
    }

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
  }

  // Clear checkpoint now that the run completed successfully
  clearCheckpoint();

  await context.close().catch(() => {});

  // Save run log (skipped in dry-run)
  if (!DRY_RUN) fs.writeFileSync(logFile, JSON.stringify(results, null, 2));

  // Diff against previous run + write audit markdown (skipped in dry-run)
  if (!DRY_RUN) {
    const prevLog = loadPreviousLog(LOG_DIR, logFile);
    const diff = diffResults(prevLog, results);
    console.log(`\n📊 ${diff.summary}`);

    const auditMd = renderAuditMarkdown({
      person: persons[0],
      timestamp: results.runAt,
      results,
    });
    const auditPath = writeAuditFile(LOG_DIR, auditMd, results.runAt);
    console.log(`📝 Audit: ${auditPath}`);
  }

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

} // end else (not DOCTOR mode)
