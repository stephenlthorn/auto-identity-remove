#!/usr/bin/env node
/**
 * auto-identity-remove - watcher.js (thin orchestrator)
 *
 * Automated data broker opt-out runner. Internals live in lib/ (config,
 * logger, notify, captcha, forms, broker-runner, platform).
 * Run: node watcher.js   (add --dry-run to fill forms without submitting)
 *      node watcher.js --help   for every flag
 *
 * Layout: the command line is parsed first (a bad flag exits 2 before anything
 * runs), then ONE mode runs. Every mode is a function below; dispatch() at the
 * bottom picks it.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Parse the command line before anything else loads. --help and a bad flag exit
// here: `--dryrun` used to be silently ignored and started a REAL submission run
// that sends the user's name, address and phone to ~540 sites (CORE-6).
const ARGS = require('./lib/args').parseWatcherArgsOrExit();

const { STATE_PATH, CONFIG_PATH, CONFIG_ENC_PATH, RECHECK_DAYS, loadConfig, loadState, saveState, recordSuccess, setDryRun, getPersonsFromConfig, loadCheckpoint, clearCheckpoint, findResumeIndex, readEntry, validateRunnableConfig } = require('./lib/config');
const { results, logResult, buildSummary, setDefunctBrokers, setCurrentPerson, setStateForSummary } = require('./lib/logger');
const { findDefunct, DEFUNCT_THRESHOLD } = require('./lib/defunct');
const { sendText, desktopNotify, openInBrowser, canOpenBrowser, pickManualUrlsToOpen } = require('./lib/notify');
const brokerRunner = require('./lib/broker-runner');
const { sendOptOutEmails } = require('./lib/email');
const { smtpTransportOptions } = require('./lib/smtp');
const { resolveSubmissionEmail } = require('./lib/relay');
const lock = require('./lib/lock');
const { loadLastLog, extractFailedBrokers, makeBrokerPredicate } = require('./lib/filter');
const { editAllowlist } = require('./lib/allowlist-edit');
const { diffResults, loadPreviousLog } = require('./lib/diff');
const { renderAuditMarkdown, writeAuditFile, timestampForFilename } = require('./lib/audit');
const { buildStealthScript } = require('./lib/stealth');
const { buildLaunchOptions, resolveHeadless, isLowMemory } = require('./lib/browser');
const { installShutdownHandlers } = require('./lib/shutdown');
const { writePrivateFile, mkdirPrivate } = require('./lib/private-fs');
const { resolveMode } = require('./lib/mode-dispatch');

const PREVIEW           = ARGS.preview;
const DRY_RUN           = ARGS.dryRun; // lib/args: --preview implies --dry-run
const VERIFY            = ARGS.verify;
const SERP_SCAN         = ARGS.serpScan;
const SERP_WATCH        = ARGS.serpWatch;
const INSTALL_SCHEDULER = ARGS.installScheduler;
const DOCTOR            = ARGS.doctor;

// ── Filter flags ──────────────────────────────────────────────────────────────
const ONLY_ARG     = ARGS.only;
const SKIP_ARG     = ARGS.skip;
const RETRY_FAILED = ARGS.retryFailed;
const LIST_MODE    = ARGS.list;
const SCORE_MODE   = ARGS.score;

const PENDING_MODE    = ARGS.pending;
const UPDATE_BROKERS  = ARGS.updateBrokers;
const BREACH_CHECK    = ARGS.breachCheck;
const NO_CAPSOLVER    = ARGS.noCapsolver;
const RESUME          = ARGS.resume;
const SNAPSHOT        = ARGS.snapshot;
const REPORT          = ARGS.report;
const POLLUTE_COUNT   = ARGS.pollute; // --pollute N: N fake records to acceptsBogus brokers

// -- Config-encryption migration flags (run before any pipeline work) ---------
const ENCRYPT_CONFIG  = ARGS.encryptConfig;
const DECRYPT_CONFIG  = ARGS.decryptConfig;
const KEEP_PLAINTEXT  = ARGS.keepPlaintext;
const KNOW_MODE       = ARGS.know;
const KNOW_STATUS     = ARGS.knowStatus;
const COMPLAINTS_MODE = ARGS.complaints;

// ── Credit / identity freeze guided checklist ────────────────────────────────
const FREEZE_DONE_KEY  = ARGS.freezeDone;
const FREEZE_CLEAR_KEY = ARGS.freezeClear;
const FREEZE_MODE      = ARGS.freezeMode;

// ── --confirm-emails [dir]: auto-click confirmation links in .eml files ───────
const CONFIRM_EMAILS   = ARGS.confirmEmails;
const confirmEmailsDir = ARGS.confirmEmailsDir;

const LOCK_PATH = STATE_PATH + '.lock';
const LOG_DIR   = path.join(__dirname, 'logs');

// Playwright's default is 30 s PER ACTION: one hidden toggle stalled a broker for
// half a minute (BRK-12). Navigations keep a generous limit of their own, because
// a context-wide default would otherwise cut them to the same few seconds.
const ACTION_TIMEOUT_MS     = 5000;
const NAVIGATION_TIMEOUT_MS = 30000;

// Notification settings, known once the config is loaded. Used by the crash handler.
let notifyConfig = null;

// ── Shared helpers ────────────────────────────────────────────────────────────

const personName = (person) => `${person.firstName} ${person.lastName}`.trim();

// Try local node_modules first, then fall back to the global openclaw install.
function loadChromium() {
  try {
    return require('playwright').chromium;
  } catch (_) {
    const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
    return require(fallback).chromium;
  }
}

function tuneContext(context) {
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

const profileDirOf = (config) =>
  (config.profileDir || '~/.config/auto-identity-remove').replace(/^~(?=\/|$)/, os.homedir());

/**
 * Take the process lock (one writer of state.json at a time) and arm the signal
 * handlers: `docker stop`, a scheduler unload and Ctrl-C deliver SIGTERM/SIGINT,
 * which used to kill node with the lock still on disk and the browser open
 * (CFG-5). Cleanups run last-registered first, so a mode that registers its
 * browser close and a state save after this gets: close browser, save state,
 * release lock. Returns the handle; call release() when the mode is done.
 */
function acquireRunLock(lockPath) {
  try {
    lock.acquire(lockPath);
  } catch (err) {
    const pidMatch = err.message.match(/pid (\d+)/);
    console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
    process.exit(1);
  }
  const shutdown = installShutdownHandlers({ onShutdown: () => lock.release(lockPath) });
  shutdown.release = () => {
    shutdown.uninstall();
    lock.release(lockPath);
  };
  return shutdown;
}

