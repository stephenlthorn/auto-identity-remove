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

const { STATE_PATH, CONFIG_PATH, CONFIG_ENC_PATH, RECHECK_DAYS, loadConfig, loadState, resetState, saveState, recordSuccess, setDryRun, getPersonsFromConfig, loadCheckpoint, saveCheckpoint, clearCheckpoint, findResumeIndex, planResume, readEntry, validateRunnableConfig, stateProblem } = require('./lib/config');
const { results, logResult, buildSummary, setDefunctBrokers, setCurrentPerson, setStateForSummary, setJournal } = require('./lib/logger');
const { findDefunct, DEFUNCT_THRESHOLD } = require('./lib/defunct');
const { sendText, desktopNotify, sendWebhook, dispatchNotify, openInBrowser, canOpenBrowser, pickManualUrlsToOpen, manualUrlsFromResults } = require('./lib/notify');
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
const { buildLaunchOptions, resolveHeadless, isLowMemory, createPersonContexts, utilityProfileDir, browserConfigProblems, describeProxy } = require('./lib/browser');
const { installShutdownHandlers } = require('./lib/shutdown');
const { writePrivateFile, mkdirPrivate } = require('./lib/private-fs');
const { resolveMode } = require('./lib/mode-dispatch');
const { resolvePaths } = require('./lib/paths');
const { openJournal, journalPathFor, countResults } = require('./lib/journal');
const { startHeartbeat, defaultHeartbeatPath, outcomeFromResults } = require('./lib/heartbeat');
const { applyRetention } = require('./lib/retention');
const { isPlaceholderKey, detectAndSolveCaptcha } = require('./lib/captcha');
const { RELAY_BROKER, relaySkippedNames, guardResumePlan } = require('./lib/resume-guard');
const { handleCaptcha, resolveManualMode, manualTimeoutSec, captchaFailureDetail, announceCaptchaWait, captchaBrokersFromLog, captchaConfigWarnings } = require('./lib/manual-captcha');

const PREVIEW           = ARGS.preview;
const DRY_RUN           = ARGS.dryRun; // lib/args: --preview implies --dry-run
const VERIFY            = ARGS.verify;
const SERP_SCAN         = ARGS.serpScan;
const SERP_WATCH        = ARGS.serpWatch;
const INSTALL_SCHEDULER = ARGS.installScheduler;
const DOCTOR            = ARGS.doctor;
const CAPTCHAS          = ARGS.captchas;        // aidr captchas: re-run only what ended on a CAPTCHA, headed
const SOLVE_CAPTCHAS    = ARGS.solveCaptchas;   // wait for a person on a CAPTCHA the solver cannot do
const CONFIG_CHECK      = ARGS.configCheck;
const PURGE             = ARGS.purge;
const SCHEDULE_STATUS   = ARGS.scheduleStatus;
const UNINSTALL_SCHEDULER = ARGS.uninstallScheduler;

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

// Where every runtime file lives is decided once, in lib/paths.js (AIDR_HOME and
// its overrides; with none set, exactly where they always were).
const PATHS = resolvePaths();
const LOCK_PATH = STATE_PATH + '.lock';
const LOG_DIR   = PATHS.logs;

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

/**
 * An error message that is safe to put in the run log: any URL is cut down to its
 * host (a Playwright message can carry the page it was loading, and these URLs hold
 * a person's name and city).
 */