/**
 * The config and its persons for a run that sends something, or exit.
 *
 * A config copied from config.example.json parses and runs as "Jane Doe"; the
 * run then records successes that suppress the real one for 90 days (CFG-7).
 * A real run refuses; a dry run only warns, so the user can preview.
 */
function loadRunnableConfigOrExit() {
  let config;
  let persons;
  try {
    config = loadConfig();
    persons = getPersonsFromConfig(config);
  } catch (err) {
    console.error(`❌ could not load the config: ${err.message}`);
    process.exit(1);
  }

  const problems = validateRunnableConfig(config);
  if (problems.length > 0) {
    console.error('❌ config is not runnable:\n  - ' + problems.join('\n  - '));
    console.error('   Run `node setup.js` or edit config.json, then re-run.');
    if (!DRY_RUN) process.exit(1);
    console.error('   (dry run: continuing so you can preview; nothing is submitted)');
  }
  notifyConfig = config.notify;
  return { config, persons };
}

// The config and persons for a mode that only needs to read them.
function loadConfigOrExit() {
  try {
    const config = loadConfig();
    return { config, persons: getPersonsFromConfig(config) };
  } catch (err) {
    console.error(`❌ could not load the config: ${err.message}`);
    process.exit(1);
  }
}

/**
 * The submission email for every person, resolved ONCE and reused by every path
 * that submits (explicit forms, email opt-outs, generic forms, right-to-know).
 * Resolving it per path minted a second SimpleLogin alias and let one path use
 * the masked address while another sent the real one.
 *
 * The relay fails closed: a person whose alias cannot be created is returned in
 * `unavailable`, and every caller skips that person rather than fall back to the
 * address they asked to hide (relay.failOpen: true opts back in).
 *
 * @returns {Promise<{ emails: Map<object, string>, unavailable: Array<{ person: object, message: string }> }>}
 */
async function resolveRelayEmails({ config, persons, state }) {
  const emails = new Map();
  const unavailable = [];

  for (const person of persons) {
    const relay = await resolveSubmissionEmail({ config, person, state, dryRun: DRY_RUN });
    if (relay.email === null) {
      const message = relay.error ? relay.error.message : 'unknown error';
      unavailable.push({ person, message });
      console.error(`   Relay unavailable for ${personName(person)}: ${message}`);
      continue;
    }
    emails.set(person, relay.email);
    if (relay.email !== person.email) {
      console.log(`   Using masked email for ${persons.length > 1 ? personName(person) + "'s " : ''}submissions: ${relay.email}`);
    }
  }

  // A freshly minted alias lives only in memory until saved; a run that dies
  // before its first recorded result would mint another one next time.
  saveState();
  return { emails, unavailable };
}

// ── --freeze / --freeze-done <key> / --freeze-clear <key> ─────────────────────
// Guided credit/identity freeze checklist. Pure guidance + tracking; no browser
// is launched. Subcommands persist state.freezes under the same state lock as a
// normal run so a concurrent run cannot race the write.
function modeFreeze() {
  const { FREEZE_TARGETS, getFreezeStatus, recordFreezeDone, recordFreezeCleared, TARGET_KEYS } = require('./lib/freeze');
  const state = loadState();

  // Mutating subcommands take the lock; the read-only list does not need it.
  const isMutation = FREEZE_DONE_KEY !== null || FREEZE_CLEAR_KEY !== null;
  const guard = isMutation ? acquireRunLock(LOCK_PATH) : null;

  try {
    if (FREEZE_DONE_KEY !== null) {
      if (!TARGET_KEYS.has(FREEZE_DONE_KEY)) {
        console.error(`unknown freeze target: "${FREEZE_DONE_KEY}". Valid keys: ${[...TARGET_KEYS].join(', ')}`);
        process.exit(1);
      }
      recordFreezeDone(state, FREEZE_DONE_KEY);
      console.log(`Marked freeze done: ${FREEZE_DONE_KEY}`);
    } else if (FREEZE_CLEAR_KEY !== null) {
      if (!TARGET_KEYS.has(FREEZE_CLEAR_KEY)) {
        console.error(`unknown freeze target: "${FREEZE_CLEAR_KEY}". Valid keys: ${[...TARGET_KEYS].join(', ')}`);
        process.exit(1);
      }
      recordFreezeCleared(state, FREEZE_CLEAR_KEY);
      console.log(`Cleared freeze: ${FREEZE_CLEAR_KEY}`);
    }
  } finally {
    if (guard) guard.release();
  }

  // Always print the checklist after a list request or a mutation.
  const rows = getFreezeStatus(state);
  const doneCount = rows.filter(r => r.done).length;
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n Credit / identity freeze checklist');
  console.log('   Freezing your credit is the single highest-impact privacy action.');
  console.log('   Each target needs identity verification, so this is guidance, not automation.\n');
  console.log('   ' + pad('Done', 6) + pad('Target', 18) + pad('Type', 16) + 'URL');
  console.log('   ' + '-'.repeat(86));
  for (const r of rows) {
    const mark = r.done ? '[x]' : '[ ]';
    console.log('   ' + pad(mark, 6) + pad(r.name, 18) + pad(r.type, 16) + r.url);
  }
  console.log(`\n   ${doneCount}/${rows.length} complete.`);
  console.log('   Mark one done:  node watcher.js --freeze-done <key>');
  console.log('   Undo a mark:    node watcher.js --freeze-clear <key>');
  console.log(`   Keys: ${FREEZE_TARGETS.map(t => t.key).join(', ')}\n`);
  process.exit(0);
}

// -- --encrypt-config / --decrypt-config: at-rest encryption migration --------
function modeEncryption() {
  const { encryptConfigToDisk, decryptConfigToDisk, getPassphrase, PASSPHRASE_ENV, PASSPHRASE_FILE_ENV } = require('./lib/config');

  let passphrase;
  try {
    // Throws when AIDR_PASSPHRASE_FILE is set but unusable (missing, empty, or
    // readable by other users); that is not the same as "no passphrase".
    passphrase = getPassphrase();
  } catch (err) {
    console.error(`Cannot use the passphrase: ${err.message}`);
    process.exit(1);
  }
  if (!passphrase) {
    console.error(`No passphrase. Set ${PASSPHRASE_ENV} (export ${PASSPHRASE_ENV}=...) or point ${PASSPHRASE_FILE_ENV} at a 0600 file whose first line is the passphrase, then re-run.`);
    process.exit(1);
  }

  try {
    if (ENCRYPT_CONFIG) {
      const res = encryptConfigToDisk({ shred: !KEEP_PLAINTEXT });
      console.log(`\nEncrypted config written to ${res.encPath}`);
      console.log(res.shredded
        ? '   Plaintext config.json shredded.'
        : res.notice
          ? `   WARNING: ${res.notice}`
          : '   Plaintext config.json kept (--keep-plaintext).');
      console.log(`   Decrypt later with: node watcher.js --decrypt-config\n`);
    } else {
      const res = decryptConfigToDisk({ removeEnc: true });
      console.log(`\nDecrypted plaintext config written to ${res.configPath}`);
      console.log('   Encrypted config.json.enc removed.\n');
    }
    process.exit(0);
  } catch (err) {
    console.error(`Config migration failed: ${err.message}`);
    process.exit(1);
  }
}

// The persons to read state for, without insisting on a runnable config: --list
// worked with no config at all before it became person-aware. [] means "read the
// bare keys", which is what a single-person install writes.
function personsForReading() {
  if (!fs.existsSync(CONFIG_PATH) && !fs.existsSync(CONFIG_ENC_PATH)) return [];
  try {
    return getPersonsFromConfig(loadConfig());
  } catch (_) {
    return [];
  }
}

// ── --list: print all brokers + status from state.json, then exit ────────────
function modeList() {
  const brokers = require('./brokers');
  const state   = loadState();
  const persons = personsForReading();
  const pad = (s, n) => String(s).padEnd(n);

  // One table per person: in a multi-person install the entries sit under
  // "Broker|First Last", and a lookup by bare name found nothing for them.
  const people = persons.length > 0 ? persons : [null];
  people.forEach((person, index) => {
    if (person && persons.length > 1) console.log(`\n${personName(person)}`);
    console.log('\n' + pad('Broker', 40) + pad('Status', 18) + 'Last opt-out');
    console.log('-'.repeat(80));
    for (const b of brokers) {
      const entry = readEntry(state, b.name, person, persons.length, { personIndex: index });
      const status = entry ? (entry.lastSuccess ? 'success' : 'pending') : 'never run';
      const last   = entry && entry.lastSuccess ? entry.lastSuccess.slice(0, 10) : '-';
      console.log(pad(b.name, 40) + pad(status, 18) + last);
    }
  });
  console.log('');
  process.exit(0);
}

// ── --score: print the exposure score + breakdown + trend, then exit ─────────
// Read-only: no browser, no forms submitted. Reads state.json and the
// persisted SERP and breach signals; persists a dated snapshot to
// data/exposure-history.json.
function modeScore() {
  const brokers = require('./brokers');
  const state   = loadState();
  const {
    computeExposureScore,
    loadPersistedSignals,
    loadExposureHistory,
    snapshotExposure,
    formatScoreReport,
  } = require('./lib/exposure');

  // The SERP signal is the latest conclusive scan and the breach count is the
  // last real HIBP result, not the hard-coded 0 this used to pass.
  const summary = computeExposureScore({ state, brokers, ...loadPersistedSignals() });

  const priorHistory = loadExposureHistory();
  console.log('\n' + formatScoreReport(summary, priorHistory));
  // Persist this run's snapshot (skipped in dry-run to honor that contract).
  if (!DRY_RUN) snapshotExposure(summary);
  console.log('');
  process.exit(0);
}