function safeMessage(err) {
  const raw = err && err.message ? err.message : String(err);
  return raw.replace(/https?:\/\/[^\s'")]+/gi, (url) => { try { return new URL(url).hostname; } catch (_) { return 'url'; } })
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

// How many launches in a row may fail before the run stops asking for a browser.
const MAX_BROWSER_LAUNCH_FAILURES = 3;

/**
 * The live browser context for a person, asked for again every time it is needed.
 *
 * The context used to be fetched once per pass, so a Chromium that died in the
 * middle (an out-of-memory kill, a window closed under a headed run) made every
 * later newPage() throw and aborted the whole run (CLI2-5). contexts.forPerson hands
 * back the live one and relaunches a context that has closed, so asking before each
 * broker heals the run. A browser that will not start again is not tried forever:
 * after MAX_BROWSER_LAUNCH_FAILURES failures in a row it throws at once, instead of
 * costing a launch timeout per broker.
 *
 * @param {{ forPerson: (index: number) => Promise<object> }} contexts
 * @returns {(index: number) => Promise<object>}
 */
function makeContextProvider(contexts, { maxFailures = MAX_BROWSER_LAUNCH_FAILURES } = {}) {
  let failures = 0;
  return async function contextFor(index) {
    if (failures >= maxFailures) {
      throw new Error(`the browser failed to start ${failures} times in a row, so it is not being restarted again this run`);
    }
    try {
      const context = await contexts.forPerson(index);
      failures = 0;
      return context;
    } catch (err) {
      failures++;
      throw err;
    }
  };
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
    lock.acquire(lockPath, { refreshMs: lock.refreshIntervalMs() });
  } catch (err) {
    // Only a LockError is "another instance"; a read-only state directory is not
    // (CLI2-9). Both exit 1, with the true reason.
    console.error(lock.describeAcquireFailure(err, lockPath).message);
    process.exit(1);
  }
  // state.json was read when this process started, before the lock. A run that
  // finished in between has saved a newer one, and working from (then saving over)
  // the old copy would resubmit what that run did and drop its entries. In place,
  // so every reference to the state stays valid.
  resetState();
  // A lock older than the max age (default 6 h) is treated as stale whoever holds
  // it, so a live run keeps re-stamping its own: a full run can outlast that.
  const stopRefresh = lock.startRefresh(lockPath);
  const shutdown = installShutdownHandlers({ onShutdown: () => { stopRefresh(); lock.release(lockPath); } });
  shutdown.release = () => {
    stopRefresh();
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

  // A malformed browser section (a typo in "proxy", an unsupported proxy scheme)
  // makes every launch throw rather than start without the proxy (R7). A dry run
  // cannot preview with a browser that will not start, so unlike the placeholder
  // problems this one refuses a dry run too.
  const runnableProblems = validateRunnableConfig(config);
  const browserProblems = browserConfigProblems(config.browser);
  const problems = [...runnableProblems, ...browserProblems];
  if (problems.length > 0) {
    console.error('❌ config is not runnable:\n  - ' + problems.join('\n  - '));
    console.error('   Run `node setup.js` or edit config.json, then re-run.');
    if (!DRY_RUN || browserProblems.length > 0) process.exit(1);
    console.error('   (dry run: continuing so you can preview; nothing is submitted)');
  }
  notifyConfig = config.notify;
  return { config, persons };
}

// A state.json this user cannot read (typically root-owned after a sudo run) loads
// as an empty history, and saveState refuses to replace it (CFG2-2). That refusal
// came after the lock, the browsers and the first broker, and a --confirm-emails run
// had already clicked its link with nothing to record it in. A run that will save
// state stops here instead, with the fix for the permissions; a dry run saves
// nothing, so its callers do not ask.
function exitOnUnreadableState() {
  const problem = stateProblem();
  if (!problem) return;
  console.error(`❌ ${problem.message}`);
  process.exit(1);
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
      // config.json is gone but a copy beside it (.bak, a .tmp from a killed write)
      // could not be removed: that file still holds the PII, so it is named here (CFG2-5).
      if (res.shredded && res.notice) console.log(`   WARNING: ${res.notice}`);
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
  const { findOverdue, findOverdueKnowRequests, formatOverdueKnowNote, complainantFor, buildComplaintsForBroker, writeComplaintFiles } = require('./lib/complaint');

  const { config, persons } = loadConfigOrExit();
  const state   = loadState();
  const brokerMap = new Map(brokers.map(b => [b.name, b]));

  // An unanswered right-to-know request is not a deletion complaint (the tool
  // cannot see whether the broker replied), so it is reported, never filed.
  const knowNote = formatOverdueKnowNote(findOverdueKnowRequests(state, { persons }));
  if (knowNote) console.log('\n' + knowNote);

  const overdueList = findOverdue(state, { persons });
  if (overdueList.length === 0) {
    console.log('\nNo broker qualifies for a complaint: it needs a deletion request past its response window and a verification (run --verify) that your data is still listed.\n');
    process.exit(0);
  }

  // The complainant is the person the composite state key names (B2). A row that
  // names nobody configured is skipped, never filed under the first person: the
  // complaint carries the signer's name, address, email and phone (CFG2-6).
  const complainants = overdueList.map(overdue => ({ overdue, person: complainantFor(overdue, persons) }));
  const unmatched = complainants.filter(c => !c.person);
  if (unmatched.length > 0) {
    console.log(`\nSkipped ${unmatched.length} overdue broker(s) whose person is not in your config (a complaint is signed by the person it is about):`);
    for (const { overdue } of unmatched) console.log(`  - ${overdue.broker}${overdue.person ? ` (${overdue.person})` : ''}`);
  }
  const matched = complainants.filter(c => c.person);
  if (matched.length === 0) {
    console.log('\nNo complaint was written.\n');
    process.exit(0);
  }

  const outDir = PATHS.complaints;
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('Broker', 32) + pad('Regime', 8) + pad('Days overdue', 14) + 'Requested');
  console.log('-'.repeat(78));

  const entries = matched.map(({ overdue, person }) => {
    const broker = brokerMap.get(overdue.broker) || { name: overdue.broker };
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
    // The utility profile: rendering local HTML belongs to no person, and keeping it
    // out of every person's directory means it cannot leave cookies in one (R7).
    context = await chromiumForPdf.launchPersistentContext(utilityProfileDir(profileDirOf(config)), buildLaunchOptions({ headless: true }));
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
  if (!DRY_RUN) exitOnUnreadableState();

  // Acquire the same process lock as the main run - processConfirmationEmails
  // calls recordSuccess -> saveState, so it must not race a concurrent run.
  const guard = acquireRunLock(LOCK_PATH);

  try {
    console.log(`\nProcessing confirmation emails from: ${confirmEmailsDir}`);
    // Confirmation links are broker sites, so the configured proxy and user agent apply;
    // the profile is the utility one, not any person's (R7).
    const context = await chromiumForConfirm.launchPersistentContext(utilityProfileDir(profileDirOf(config)), buildLaunchOptions({ headless: true, browser: config.browser }));
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

    const context = await chromiumForReport.launchPersistentContext(utilityProfileDir(profileDirOf(reportConfig)), buildLaunchOptions({ headless: true }));
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
  const logDir     = PATHS.logs;
  const platform   = getPlatform();
  const result     = installScheduleForPlatform({ platform, scriptPath, logDir });
  // The OS scheduler may have refused (a crontab write that failed, a launchctl
  // load that did not take, no cron in a container). Saying "installed" then left
  // the user with a monthly job that never runs and no way to know (CLI2-4).
  if (!result.ok) {
    console.error(`\nScheduler NOT installed (${result.method}): nothing will run the monthly job.`);
    console.error(`  ${result.detail}\n`);
    process.exit(1);
  }
  console.log(`\nScheduler installed via ${result.method}:`);
  console.log(`  ${result.detail}\n`);
  console.log('  Check it any time with: aidr schedule status\n');
  process.exit(0);
}

// ── --schedule-status: is the monthly job installed, and how did its last run end? ──
// Read-only: it asks the OS scheduler and reads last-run.json, nothing else. Exit
// status is for scripts: 0 installed, active and the last full run did not fail,
// 1 not installed, 2 installed but not active (a job that exists and will not fire
// is worse than one that is absent), 3 installed and active but the last full run
// failed or crashed (a monthly job that breaks every time reads as healthy otherwise).
function modeScheduleStatus() {
  const { getScheduleStatus, formatScheduleStatus } = require('./lib/scheduler');
  const status = getScheduleStatus({ scriptPath: path.join(__dirname, 'run.sh') });
  console.log(ARGS.json ? JSON.stringify(status, null, 2) : '\n' + formatScheduleStatus(status) + '\n');
  const lastRunBroken = Boolean(status.lastRun) && ['failed', 'crashed'].includes(status.lastRun.outcome);
  process.exit(!status.installed ? 1 : status.active === false ? 2 : lastRunBroken ? 3 : 0);
}

// ── --uninstall-scheduler: remove the monthly job (only the one this tool installed) ──
function modeUninstallScheduler() {
  const { uninstallSchedule } = require('./lib/scheduler');
  const result = uninstallSchedule({ scriptPath: path.join(__dirname, 'run.sh') });
  console.log(`\n${result.detail}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const error of result.errors) console.error(`  error: ${error}`);
  console.log('');
  process.exit(result.errors.length > 0 ? 1 : 0);
}

// ── --config-check: every problem in config.json, which files are in use, then exit ──
// Read-only and never exits on a bad config: that is its whole job. Exit 1 when it
// found a problem that would stop a run; warnings alone exit 0.
function modeConfigCheck() {
  const { checkConfig, formatConfigCheck } = require('./lib/config-check');
  const result = checkConfig({ env: process.env });
  for (const line of formatConfigCheck(result)) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

// The config for a mode that can do without one: a missing or unreadable config is
// an exception to catch, not the process.exit loadConfig does.
function readConfigQuietly() {
  if (!fs.existsSync(CONFIG_PATH) && !fs.existsSync(CONFIG_ENC_PATH)) {
    throw Object.assign(new Error('no config'), { code: 'ENOCONFIG' });
  }
  return loadConfig();
}

function askYesNo(question) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

// ── --purge: delete old PII logs, audit reports and screenshots, then exit ───
// Never touches complaints, state, config or the latest run (lib/retention.js).
// Lists what it found first; nothing is deleted without --yes or an answer of y.
async function modePurge() {
  const { resolvePurgeAge, purgeArtifacts, formatPurgeReport } = require('./lib/retention');
  const dirs = { logs: PATHS.logs, snapshots: PATHS.snapshots, reports: PATHS.reports };

  let age;
  try {
    age = resolvePurgeAge({ olderThan: ARGS.olderThan, force: ARGS.force, loadConfig: readConfigQuietly });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
  if (age.note) console.log(`\nNote: ${age.note}`);

  const preview = purgeArtifacts({ dirs, olderThanDays: age.days, force: ARGS.force, dryRun: true });
  console.log('');
  for (const line of formatPurgeReport(preview, { listFiles: true })) console.log(line);
  console.log('');
  if (ARGS.dryRun || preview.deleted.length === 0) process.exit(0);

  if (!ARGS.yes) {
    if (!process.stdin.isTTY) {
      console.error('Not deleting: there is no terminal to confirm on. Re-run with --yes to delete these files.');
      process.exit(2);
    }
    const noun = preview.deleted.length === 1 ? 'file' : 'files';
    if (!(await askYesNo(`Delete these ${preview.deleted.length} ${noun}? [y/N] `))) {
      console.log('Nothing was deleted.');
      process.exit(0);
    }
  }

  const done = purgeArtifacts({ dirs, olderThanDays: age.days, force: ARGS.force, dryRun: false });
  for (const line of formatPurgeReport(done)) console.log(line);
  console.log('');
  process.exit(done.errors.length > 0 ? 1 : 0);
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
    // --only / --skip narrow who is asked, like they narrow a run (CLI2-8).
    const include = modeInclude();
    const selected = brokers.filter(b => include(b.name));
    const emailBrokerCount = selected.filter(b => b.method === 'email').length;
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
      const result = await sendKnowRequests(selected, config, {
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

// A real opt-out run leaves a heartbeat (R4); a preview, a verification and the
// SERP modes do not, so `aidr schedule status` reports when the job last really ran.
const isOptOutRun = () => !DRY_RUN && !VERIFY && !SERP_SCAN && !SERP_WATCH;

// A FILTERED run covers part of the broker list: --only, --skip, --retry-failed,
// --captchas. It must not write or clear the resume checkpoint of an interrupted full
// run, and its heartbeat must not stand in for the monthly run's (CLI2-10). --resume
// is deliberately not one: it finishes the interrupted full run.
const FILTERED = !!(ONLY_ARG || SKIP_ARG || RETRY_FAILED || CAPTCHAS);

// The include test for the modes that act on the broker list but are not the opt-out
// pass: --verify, --serp-scan, --serp-watch, --know and --pollute. They honour --only
// and --skip like the run does; --retry-failed reads a run log none of them has, and
// lib/args.js refuses it with them (CLI2-8).
const modeInclude = () => makeBrokerPredicate({ only: ONLY_ARG, skip: SKIP_ARG });

async function main({ config, persons, state, captchaNames }) {
  const guard = acquireRunLock(LOCK_PATH);
  const heartbeat = isOptOutRun() ? startHeartbeat(defaultHeartbeatPath(), { partial: FILTERED }) : null;
  // Registered first, so it runs after the browser and state cleanups on a signal:
  // an interrupted run says so, instead of reading as a crash later.
  if (heartbeat) guard.register(() => { heartbeat.finish({ outcome: 'failed' }); });
  try {
    const end = await runWithBrowser({ config, persons, state, guard, captchaNames });
    if (heartbeat) {
      const final = end || outcomeFromResults(results);
      heartbeat.finish(final);
      // A run in which every broker errored is a failed run: exit 0 told cron,
      // launchd and `docker run` that it worked (CLI2-3). Some errors beside some
      // progress stay exit 0, since an unreachable site is normal.
      if (final.outcome === 'failed') process.exitCode = 1;
    }
    return end;
  } catch (err) {
    if (heartbeat) heartbeat.finish({ outcome: 'failed' });
    throw err;
  } finally {
    guard.release();
  }
}

async function runWithBrowser({ config, persons, state, guard, captchaNames }) {
  const brokers = require('./brokers');

  console.log('\n🔒 auto-identity-remove - starting run');
  if (PREVIEW)       console.log('👀 PREVIEW - field values and target URLs will be printed before submit. No state will be saved.');
  else if (DRY_RUN)  console.log('🧪 DRY RUN - forms will be filled but NOT submitted. No state will be saved.');
  if (VERIFY)        console.log('🔍 VERIFY - re-checking listings. No forms submitted. Verification results are saved.');
  if (POLLUTE_COUNT) console.log(`⚠️  NOISE MODE - ${POLLUTE_COUNT} bogus record(s) will be submitted to acceptsBogus brokers.`);
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log(`📋 ${brokers.length} explicit brokers + 500+ generic | re-check window: ${RECHECK_DAYS} days\n`);

  brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], personIndex: 0, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config, partial: FILTERED });

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

  // Headless mode: respect HEADLESS env var, else auto-detect.
  // Default to false (headed) on platforms where a display is likely present.
  // In Docker (no $DISPLAY on linux), default to headless: true so the tool actually runs.
  // `aidr captchas` is the exception: it exists so a person can see the window.
  const headlessEnv = process.env.HEADLESS;
  const headless = CAPTCHAS ? false : resolveHeadless();
  console.log(`🖥  Browser mode: ${headless ? 'headless' : 'headed'}${headlessEnv === undefined && process.platform === 'linux' && !CAPTCHAS ? ' (auto-detected)' : ''}${isLowMemory() ? ' [low-memory profile]' : ''} | ${describeProxy(config.browser && config.browser.proxy)}`);

  // CAPTCHAs: decided once, here, from the run's own conditions (R1). The explicit
  // runner and the generic pass both read the answer, so they cannot disagree.
  const captcha = resolveCaptchaPlan({ config, headless });
  brokerRunner.configure({ manual: captcha.manual, headless, isTTY: captcha.isTTY });
  // A mistyped setting is worth knowing about in any run; who would solve a CAPTCHA
  // only matters to a run that submits (a dry run never waits, and --verify and the
  // SERP modes have no forms).
  for (const line of captcha.warnings) console.log(line);
  if (isOptOutRun()) console.log(captcha.modeLine);

  // A signal arriving mid-run saves what has been recorded and closes the
  // browser before the lock goes (the shutdown runs these last-registered first).
  guard.register(() => { if (!DRY_RUN) saveState(); });

  // One browser profile and one context PER PERSON (R7): cookies and logins that a
  // broker learned about person A never reach person B. Contexts are launched when
  // a person's turn comes and the previous one is closed first, so a small NAS still
  // runs one Chromium at a time. The launch options are built per launch.
  const contexts = createPersonContexts({
    chromium,
    baseDir: profileDirOf(config),
    persons,
    launchOptions: () => buildLaunchOptions({ headless, browser: config.browser }),
    prepare: async (context) => {
      tuneContext(context);
      await context.addInitScript(buildStealthScript());
    },
  });
  guard.register(() => contexts.close());

  try {
    if (VERIFY)     return await runVerifyMode(contexts, { brokers, persons, state, config });
    if (SERP_SCAN)  return await runSerpScanMode(contexts, { brokers, persons });
    if (SERP_WATCH) return await runSerpWatchMode(contexts, { brokers, persons, config });
    return await runSubmissions(contexts, { brokers, persons, state, config, guard, captchaNames, captcha, headless });
  } finally {
    await contexts.close();
  }
}

/**
 * Whether a person may be asked to solve a CAPTCHA this run, and the lines that say
 * so. `--captchas` and `--solve-captchas` force it on (headed only: nobody can solve
 * a CAPTCHA in a window they cannot see, so headless is always off). Without either,
 * captcha.manual decides: "auto" means a headed browser and an interactive terminal.
 */
function resolveCaptchaPlan({ config, headless }) {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const hasSolverKey = Boolean(config.capsolver && config.capsolver.apiKey && !isPlaceholderKey(config.capsolver.apiKey));
  const manual = resolveManualMode({ config, headless, isTTY, hasSolverKey, force: Boolean(CAPTCHAS || SOLVE_CAPTCHAS) });
  const seconds = manualTimeoutSec(config);
  const wait = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;

  const warnings = captchaConfigWarnings(config).map(w => `⚠️  config: ${w}`);
  let modeLine;
  if (manual) {
    modeLine = `🧩 CAPTCHAs: ${hasSolverKey && !NO_CAPSOLVER ? 'CapSolver first, then ' : ''}you solve them in the browser window (up to ${wait} each)`;
  } else if ((CAPTCHAS || SOLVE_CAPTCHAS) && headless) {
    modeLine = '🧩 CAPTCHAs: --solve-captchas needs a visible browser and this run is headless, so none can be solved by hand';
  } else if (headless) {
    modeLine = '🧩 CAPTCHAs: no display here, so a CAPTCHA the solver cannot do is listed at the end. Solve them on a desktop machine with: aidr captchas';
  } else {
    modeLine = `🧩 CAPTCHAs: solver only (${isTTY ? 'captcha.manual is false' : 'no interactive terminal'}). To solve them yourself afterwards: aidr captchas`;
  }
  return { manual, isTTY, warnings, modeLine };
}

// ── Verify mode: T+7 post-submit verification loop ───────────────────────────
async function runVerifyMode(contexts, { brokers, persons, state, config }) {
  const { runVerify } = require('./lib/verify-loop');
  // Each person is searched with THEIR OWN broker list: brokers.js bakes the
  // person's name and city into searchUrl, so a shared list recorded person B as
  // verified clear from person A's search. And from THEIR OWN browser profile:
  // contextFor hands out one person's context at a time (R7).
  // --only / --skip narrow what is re-checked (CLI2-8).
  const include = modeInclude();
  const result = await runVerify(null, brokers.filter(b => include(b.name)), persons, {
    state,
    config,
    brokersFor: (person) => brokers.forPerson(person).filter(b => include(b.name)),
    contextFor: (person, index) => contexts.forPerson(index),
  });
  saveState();
  await contexts.close();

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
async function runSerpScanMode(contexts, { brokers, persons }) {
  const { runSerpScan, describeScanOutcome } = require('./lib/serp-scan');
  console.log('\n🔎 SERP scan - checking broker visibility in search engines');
  console.log('   DDG first, then Bing, then Google (may be blocked).\n');
  // One scan covers every person's name, from the first person's profile.
  const context = await contexts.forPerson(0);
  const include = modeInclude();
  const summary = await runSerpScan(context, persons, brokers.filter(b => include(b.name)), { _skipWrite: DRY_RUN });
  await contexts.close();

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
async function runSerpWatchMode(contexts, { brokers, persons, config }) {
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
  const context = await contexts.forPerson(0);
  const include = modeInclude();
  const watch = await runSerpWatch(context, persons, brokers.filter(b => include(b.name)), watchOptions);
  await contexts.close();

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
async function runSubmissions(contexts, { brokers, persons, state, config, guard, captchaNames, captcha, headless }) {
  // Timestamped to the second (B8): two runs on the same day must not overwrite
  // each other, otherwise loadPreviousLog/diffResults can never diff intraday runs.
  const logFile = path.join(LOG_DIR, `run-${timestampForFilename(new Date().toISOString())}.json`);
  const journalFile = journalPathFor(logFile);
  const stamp = () => new Date().toLocaleTimeString();

  // A filtered, resumed or CAPTCHA-only run covers part of the broker list, so its
  // log is marked: diffing the next full run against it would report hundreds of
  // "newly removed" brokers. The same marker goes in the journal.
  const partial = !!(ONLY_ARG || SKIP_ARG || RETRY_FAILED || RESUME || CAPTCHAS);
  const runFilter = { only: ONLY_ARG || null, skip: SKIP_ARG || null, retryFailed: !!RETRY_FAILED, resume: !!RESUME, ...(CAPTCHAS ? { captchas: true } : {}) };

  // ── Resolve the --retry-failed / --captchas broker set ─────────────────────
  let retryFailedFromLog;
  if (CAPTCHAS) {
    // Read from the last run before the browser was launched (dispatch).
    retryFailedFromLog = captchaNames;
    console.log(`🧩 --captchas: ${retryFailedFromLog.size} broker(s) ended on a CAPTCHA last run`);
  } else if (RETRY_FAILED) {
    // exclude: a run in progress already has a journal on disk and must never be
    // its own retry source.
    const log = loadLastLog(LOG_DIR, { exclude: logFile });
    if (!log) {
      console.log('⚠️  --retry-failed: no previous log found in the log directory - running all brokers.');
    } else {
      retryFailedFromLog = extractFailedBrokers(log);
      console.log(`🔄 --retry-failed: ${retryFailedFromLog.size} broker(s) from last log`);
      if (log.source === 'journal') {
        console.log('   That run crashed before it wrote its log, so this list comes from its journal: brokers it never reached are not in it. Use --resume to carry on where it stopped.');
      }
    }
  }

  // ONE include test for the whole run: the email opt-outs, the explicit forms
  // and the ~490 generic brokers all honour --only / --skip / --retry-failed.
  // They used to filter only the explicit list, so `--only Spokeo` still sent
  // every opt-out email and ran the whole generic pass (CORE-4).
  const include = makeBrokerPredicate({ only: ONLY_ARG, skip: SKIP_ARG, retryFailedFromLog });

  // --resume: what the checkpoint proves is already done, per person (R2). The
  // explicit pass and the generic pass of every person come back to where they stopped.
  const savedCheckpoint = RESUME ? loadCheckpoint() : null;
  if (RESUME && !savedCheckpoint) console.log('\n--resume: no checkpoint found, running all brokers');
  // planResume infers from a generic-phase checkpoint that every explicit pass ended,
  // which is false for a person the interrupted run skipped because the relay was
  // down. Take back every skip it made for someone the run's own record names.
  const resumePlan = guardResumePlan(
    planResume(savedCheckpoint, persons),
    persons,
    savedCheckpoint ? relaySkippedNames(LOG_DIR, { exclude: logFile }) : new Set(),
  );
  const planFor = (i) => resumePlan[i] || { skipExplicit: false, explicitResumeKey: null, skipGeneric: false, genericResume: null };

  // The crash-safe journal (R3): every result is appended as it happens, so a kill
  // or an OOM leaves a log --retry-failed and `aidr captchas` can read. Opened before
  // anything is logged (the relay failures below are results too) and never in a dry run.
  let journal = null;
  if (!DRY_RUN) {
    mkdirPrivate(LOG_DIR);
    journal = openJournal(journalFile, { startedAt: results.runAt, mode: 'run', partial, filter: runFilter });
    setJournal(journal);
    guard.register(() => {
      journal.close({ interrupted: true, counts: countResults(results) });
      setJournal(null);
    });
  }

  // The email each person submits with, resolved once (masked alias when a relay
  // is configured). A person the relay cannot serve is skipped everywhere below.
  const { emails: submissionEmails, unavailable } = await resolveRelayEmails({ config, persons, state });
  const relaySkipped = new Set(unavailable.map(u => u.person));
  for (const { person, message } of unavailable) {
    setCurrentPerson(person);
    logResult(
      RELAY_BROKER,
      'error',
      `unavailable (${message}); nothing was submitted for ${personName(person)}. Re-run once it works (a plain run: --retry-failed will not revisit them), or set relay.failOpen: true to send the real email`
    );
  }
  setCurrentPerson(null);
  if (relaySkipped.size > 0) process.exitCode = 1;

  const contextFor = makeContextProvider(contexts);

  for (const [index, person] of persons.entries()) {
    if (relaySkipped.has(person)) continue;

    if (planFor(index).skipExplicit) {
      console.log(`\n--resume: the explicit pass for ${personName(person)} is already done, skipping`);
      continue;
    }

    // Everything logged below is tagged with this person, so a two-person run is
    // not one anonymous list (CFG-13).
    setCurrentPerson(person);

    if (persons.length > 1) {
      console.log(`\n${'='.repeat(54)}`);
      console.log(`Running for: ${personName(person)}`);
      console.log('='.repeat(54));
    }

    const submissionEmail = submissionEmails.get(person);
    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, personIndex: index, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config, submissionEmail, partial: FILTERED });

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
      // Only the person the explicit checkpoint belongs to resumes mid-list; planResume
      // matched it by the composite "Broker|First Last" key (B22), so a bare-name
      // compare cannot miss it and silently re-run everything.
      const resumeKey = planFor(index).explicitResumeKey;
      if (resumeKey) {
        const ckptIdx = findResumeIndex(sorted, resumeKey, person, persons.length);
        if (ckptIdx > 0) {
          console.log(`\n--resume: skipping ${ckptIdx} broker(s) before "${resumeKey}"`);
          sorted = sorted.slice(ckptIdx);
        } else if (ckptIdx === -1) {
          console.log(`\n--resume: checkpoint broker "${resumeKey}" not found in list, running all`);
        }
      }
    }

    if (ONLY_ARG || SKIP_ARG || RETRY_FAILED || CAPTCHAS) {
      console.log(`🔎 Filter applied - ${sorted.length} broker(s) will run`);
    }

    console.log('\n── Explicit broker opt-outs ───────────────────────────────');
    // This person's own browser, launched only when there is something to open it for.
    // Asked for again before EVERY broker: a Chromium that died mid-pass is relaunched
    // here instead of failing every later newPage() (CLI2-5), and a broker whose
    // browser cannot be had is an error of its own, not the end of the run.
    for (const broker of sorted) {
      process.stdout.write(`\n[${stamp()}] ${broker.name}… `);
      try {
        const context = await contextFor(index);
        await brokerRunner.processBroker(context, broker);
      } catch (err) {
        logResult(broker.name, 'error', `browser unavailable (${safeMessage(err)}); this broker was not tried`);
      }
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
    // The run's own include test: --only / --skip narrow the noise like everything else
    // (it used to go to every acceptsBogus broker whatever --only said: CLI2-8).
    const bogBrokers = brokers.filter(b => b.acceptsBogus === true && include(b.name));

    if (bogBrokers.length === 0) {
      console.log(`\n⚠️  --pollute: no brokers tagged acceptsBogus: true${ONLY_ARG || SKIP_ARG || RETRY_FAILED ? ' that match the filter' : ''} - nothing to do.`);
    } else {
      console.log(`\n── Noise mode - submitting ${POLLUTE_COUNT} bogus record(s) to ${bogBrokers.length} broker(s) ─`);
      // The browser of the last person served, so the noise needs no extra launch.
      // Asked for again per broker, like the real pass: a dead Chromium is relaunched.
      noise: for (let i = 0; i < POLLUTE_COUNT; i++) {
        const fakePerson = generateBogusPerson();
        console.log(`\n   [bogus ${i + 1}/${POLLUTE_COUNT}] ${fakePerson.firstName} ${fakePerson.lastName} (${fakePerson.city}, ${fakePerson.state})`);
        for (const broker of bogBrokers) {
          process.stdout.write(`     ${broker.name}… `);
          try {
            const context = await contextFor(persons.length - 1);
            await brokerRunner.processBrokerWithPerson(context, broker, fakePerson, { noState: true });
          } catch (err) {
            // Noise is optional: no browser means no more of it, not a failed run.
            console.log(`browser unavailable (${safeMessage(err)}); stopping noise mode`);
            break noise;
          }
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

  // A CAPTCHA in front of a generic form goes to the same solver, and the same wait
  // for a person, that the explicit runner uses (R1, R2). `manual` was decided once
  // for the whole run, and an unsolved one is worded exactly like an explicit one.
  const timeoutSec = manualTimeoutSec(config);
  const genericHandleCaptcha = (page, ctx) => handleCaptcha(page, {
    capsolver: NO_CAPSOLVER ? null : config.capsolver,
    manual: captcha.manual,
    onWaiting: (info) => announceCaptchaWait(info, { notify: desktopNotify }),
    timeoutMs: timeoutSec * 1000,
    solve: detectAndSolveCaptcha,
    ...ctx,
  });
  const genericCaptchaDetail = ({ outcome, broker }) => captchaFailureDetail({
    outcome,
    url: broker && broker.url,
    timeoutSec,
    headless,
    isTTY: captcha.isTTY,
    config,
    noSolver: NO_CAPSOLVER,
  });

  const genericTotals = {};
  for (const [index, person] of persons.entries()) {
    if (relaySkipped.has(person)) continue;
    const resume = planFor(index);
    if (resume.skipGeneric) {
      console.log(`\n--resume: the generic pass for ${personName(person)} is already done, skipping`);
      continue;
    }
    setCurrentPerson(person);
    if (persons.length > 1) {
      console.log(`\n── Generic brokers for ${personName(person)} ──`);
    }
    // The pass starts with this person's live browser; getContext (below) lets it ask
    // again when that browser dies part-way through the ~490 rows.
    let context;
    try {
      context = await contextFor(index);
    } catch (err) {
      logResult('Generic brokers', 'error', `browser unavailable (${safeMessage(err)}); the generic pass for ${personName(person)} was not run`);
      continue;
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
      // R2: write a resume point as the pass advances, and pick one back up. A filtered
      // run writes none: its rows are not the interrupted full run's, and a checkpoint
      // of its own would replace the one a killed full run is waiting on (CLI2-10).
      ...(FILTERED ? {} : { saveCheckpoint }),
      resumeFrom: resume.genericResume || undefined,
      // The checkpoint lists the rows this pass finished, so a --resume after a feed
      // update skips exactly those instead of "everything above the key" (BRK2-9).
      checkpointDone: true,
      handleCaptcha: genericHandleCaptcha,
      captchaFailureDetail: genericCaptchaDetail,
      getContext: () => contextFor(index),
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
  // so a preview never deletes the checkpoint of an interrupted real run). A filtered
  // run leaves it: the checkpoint belongs to a full run that may still be resumed.
  if (!FILTERED) clearCheckpoint();

  await contexts.close();

  // Save run log (skipped in dry-run); `partial` and `runFilter` were fixed at the top.
  const logBody = partial ? { ...results, partial: true, filter: runFilter } : results;
  if (!DRY_RUN) {
    // The log holds the user's name and the brokers that hold their data.
    mkdirPrivate(LOG_DIR);
    writePrivateFile(logFile, JSON.stringify(logBody, null, 2));
    // The summary is the record now; the journal is closed with the same counts.
    journal.close({ counts: countResults(results) });
    setJournal(null);
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

    // retention.days (R6): drop PII artifacts older than the configured age, but never
    // this run's own log, journal and audit report. A purge hiccup never fails the run.
    const retention = applyRetention({
      config,
      dirs: { logs: PATHS.logs, snapshots: PATHS.snapshots, reports: PATHS.reports },
      keep: [logFile, journalFile, auditPath],
      dryRun: DRY_RUN,
    });
    for (const line of retention.lines) console.log(line);
  }

  // Manual-required sites: open them when a desktop is there to show them, and
  // never in a dry run. A headless host has no browser to open.
  const manualUrls = manualUrlsFromResults([...results.captchaFailed, ...results.manual]);
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
  if (results.captchaFailed.length > 0) {
    console.log(`\n🧩 ${results.captchaFailed.length} broker(s) ended on a CAPTCHA. Solve them now: aidr captchas${headless ? ' (on a desktop machine: this run had no display)' : ''}`);
  }

  // Print summary (with the drift section, which needs the state)
  setStateForSummary(state);
  const summary = buildSummary();
  console.log('\n' + '═'.repeat(54));
  console.log(summary);
  console.log('═'.repeat(54));
  console.log(DRY_RUN ? '\n📄 Log: not written (dry run)' : `\n📄 Log: ${logFile}`);
  console.log(DRY_RUN ? '💾 State: not saved (dry run)\n' : `💾 State: ${STATE_PATH}\n`);

  // A dry run or preview must not text anyone, raise a desktop notification or
  // POST the webhook.
  if (DRY_RUN) return null;

  // "Submitted" is not "removed": a form that was accepted may still need an
  // email click, and brokers re-list people. The wording says what happened.
  const end = outcomeFromResults(results);
  const failed = end.outcome === 'failed';
  const manualCount = results.captchaFailed.length + results.manual.length;
  const totalProcessed = results.succeeded.length + results.pendingConfirm.length + results.unverified.length
    + results.skipped.length + results.notFound.length + manualCount + results.errors.length + results.dead.length;
  const short = [
    failed
      ? `❌ Privacy Watcher FAILED (${new Date().toLocaleDateString()}): every broker ended in an error, so nothing was submitted.`
      : `🔒 Privacy Watcher (${new Date().toLocaleDateString()}):`,
    `✅ Submitted: ${results.succeeded.length}`,
    `📧 Awaiting email confirm: ${results.pendingConfirm.length}`,
    `❓ Unconfirmed: ${results.unverified.length}`,
    `⏭  Skipped: ${results.skipped.length}`,
    `📋 Manual: ${manualCount}`,
    ...(results.errors.length > 0 ? [`❌ Errors: ${results.errors.length}`] : []),
    `📊 Total: ${totalProcessed} brokers checked`,
  ].join('\n');
  sendText(short, config.notify);
  desktopNotify('Privacy Watcher', failed
    ? `Failed - every broker errored (${results.errors.length} errors, ${totalProcessed} total). Nothing was submitted.`
    : `Done - ${results.succeeded.length} submitted, ${results.pendingConfirm.length} awaiting email confirmation, ${manualCount} need manual action (${totalProcessed} total)`);
  // notify.webhook is documented as POSTed after every run; only serp-watch ever
  // sent it (CLI2-3). Awaited, with its own deadline (lib/notify.js).
  if (config.notify && config.notify.webhook) await sendWebhook(config.notify.webhook, short);
  return end;
}

// ── aidr captchas: which brokers to go back to ───────────────────────────────

/**
 * The brokers the last run left on a CAPTCHA, or null when there is nothing to do.
 *
 * Read from the newest run log (or its journal, when that run crashed) BEFORE the
 * lock, the browser or the relay are touched: with nothing to solve there is no
 * reason to open a window, and with no display there is no way to solve anything,
 * so both are said plainly and at once.
 */
function resolveCaptchaRetry() {
  const log = loadLastLog(LOG_DIR);
  const names = log ? captchaBrokersFromLog(log) : new Set();
  if (names.size === 0) {
    console.log(log
      ? '\nNo brokers ended on a CAPTCHA in the last run.\n'
      : '\nNo previous run found in the log directory, so there is no CAPTCHA to solve.\n');
    return null;
  }
  if (!canOpenBrowser()) {
    console.error('aidr captchas needs a display to show the CAPTCHAs. Run it on a desktop machine.');
    process.exit(1);
  }
  return names;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch() {
  // The pair gets its own, plainer wording; resolveMode would refuse it as well.
  if (ARGS.allow !== null && ARGS.unallow !== null) {
    console.error('Error: --allow and --unallow cannot be combined. Use one at a time.');
    process.exit(2);
  }

  // Combining modes is ambiguous (--list --score would silently run only one).
  // Checked before any mode runs; exit 2 like any other bad command line.
  const { conflict } = resolveMode({ ...ARGS, freeze: FREEZE_MODE });
  if (conflict) {
    console.error(`Error: ${conflict}`);
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
  if (CONFIG_CHECK)                    return modeConfigCheck();
  if (PURGE)                           return modePurge();
  if (SCHEDULE_STATUS)                 return modeScheduleStatus();
  if (UNINSTALL_SCHEDULER)             return modeUninstallScheduler();

  setDryRun(DRY_RUN); // makes recordSuccess/saveState no-op-on-disk in dry-run

  if (INSTALL_SCHEDULER)               return modeInstallScheduler();

  let captchaNames = null;
  if (CAPTCHAS) {
    captchaNames = resolveCaptchaRetry();
    if (captchaNames === null) return;
  }

  const { config, persons } = loadRunnableConfigOrExit();
  if (!DRY_RUN) exitOnUnreadableState();
  const state = loadState();

  if (KNOW_MODE)                       return modeKnow({ config, persons, state });
  return main({ config, persons, state, captchaNames });
}

dispatch().catch(async err => {
  console.error('\nFatal:', err && err.message ? err.message : err);
  // A crash is a real notification, on every channel the user set up (iMessage, a
  // desktop toast, notify.webhook): never from a dry run or preview. dispatchNotify
  // never throws, and its webhook POST has a deadline, so this cannot hang the exit.
  if (!DRY_RUN && notifyConfig) {
    try {
      await dispatchNotify(`❌ Privacy Watcher crashed: ${String(err && err.message).slice(0, 100)}`, { notify: notifyConfig });
    } catch (_) { /* a notification that fails must not mask the crash */ }
  }
  process.exit(1);
});