// ── --pending: print brokers awaiting email confirmation, then exit ──────────
function modePending() {
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

// ── --allow / --unallow <name>: edit the config allowlist, then exit ─────────
function modeAllowlist() {
  const action = ARGS.allow !== null ? 'allow' : 'unallow';
  const name = action === 'allow' ? ARGS.allow : ARGS.unallow;

  let next;
  try {
    // Reads and rewrites the config the way it is stored (plaintext, encrypted
    // file or in-place envelope), atomically and 0600.
    next = editAllowlist(action, name);
  } catch (err) {
    console.error(`❌ could not update the allowlist: ${err.message}`);
    process.exit(1);
  }
  const verb = action === 'allow' ? 'Added to' : 'Removed from';
  console.log(`\n📌 ${verb} allowlist: ${name}`);
  console.log(`   Allowlist now: ${next.allowlist.join(', ') || '(empty)'}\n`);
  process.exit(0);
}

// -- --know-status: print right-to-know requests older than 45 days, then exit -
function modeKnowStatus() {
  const brokers = require('./brokers');
  const { getPendingKnowRequests } = require('./lib/config');
  const pending = getPendingKnowRequests(brokers, { olderThanDays: 45 });
  if (pending.length === 0) {
    console.log('\nNo right-to-know requests are older than 45 days awaiting a response.\n');
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n' + pad('Broker', 40) + pad('Requested', 14) + 'Days ago');
    console.log('-'.repeat(70));
    for (const p of pending) {
      const when = p.knowRequestedAt.slice(0, 10);
      console.log(pad(p.name, 40) + pad(when, 14) + Math.round(p.daysAgo));
    }
    console.log(`\n${pending.length} right-to-know request(s) past 45 days. Follow up with the broker if no disclosure arrived.\n`);
  }
  process.exit(0);
}

// ── --breach-check: query Have I Been Pwned for configured emails, then exit ─
async function modeBreachCheck() {
  const brokers = require('./brokers');
  const {
    collectEmails,
    missingKeyMessage,
    runBreachCheck,
    formatBreachReport,
  } = require('./lib/hibp');
  const { recordBreachResult } = require('./lib/exposure');

  const { config: cfg, persons } = loadConfigOrExit();
  const emails  = collectEmails(persons);
  const apiKey  = cfg.hibp && cfg.hibp.apiKey;

  if (!apiKey) {
    console.log('\n' + missingKeyMessage() + '\n');
    process.exit(0);
  }

  if (emails.length === 0) {
    console.log('\nNo email addresses found in config.json. Add an "email" to your person(s) first.\n');
    process.exit(0);
  }

  console.log(`\nChecking ${emails.length} email(s) against Have I Been Pwned...`);
  const result = await runBreachCheck({ emails, apiKey, brokers });
  console.log('\n' + formatBreachReport(result) + '\n');

  // Keep the count for --score, --report and the dashboard. An inconclusive
  // check never lowers it: a rate-limited run is not an improvement.
  if (!DRY_RUN) recordBreachResult(result);

  // Exit 2 when a lookup failed: a scheduled job must not read "could not check"
  // as "checked, clean".
  process.exit(result.inconclusive ? 2 : 0);
}

// ── --complaints: generate regulator complaints for brokers past the legal
//    response window (CCPA 45d / GDPR 30d) and write text + PDF to logs/. ─────
async function modeComplaints() {
  const brokers = require('./brokers');
  const { findOverdue, findOverdueKnowRequests, formatOverdueKnowNote, buildComplaintsForBroker, writeComplaintFiles } = require('./lib/complaint');

  const { config, persons } = loadConfigOrExit();
  const state   = loadState();
  const brokerMap = new Map(brokers.map(b => [b.name, b]));
  // Resolve the complaint's complainant back to the person named in the
  // composite state key (B2); fall back to the first person for bare keys.
  const personByName = new Map(
    persons
      .filter(p => p && (p.firstName || p.lastName))
      .map(p => [`${p.firstName || ''} ${p.lastName || ''}`.trim(), p])
  );

  // An unanswered right-to-know request is not a deletion complaint (the tool
  // cannot see whether the broker replied), so it is reported, never filed.
  const knowNote = formatOverdueKnowNote(findOverdueKnowRequests(state, { persons }));
  if (knowNote) console.log('\n' + knowNote);

  const overdueList = findOverdue(state, { persons });
  if (overdueList.length === 0) {
    console.log('\nNo broker qualifies for a complaint: it needs a deletion request past its response window and a verification (run --verify) that your data is still listed.\n');
    process.exit(0);
  }

  const outDir = path.join(LOG_DIR, 'complaints');
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('Broker', 32) + pad('Regime', 8) + pad('Days overdue', 14) + 'Requested');
  console.log('-'.repeat(78));

  const entries = overdueList.map(overdue => {
    const broker = brokerMap.get(overdue.broker) || { name: overdue.broker };
    const person = (overdue.person && personByName.get(overdue.person)) || persons[0];
    console.log(
      pad(overdue.broker, 32) +
      pad(overdue.regime, 8) +
      pad(String(overdue.daysOverdue), 14) +
      String(overdue.requestedAt).slice(0, 10)
    );
    return { broker: overdue.broker, person: overdue.person, complaints: buildComplaintsForBroker({ person, broker, overdue }) };
  });

  // Complaints carry the complainant's name, address, email and phone.
  mkdirPrivate(outDir);

  let newPage;
  let context;
  if (!DRY_RUN) {
    const chromiumForPdf = loadChromium();
    context = await chromiumForPdf.launchPersistentContext(profileDirOf(config), buildLaunchOptions({ headless: true }));
    tuneContext(context);
    newPage = () => context.newPage();
  } else {
    console.log('\nDRY RUN - writing complaint text only, skipping PDF generation.');
  }

  try {
    const { written } = await writeComplaintFiles({ outDir, entries, newPage });
    console.log(`\nWrote ${written.length} complaint file(s) to ${outDir}`);
    const pdfCount = written.filter(p => p.endsWith('.pdf')).length;
    const txtCount = written.filter(p => p.endsWith('.txt')).length;
    console.log(`   ${txtCount} text, ${pdfCount} PDF\n`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  process.exit(0);
}

// ── --confirm-emails [dir]: process .eml files and auto-click confirm links ───
async function modeConfirmEmails() {
  const brokers = require('./brokers');
  const { processConfirmationEmails } = require('./lib/imap-confirm');

  // Launch a minimal headless browser context just for navigating confirm links
  const chromiumForConfirm = loadChromium();
  const { config, persons } = loadConfigOrExit();

  // Acquire the same process lock as the main run - processConfirmationEmails
  // calls recordSuccess -> saveState, so it must not race a concurrent run.
  const guard = acquireRunLock(LOCK_PATH);

  try {
    console.log(`\nProcessing confirmation emails from: ${confirmEmailsDir}`);
    const context = await chromiumForConfirm.launchPersistentContext(profileDirOf(config), buildLaunchOptions({ headless: true }));
    guard.register(() => context.close().catch(() => {}));
    tuneContext(context);

    try {
      // persons + relayAliases let a confirmation be matched to the right person
      // (including mail delivered to their masked alias) instead of the first.
      const result = await processConfirmationEmails(context, brokers, {
        dir: confirmEmailsDir,
        dryRun: DRY_RUN,
        persons,
        relayAliases: loadState().relayAliases,
      });

      // A confirmation is matched to a person (entry.person is the person object),
      // so say whose it was: in a household two people can be pending at one broker.
      for (const entry of result.processed) {
        const who = entry.person && typeof entry.person === 'object' ? ` (${personName(entry.person)})` : '';
        console.log(`  ${DRY_RUN ? 'would confirm' : 'confirmed'}: ${entry.broker.name}${who} -> ${entry.url}`);
      }
      for (const entry of result.unmatched) {
        console.log(`  unmatched (${entry.reason}): ${entry.file}`);
      }
      for (const entry of result.failed) {
        console.log(`  failed: ${entry.broker.name}${entry.reason ? ` (${entry.reason})` : ''} -> ${entry.error}`);
      }

      const total = result.processed.length + result.unmatched.length + result.failed.length;
      console.log(`\nDone: ${result.processed.length} ${DRY_RUN ? 'would be confirmed' : 'confirmed'}, ${result.unmatched.length} unmatched, ${result.failed.length} failed (${total} .eml files)`);
      if (DRY_RUN) console.log('DRY RUN - no link was opened and no state was changed.');
      console.log('');
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    guard.release();
  }
  process.exit(0);
}

// ── --report: build monthly PDF + emailable HTML report and exit ─────────────
async function modeReport() {
  const brokers = require('./brokers');
  const { buildReportModel, renderReportHtml, renderReportPdf, reportPdfPath, REPORT_DIR } = require('./lib/report');
  const {
    computeExposureScore,
    loadPersistedSignals,
    loadExposureHistory,
    snapshotExposure,
    exposureToReportAdapter,
  } = require('./lib/exposure');

  const chromiumForReport = loadChromium();
  const { config: reportConfig } = loadConfigOrExit();

  const guard = acquireRunLock(LOCK_PATH);
  try {
    const state = loadState();

    // Compute current exposure so the report can show a real trend, from the same
    // persisted signals --score uses.
    const exposureSummary = computeExposureScore({ state, brokers, ...loadPersistedSignals() });
    const priorHistory = loadExposureHistory();
    const exposure = exposureToReportAdapter(exposureSummary, priorHistory);
    // Without this the report's "previous" figure never moves: every report
    // would compare against the last --score run.
    if (!DRY_RUN) snapshotExposure(exposureSummary);

    const model = buildReportModel({ state, brokers, exposure });
    const html = renderReportHtml(model);

    mkdirPrivate(REPORT_DIR);
    const outPath = reportPdfPath(new Date());

    const context = await chromiumForReport.launchPersistentContext(profileDirOf(reportConfig), buildLaunchOptions({ headless: true }));
    guard.register(() => context.close().catch(() => {}));
    tuneContext(context);

    try {
      await renderReportPdf({ html, outPath, context });
      console.log(`\nReport PDF written: ${outPath}`);

      const smtp = reportConfig.email && reportConfig.email.smtp;
      let emailed = false;
      if (smtp && reportConfig.notify && reportConfig.notify.emailReportTo) {
        if (DRY_RUN) {
          console.log(`DRY RUN - report not emailed to ${reportConfig.notify.emailReportTo}`);
        } else {
          let nodemailer;
          try {
            nodemailer = require('nodemailer');
          } catch (_) {
            nodemailer = null;
          }
          if (nodemailer) {
            try {
              const transporter = nodemailer.createTransport(smtpTransportOptions(smtp));
              await transporter.sendMail({
                from: smtp.from || smtp.user,
                to: reportConfig.notify.emailReportTo,
                subject: `Privacy report - ${model.period}`,
                html,
                attachments: [{ path: outPath }],
              });
              emailed = true;
              console.log(`Report emailed to ${reportConfig.notify.emailReportTo}`);
            } catch (err) {
              console.error(`Report email failed: ${err.message.slice(0, 80)}`);
            }
          }
        }
      }

      if (!emailed) {
        if (!DRY_RUN) desktopNotify('Privacy report', `Monthly report saved: ${outPath}`);
        console.log(`Report saved (no SMTP configured or email failed). Actions needed: ${model.actionsNeeded.length}`);
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    guard.release();
  }
  process.exit(0);
}

// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
async function modeDoctor() {
  const { runDoctor } = require('./lib/doctor');
  const outcome = await runDoctor();
  process.exit(outcome.exitCode);
}

// ── --update-brokers: refresh data/feeds-brokers.json from live registries ───
// Pure HTTP + file write; no Playwright, no loadConfig. Fetches the California
// + Vermont data-broker registries, normalizes, dedups against brokers.js, and
// writes the feed file consumed by generic-runner.js. Markup data remains the
// fallback.
async function modeUpdateBrokers() {
  const brokers = require('./brokers');
  const { runUpdateBrokers } = require('./lib/feeds');
  await runUpdateBrokers({ brokers, logFn: (m) => console.log(m) });
  process.exit(0);
}

// ── --install-scheduler: register with OS scheduler and exit ─────────────────
function modeInstallScheduler() {
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

// -- --know: fire right-to-know (data access) requests to email brokers, exit --
// No browser needed - email-method brokers only. Acquires the state lock since
// recordKnowRequest -> saveState writes state.json.
async function modeKnow({ config, persons, state }) {
  const brokers = require('./brokers');
  const { sendKnowRequests } = require('./lib/right-to-know-runner');
  const { getPendingKnowRequests } = require('./lib/config');

  const guard = acquireRunLock(LOCK_PATH);
  let exitCode = 0;
  try {
    console.log('\nRight-to-know - requesting disclosure of held data from email brokers');
    if (DRY_RUN) console.log('DRY RUN - previews only, nothing sent, no state saved.');
    const emailBrokerCount = brokers.filter(b => b.method === 'email').length;
    console.log(`${emailBrokerCount} email broker(s) x ${persons.length} person(s)\n`);

    // The same masked address the opt-outs use, so the broker's reply reaches the
    // alias and no second alias is minted for the same person.
    const { emails, unavailable } = await resolveRelayEmails({ config, persons, state });

    if (unavailable.length > 0) {
      // sendKnowRequests keys its state per person by the size of the person list
      // it is given, so a person cannot be left out of one call. Refusing the
      // whole run is the only way to keep their real email from being sent.
      console.error(`\n❌ Not sending any right-to-know request: the masked-email relay is unavailable for ${unavailable.map(u => personName(u.person)).join(', ')}.`);
      console.error('   Every request carries an email, and the relay fails closed. Fix the relay and re-run (relay.failOpen: true sends the real email instead).\n');
      exitCode = 1;
    } else {
      const result = await sendKnowRequests(brokers, config, {
        dryRun: DRY_RUN,
        submissionEmailFor: (person) => emails.get(person),
      });

      console.log('\n' + '='.repeat(54));
      console.log('Right-to-know results - ' + new Date().toLocaleString());
      console.log('='.repeat(54));
      console.log(`  sent (SMTP) : ${result.sent.length}`);
      console.log(`  manual      : ${result.manual.length}`);
      console.log(`  already sent: ${result.skipped.length} (still inside the response window)`);
      console.log(`  errors      : ${result.errors.length}`);
      for (const e of result.errors) console.log(`    - ${e.name}: ${e.error}`);
      const pending = getPendingKnowRequests(brokers, { olderThanDays: 45 });
      console.log(`\n  ${pending.length} prior request(s) now past 45 days (run --know-status for detail).`);
      console.log('='.repeat(54) + '\n');
    }
  } finally {
    guard.release();
  }
  process.exit(exitCode);
}

// ── Normal run and the browser-backed read-only modes ────────────────────────

async function main({ config, persons, state }) {
  const guard = acquireRunLock(LOCK_PATH);
  try {
    return await runWithBrowser({ config, persons, state, guard });
  } finally {
    guard.release();
  }
}

async function runWithBrowser({ config, persons, state, guard }) {
  const brokers = require('./brokers');

  console.log('\n🔒 auto-identity-remove - starting run');
  if (PREVIEW)       console.log('👀 PREVIEW - field values and target URLs will be printed before submit. No state will be saved.');
  else if (DRY_RUN)  console.log('🧪 DRY RUN - forms will be filled but NOT submitted. No state will be saved.');
  if (VERIFY)        console.log('🔍 VERIFY - re-checking listings. No forms submitted. Verification results are saved.');
  if (POLLUTE_COUNT) console.log(`⚠️  NOISE MODE - ${POLLUTE_COUNT} bogus record(s) will be submitted to acceptsBogus brokers.`);
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log(`📋 ${brokers.length} explicit brokers + 500+ generic | re-check window: ${RECHECK_DAYS} days\n`);

  brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], personIndex: 0, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config });

  // Detect brokers that have been consistently unreachable across recent runs.
  // Defunct brokers still run - the warning is informational so the user can
  // prune stale entries from brokers.js if the site is truly gone.
  const defunctNames = findDefunct(state.optOuts || {});
  if (defunctNames.length > 0) {
    setDefunctBrokers(defunctNames);
    console.log(`\n⚰️  ${defunctNames.length} broker(s) flagged as defunct (${DEFUNCT_THRESHOLD}+ consecutive unreachable errors):`);
    console.log(`   ${defunctNames.join(', ')}`);
    console.log('   These will still run. Remove from brokers.js if site is gone.\n');
  }

  const chromium = loadChromium();

  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');
  }

  // Launch persistent browser (reuses profile / saved logins)
  const profileDir = profileDirOf(config);
  fs.mkdirSync(profileDir, { recursive: true });

  // Headless mode: respect HEADLESS env var, else auto-detect.
  // Default to false (headed) on platforms where a display is likely present.
  // In Docker (no $DISPLAY on linux), default to headless: true so the tool actually runs.
  const headlessEnv = process.env.HEADLESS;
  const headless = resolveHeadless();
  console.log(`🖥  Browser mode: ${headless ? 'headless' : 'headed'}${headlessEnv === undefined && process.platform === 'linux' ? ' (auto-detected)' : ''}${isLowMemory() ? ' [low-memory profile]' : ''}`);

  // A signal arriving mid-run saves what has been recorded and closes the
  // browser before the lock goes (the shutdown runs these last-registered first).
  guard.register(() => { if (!DRY_RUN) saveState(); });
  const context = await chromium.launchPersistentContext(profileDir, buildLaunchOptions({ headless }));
  guard.register(() => context.close().catch(() => {}));
  tuneContext(context);
  await context.addInitScript(buildStealthScript());

  try {
    if (VERIFY)     return await runVerifyMode(context, { brokers, persons, state, config });
    if (SERP_SCAN)  return await runSerpScanMode(context, { brokers, persons });
    if (SERP_WATCH) return await runSerpWatchMode(context, { brokers, persons, config });
    return await runSubmissions(context, { brokers, persons, state, config });
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Verify mode: T+7 post-submit verification loop ───────────────────────────
async function runVerifyMode(context, { brokers, persons, state, config }) {
  const { runVerify } = require('./lib/verify-loop');
  // Each person is searched with THEIR OWN broker list: brokers.js bakes the
  // person's name and city into searchUrl, so a shared list recorded person B as
  // verified clear from person A's search.
  const result = await runVerify(context, brokers, persons, { state, config, brokersFor: (person) => brokers.forPerson(person) });
  saveState();
  await context.close().catch(() => {});

  console.log('\n' + '='.repeat(54));
  console.log('Verification results - ' + new Date().toLocaleString());
  console.log('='.repeat(54));
  console.log(`  verified_clear : ${result.verified_clear.length}`);
  console.log(`  still_listed   : ${result.still_listed.length}`);
  console.log(`  unverifiable   : ${result.unverifiable.length}`);
  console.log(`  skipped        : ${result.skipped.length}`);
  if (result.still_listed.length > 0) {
    console.log('\nStill listed (opt-out may have failed or data was re-added):');
    for (const e of result.still_listed) {
      const name = e.person ? personName(e.person) : '';
      console.log(`  - ${e.broker}${name ? ` (${name})` : ''}`);
    }
  }
  console.log('='.repeat(54) + '\n');
}

// ── SERP scan mode: search-engine broker visibility audit ────────────────────
async function runSerpScanMode(context, { brokers, persons }) {
  const { runSerpScan, describeScanOutcome } = require('./lib/serp-scan');
  console.log('\n🔎 SERP scan - checking broker visibility in search engines');
  console.log('   DDG first, then Bing, then Google (may be blocked).\n');
  const summary = await runSerpScan(context, persons, brokers, { _skipWrite: DRY_RUN });
  await context.close().catch(() => {});

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + '='.repeat(62));
  console.log('SERP Scan Results - ' + new Date().toLocaleString());
  console.log('='.repeat(62));

  if (summary.blocked.length > 0) {
    console.log(`\n  Blocked engines (bot-detection triggered): ${summary.blocked.join(', ')}`);
  }

  console.log(`\n  Brokers appearing in search results: ${summary.total_brokers_appearing}`);

  if (summary.total_brokers_appearing > 0) {
    console.log('');
    console.log(
      '  ' + pad('Broker', 32) + pad('DDG', 8) + pad('Bing', 8) + 'Google'
    );
    console.log('  ' + '-'.repeat(56));
    for (const { broker, ranks } of summary.results) {
      const r = n => (n === null ? '-' : String(n));
      console.log(
        '  ' + pad(broker, 32) + pad(r(ranks.ddg), 8) + pad(r(ranks.bing), 8) + r(ranks.google)
      );
    }
  }

  // "Your opt-outs appear to be effective" is only said when every engine was
  // usable; a blocked or unreadable engine is named and may make it INCONCLUSIVE.
  console.log('');
  for (const line of describeScanOutcome(summary)) console.log('  ' + line);

  console.log('\n' + '='.repeat(62) + '\n');
  if (summary.inconclusive) process.exitCode = 2;
}

// -- SERP watch mode: scan + diff vs history + alert on NEW domains ------------
async function runSerpWatchMode(context, { brokers, persons, config }) {
  const { runSerpWatch, describeWatchOutcome } = require('./lib/serp-watch');
  const { runSerpScan } = require('./lib/serp-scan');
  console.log('\n SERP watch - scanning, then diffing against previous history');
  console.log('   Alerts fire only when your name appears on a NEW domain.\n');

  const watchOptions = { cfg: config };
  if (DRY_RUN) {
    // A dry run keeps the history file and the alert channel untouched.
    watchOptions._runSerpScan = (ctx, people, list) => runSerpScan(ctx, people, list, { _skipWrite: true });
    watchOptions._dispatchNotify = async () => {};
  }
  const watch = await runSerpWatch(context, persons, brokers, watchOptions);
  await context.close().catch(() => {});

  console.log('\n' + '='.repeat(62));
  console.log('SERP Watch Results - ' + new Date().toLocaleString());
  console.log('='.repeat(62));
  if (watch.summary.blocked.length > 0) {
    console.log(`\n  Blocked engines (bot-detection triggered): ${watch.summary.blocked.join(', ')}`);
  }
  console.log(`\n  New domains    : ${watch.diff.newDomains.length}`);
  console.log(`  Gone domains   : ${watch.diff.goneDomains.length}`);
  console.log(`  Still present  : ${watch.diff.stillPresent.length}`);
  console.log('');
  for (const line of describeWatchOutcome(watch)) {
    console.log('  ' + (DRY_RUN && line === 'An alert was dispatched.' ? 'DRY RUN - the alert was not sent.' : line));
  }
  console.log('\n' + '='.repeat(62) + '\n');
  if (watch.inconclusive) process.exitCode = 2;
}

// ── The opt-out run: email opt-outs, explicit forms, noise, generic forms ────
async function runSubmissions(context, { brokers, persons, state, config }) {
  // Timestamped to the second (B8): two runs on the same day must not overwrite
  // each other, otherwise loadPreviousLog/diffResults can never diff intraday runs.
  const logFile = path.join(LOG_DIR, `run-${timestampForFilename(new Date().toISOString())}.json`);
  const stamp = () => new Date().toLocaleTimeString();

  // ── Resolve --retry-failed broker set ──────────────────────────────────────
  let retryFailedFromLog;
  if (RETRY_FAILED) {
    const log = loadLastLog(LOG_DIR);
    if (!log) {
      console.log('⚠️  --retry-failed: no previous log found in logs/ - running all brokers.');
    } else {
      retryFailedFromLog = extractFailedBrokers(log);
      console.log(`🔄 --retry-failed: ${retryFailedFromLog.size} broker(s) from last log`);
    }
  }

  // ONE include test for the whole run: the email opt-outs, the explicit forms
  // and the ~490 generic brokers all honour --only / --skip / --retry-failed.
  // They used to filter only the explicit list, so `--only Spokeo` still sent
  // every opt-out email and ran the whole generic pass (CORE-4).
  const include = makeBrokerPredicate({ only: ONLY_ARG, skip: SKIP_ARG, retryFailedFromLog });

  // The email each person submits with, resolved once (masked alias when a relay
  // is configured). A person the relay cannot serve is skipped everywhere below.
  const { emails: submissionEmails, unavailable } = await resolveRelayEmails({ config, persons, state });
  const relaySkipped = new Set(unavailable.map(u => u.person));
  for (const { person, message } of unavailable) {
    setCurrentPerson(person);
    logResult(
      'Masked-email relay',
      'error',
      `unavailable (${message}); nothing was submitted for ${personName(person)}. Re-run once it works (a plain run: --retry-failed will not revisit them), or set relay.failOpen: true to send the real email`
    );
  }
  setCurrentPerson(null);
  if (relaySkipped.size > 0) process.exitCode = 1;

  for (const [index, person] of persons.entries()) {
    if (relaySkipped.has(person)) continue;

    // Everything logged below is tagged with this person, so a two-person run is
    // not one anonymous list (CFG-13).
    setCurrentPerson(person);

    if (persons.length > 1) {
      console.log(`\n${'='.repeat(54)}`);
      console.log(`Running for: ${personName(person)}`);
      console.log('='.repeat(54));
    }

    const submissionEmail = submissionEmails.get(person);
    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, personIndex: index, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config, submissionEmail });

    // Rebuild the broker list for THIS person. brokers.js interpolates names,
    // city, state, zip and email into searchUrl and formFields, so reusing the
    // module-level array would submit persons[0]'s PII on every iteration.
    const personBrokers = brokers.forPerson(person);

    // Email opt-outs (no browser needed).
    // onlyPerson restricts this call to the current person - sendOptOutEmails
    // otherwise re-sends to every person in config on every call, so calling
    // it once per person in this loop multiplied real sends by persons.length.
    // dryRun: --dry-run must not send real opt-out emails either.
    console.log('── Email opt-outs ─────────────────────────────────────────');
    await sendOptOutEmails(brokers, config, undefined, { submissionEmailFor: (p) => submissionEmails.get(p), onlyPerson: person, dryRun: DRY_RUN, include });

    let sorted = personBrokers
      .filter(b => b.method !== 'email' && include(b.name))
      .sort((a, b) => (a.priority || 9) - (b.priority || 9));

    if (RESUME) {
      const ckpt = loadCheckpoint();
      if (ckpt) {
        // Match via stateKey (B22): the checkpoint stores the composite
        // "Broker|First Last" key in multi-person mode, so a bare-name compare
        // would miss and silently re-run everything.
        const ckptIdx = findResumeIndex(sorted, ckpt, person, persons.length);
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
      console.log(`🔎 Filter applied - ${sorted.length} broker(s) will run`);
    }

    console.log('\n── Explicit broker opt-outs ───────────────────────────────');
    for (const broker of sorted) {
      process.stdout.write(`\n[${stamp()}] ${broker.name}… `);
      await brokerRunner.processBroker(context, broker);
    }
  }
  setCurrentPerson(null);

  // ── Noise / pollution mode (--pollute N) ────────────────────────────────────
  // Submits N randomly-generated fake records to brokers tagged acceptsBogus.
  // Once per run, not once per person: it was inside the person loop, so a
  // two-person household sent every bogus record twice. noState keeps it out of
  // the opt-out history, the checkpoint and the run results. Off by default
  // (POLLUTE_COUNT === 0). See README for ToS warning.
  if (POLLUTE_COUNT > 0) {
    const { generateBogusPerson } = require('./lib/noise');
    const bogBrokers = brokers.filter(b => b.acceptsBogus === true);

    if (bogBrokers.length === 0) {
      console.log('\n⚠️  --pollute: no brokers tagged acceptsBogus: true - nothing to do.');
    } else {
      console.log(`\n── Noise mode - submitting ${POLLUTE_COUNT} bogus record(s) to ${bogBrokers.length} broker(s) ─`);
      for (let i = 0; i < POLLUTE_COUNT; i++) {
        const fakePerson = generateBogusPerson();
        console.log(`\n   [bogus ${i + 1}/${POLLUTE_COUNT}] ${fakePerson.firstName} ${fakePerson.lastName} (${fakePerson.city}, ${fakePerson.state})`);
        for (const broker of bogBrokers) {
          process.stdout.write(`     ${broker.name}… `);
          await brokerRunner.processBrokerWithPerson(context, broker, fakePerson, { noState: true });
        }
      }
    }
  }

  // Build the set of explicit broker hostnames so generic-runner can skip them.
  const explicitHosts = new Set(
    brokers.map(b => {
      try {
        return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, '');
      } catch(_) { return ''; }
    }).filter(Boolean)
  );

  // One generic pass PER PERSON.
  //
  // This used to run once, using persons[0], with state keyed on the bare broker
  // name. But fillGenericForm() submits a real name, email, state and zip - so
  // "generic" is not person-agnostic for the brokers that take a form. The old
  // shape meant only persons[0] was ever requested while the single state entry
  // marked the broker done for the whole household, and the report claimed
  // everyone had been opted out.
  //
  // The cost is real and worth naming: an N-person run now does the ~490-broker
  // generic pass N times, so wall-clock scales with N. Correct coverage beats a
  // faster run that quietly skips people. Domain-level toggles (cookie /
  // "Do Not Sell") get re-applied per person, which is harmless.
  const { runGenericBrokers } = require('./generic-runner');
  const genericTotals = {};
  for (const [index, person] of persons.entries()) {
    if (relaySkipped.has(person)) continue;
    setCurrentPerson(person);
    if (persons.length > 1) {
      console.log(`\n── Generic brokers for ${personName(person)} ──`);
    }
    const genericResult = await runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, {
      dryRun: DRY_RUN,
      person,
      personCount: persons.length,
      personIndex: index,
      // The same masked address as the explicit loop: a generic form that typed
      // person.email would hand the broker the address the relay hides.
      submissionEmail: submissionEmails.get(person),
      include,
      // Lets the generic pass drop rows that are the same company as an explicit broker.
      explicitBrokers: brokers,
    });
    if (genericResult && genericResult.genericStats) {
      for (const [k, v] of Object.entries(genericResult.genericStats)) {
        genericTotals[k] = (genericTotals[k] || 0) + (typeof v === 'number' ? v : 0);
      }
    }
  }
  setCurrentPerson(null);
  results.genericStats = genericTotals;

  // Clear checkpoint now that the run completed successfully (a no-op in dry-run,
  // so a preview never deletes the checkpoint of an interrupted real run).
  clearCheckpoint();

  await context.close().catch(() => {});

  // Save run log (skipped in dry-run). A filtered or resumed run covers only part
  // of the broker list, so it is marked: diffing the next full run against it
  // would report hundreds of "newly removed" brokers.
  const partial = !!(ONLY_ARG || SKIP_ARG || RETRY_FAILED || RESUME);
  const logBody = partial
    ? { ...results, partial: true, filter: { only: ONLY_ARG || null, skip: SKIP_ARG || null, retryFailed: !!RETRY_FAILED, resume: !!RESUME } }
    : results;
  if (!DRY_RUN) {
    // The log holds the user's name and the brokers that hold their data.
    mkdirPrivate(LOG_DIR);
    writePrivateFile(logFile, JSON.stringify(logBody, null, 2));
  }

  // Diff against previous run + write audit markdown (skipped in dry-run)
  if (!DRY_RUN) {
    const prevLog = loadPreviousLog(LOG_DIR, logFile);
    const diff = diffResults(prevLog, results);
    console.log(`\n📊 ${diff.summary}`);

    const auditMd = renderAuditMarkdown({
      person: persons[0],
      persons,
      timestamp: results.runAt,
      results,
    });
    const auditPath = writeAuditFile(LOG_DIR, auditMd, results.runAt);
    console.log(`📝 Audit: ${auditPath}`);
  }

  // Manual-required sites: open them when a desktop is there to show them, and
  // never in a dry run. A headless host has no browser to open.
  const manualUrls = [...results.captchaFailed, ...results.manual]
    .map(r => r.detail || '')
    .filter(u => u.startsWith('http'));
  if (manualUrls.length > 0) {
    const { open, more } = pickManualUrlsToOpen(manualUrls);
    if (!DRY_RUN && canOpenBrowser()) {
      console.log(`\n🖥  Opening ${open.length} manual site(s) in browser…`);
      openInBrowser(open);
    } else {
      console.log(`\n📋 ${open.length} manual site(s) need you${DRY_RUN ? ' (not opened in a dry run)' : ' (no display on this host, so not opened)'}:`);
      open.forEach(u => console.log('   ' + u));
    }
    if (more > 0) {
      console.log(`   ${more} more manual site(s) not opened - see the manual entries in ${DRY_RUN ? 'the output above' : logFile}`);
    }
  }

  // Print summary (with the drift section, which needs the state)
  setStateForSummary(state);
  const summary = buildSummary();
  console.log('\n' + '═'.repeat(54));
  console.log(summary);
  console.log('═'.repeat(54));
  console.log(DRY_RUN ? '\n📄 Log: not written (dry run)' : `\n📄 Log: ${logFile}`);
  console.log(DRY_RUN ? '💾 State: not saved (dry run)\n' : `💾 State: ${STATE_PATH}\n`);

  // A dry run or preview must not text anyone or raise a desktop notification.
  if (DRY_RUN) return;

  // "Submitted" is not "removed": a form that was accepted may still need an
  // email click, and brokers re-list people. The wording says what happened.
  const manualCount = results.captchaFailed.length + results.manual.length;
  const totalProcessed = results.succeeded.length + results.pendingConfirm.length + results.unverified.length
    + results.skipped.length + results.notFound.length + manualCount + results.errors.length + results.dead.length;
  const short = [
    `🔒 Privacy Watcher (${new Date().toLocaleDateString()}):`,
    `✅ Submitted: ${results.succeeded.length}`,
    `📧 Awaiting email confirm: ${results.pendingConfirm.length}`,
    `❓ Unconfirmed: ${results.unverified.length}`,
    `⏭  Skipped: ${results.skipped.length}`,
    `📋 Manual: ${manualCount}`,
    ...(results.errors.length > 0 ? [`❌ Errors: ${results.errors.length}`] : []),
    `📊 Total: ${totalProcessed} brokers checked`,
  ].join('\n');
  sendText(short, config.notify);
  desktopNotify('Privacy Watcher', `Done - ${results.succeeded.length} submitted, ${results.pendingConfirm.length} awaiting email confirmation, ${manualCount} need manual action (${totalProcessed} total)`);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch() {
  // Combining modes is ambiguous (--list --score would silently run only one).
  // Checked before any mode runs; exit 2 like any other bad command line.
  const { conflict } = resolveMode({ ...ARGS, freeze: FREEZE_MODE });
  if (conflict) {
    console.error(`Error: ${conflict}`);
    process.exit(2);
  }
  if (ARGS.allow !== null && ARGS.unallow !== null) {
    console.error('Error: --allow and --unallow cannot be combined. Use one at a time.');
    process.exit(2);
  }

  if (FREEZE_MODE)                     return modeFreeze();
  if (ENCRYPT_CONFIG || DECRYPT_CONFIG) return modeEncryption();
  if (LIST_MODE)                       return modeList();
  if (SCORE_MODE)                      return modeScore();
  if (PENDING_MODE)                    return modePending();
  if (ARGS.allow !== null || ARGS.unallow !== null) return modeAllowlist();
  if (KNOW_STATUS)                     return modeKnowStatus();
  if (BREACH_CHECK)                    return modeBreachCheck();
  if (COMPLAINTS_MODE)                 return modeComplaints();
  if (CONFIRM_EMAILS)                  return modeConfirmEmails();
  if (REPORT)                          return modeReport();
  if (DOCTOR)                          return modeDoctor();
  if (UPDATE_BROKERS)                  return modeUpdateBrokers();

  setDryRun(DRY_RUN); // makes recordSuccess/saveState no-op-on-disk in dry-run

  if (INSTALL_SCHEDULER)               return modeInstallScheduler();

  const { config, persons } = loadRunnableConfigOrExit();
  const state = loadState();

  if (KNOW_MODE)                       return modeKnow({ config, persons, state });
  return main({ config, persons, state });
}

dispatch().catch(err => {
  console.error('\nFatal:', err && err.message ? err.message : err);
  // A crash text is a real notification: never from a dry run or preview.
  if (!DRY_RUN && notifyConfig) sendText(`❌ Privacy Watcher crashed: ${String(err && err.message).slice(0, 100)}`, notifyConfig);
  process.exit(1);
});
