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

const { STATE_PATH, RECHECK_DAYS, loadConfig, loadState, saveState, recordSuccess, setDryRun, getPersonsFromConfig, loadCheckpoint, clearCheckpoint, findResumeIndex } = require('./lib/config');
const { results, logResult, buildSummary, setDefunctBrokers } = require('./lib/logger');
const { findDefunct, DEFUNCT_THRESHOLD } = require('./lib/defunct');
const { sendText, desktopNotify, openInBrowser } = require('./lib/notify');
const brokerRunner = require('./lib/broker-runner');
const { sendOptOutEmails } = require('./lib/email');
const { getSubmissionEmail } = require('./lib/relay');
const lock = require('./lib/lock');
const { applyFilter, loadLastLog, extractFailedBrokers } = require('./lib/filter');
const { addToAllowlist, removeFromAllowlist, parseAllowlistArgs } = require('./lib/allowlist-edit');
const { diffResults, loadPreviousLog } = require('./lib/diff');
const { renderAuditMarkdown, writeAuditFile, timestampForFilename } = require('./lib/audit');
const { buildStealthScript } = require('./lib/stealth');

const PREVIEW           = process.argv.includes('--preview');
const DRY_RUN           = process.argv.includes('--dry-run') || PREVIEW; // --preview implies --dry-run
const VERIFY            = process.argv.includes('--verify');
const SERP_SCAN         = process.argv.includes('--serp-scan');
const SERP_WATCH        = process.argv.includes('--serp-watch');
const INSTALL_SCHEDULER = process.argv.includes('--install-scheduler');
const DOCTOR            = process.argv[2] === 'doctor' || process.argv.includes('--doctor');

// ── Filter flags ──────────────────────────────────────────────────────────────
const onlyIdx   = process.argv.indexOf('--only');
const ONLY_ARG  = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] || '') : null;
const skipIdx   = process.argv.indexOf('--skip');
const SKIP_ARG  = skipIdx !== -1 ? (process.argv[skipIdx + 1] || '') : null;
const RETRY_FAILED = process.argv.includes('--retry-failed');
const LIST_MODE    = process.argv.includes('--list');
const SCORE_MODE   = process.argv.includes('--score');

const PENDING_MODE    = process.argv.includes('--pending');
const UPDATE_BROKERS  = process.argv.includes('--update-brokers');
const BREACH_CHECK    = process.argv.includes('--breach-check');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
const REPORT          = process.argv.includes('--report');

// -- Config-encryption migration flags (run before any pipeline work) ---------
const ENCRYPT_CONFIG  = process.argv.includes('--encrypt-config');
const DECRYPT_CONFIG  = process.argv.includes('--decrypt-config');
const KEEP_PLAINTEXT  = process.argv.includes('--keep-plaintext');
const KNOW_MODE       = process.argv.includes('--know');
const KNOW_STATUS     = process.argv.includes('--know-status');
const COMPLAINTS_MODE = process.argv.includes('--complaints');

// ── Credit / identity freeze guided checklist ────────────────────────────────
const FREEZE_LIST = process.argv.includes('--freeze');
const freezeDoneIdx  = process.argv.indexOf('--freeze-done');
const FREEZE_DONE_KEY  = freezeDoneIdx !== -1 ? (process.argv[freezeDoneIdx + 1] || '') : null;
const freezeClearIdx = process.argv.indexOf('--freeze-clear');
const FREEZE_CLEAR_KEY = freezeClearIdx !== -1 ? (process.argv[freezeClearIdx + 1] || '') : null;
const FREEZE_MODE = FREEZE_LIST || FREEZE_DONE_KEY !== null || FREEZE_CLEAR_KEY !== null;

// ── --confirm-emails [dir]: auto-click confirmation links in .eml files ───────
const confirmEmailsIdx = process.argv.indexOf('--confirm-emails');
const CONFIRM_EMAILS = confirmEmailsIdx !== -1;
// Optional dir argument: next argv element if it doesn't start with '--'
const confirmEmailsDir = (() => {
  if (!CONFIRM_EMAILS) return './inbox/confirms';
  const next = process.argv[confirmEmailsIdx + 1];
  return (next && !next.startsWith('--')) ? next : './inbox/confirms';
})();

// ── --freeze / --freeze-done <key> / --freeze-clear <key> ─────────────────────
// Guided credit/identity freeze checklist. Pure guidance + tracking; no browser
// is launched. Subcommands persist state.freezes under the same state lock as a
// normal run so a concurrent run cannot race the write.
if (FREEZE_MODE) {
  const { FREEZE_TARGETS, getFreezeStatus, recordFreezeDone, recordFreezeCleared, TARGET_KEYS } = require('./lib/freeze');
  const state = loadState();

  // Mutating subcommands take the lock; the read-only list does not need it.
  const isMutation = FREEZE_DONE_KEY !== null || FREEZE_CLEAR_KEY !== null;
  const FREEZE_LOCK_PATH = STATE_PATH + '.lock';
  if (isMutation) {
    try {
      lock.acquire(FREEZE_LOCK_PATH);
    } catch (err) {
      const pidMatch = err.message.match(/pid (\d+)/);
      console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
      process.exit(1);
    }
  }

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
    if (isMutation) lock.release(FREEZE_LOCK_PATH);
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
if (ENCRYPT_CONFIG || DECRYPT_CONFIG) {
  const { encryptConfigToDisk, decryptConfigToDisk, getPassphrase, PASSPHRASE_ENV } = require('./lib/config');
  if (!getPassphrase()) {
    console.error(`No passphrase. Set ${PASSPHRASE_ENV} (export ${PASSPHRASE_ENV}=...) and re-run.`);
    process.exit(1);
  }
  try {
    if (ENCRYPT_CONFIG) {
      const res = encryptConfigToDisk({ shred: !KEEP_PLAINTEXT });
      console.log(`\nEncrypted config written to ${res.encPath}`);
      console.log(res.shredded
        ? '   Plaintext config.json shredded.'
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

// ── --score: print the exposure score + breakdown + trend, then exit ─────────
// Read-only: no browser, no forms submitted. Reads state.json and the
// persisted SERP history; persists a dated snapshot to data/exposure-history.json.
if (SCORE_MODE) {
  const brokers = require('./brokers');
  const state   = loadState();
  const {
    computeExposureScore,
    serpResultsFromHistory,
    loadExposureHistory,
    snapshotExposure,
    formatScoreReport,
  } = require('./lib/exposure');

  // Reconstruct the SERP signal from persisted history (no live scan).
  let serpRows = [];
  const serpHistoryPath = path.join(__dirname, 'data', 'serp-history.json');
  try {
    serpRows = JSON.parse(fs.readFileSync(serpHistoryPath, 'utf8'));
    if (!Array.isArray(serpRows)) serpRows = [];
  } catch (_) { serpRows = []; }
  const serpResults = serpResultsFromHistory(serpRows);

  // breachCount defaults to 0 until HIBP integration lands.
  const summary = computeExposureScore({ state, serpResults, breachCount: 0, brokers });

  const priorHistory = loadExposureHistory();
  console.log('\n' + formatScoreReport(summary, priorHistory));
  // Persist this run's snapshot (skipped in dry-run to honor that contract).
  if (!DRY_RUN) snapshotExposure(summary);
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

// ── --allow / --unallow <name>: edit config.json allowlist, then exit ────────
const _allowlistCmd = parseAllowlistArgs(process.argv);
if (_allowlistCmd) {
  const { CONFIG_PATH } = require('./lib/config');
  if (_allowlistCmd.error || !_allowlistCmd.name) {
    console.error(`❌ ${_allowlistCmd.action === 'unallow' ? '--unallow' : '--allow'} requires a broker name, e.g. --${_allowlistCmd.action} Spokeo`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`❌ could not read config.json: ${err.message}`);
    process.exit(1);
  }
  const next = _allowlistCmd.action === 'allow'
    ? addToAllowlist(cfg, _allowlistCmd.name)
    : removeFromAllowlist(cfg, _allowlistCmd.name);
  // Atomic write: tmp -> rename (mirrors lib/config.js saveState semantics).
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  const verb = _allowlistCmd.action === 'allow' ? 'Added to' : 'Removed from';
  console.log(`\n📌 ${verb} allowlist: ${_allowlistCmd.name}`);
  console.log(`   Allowlist now: ${(next.allowlist || []).join(', ') || '(empty)'}\n`);
  process.exit(0);
}

// -- --know-status: print right-to-know requests older than 45 days, then exit -
if (KNOW_STATUS) {
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

// ── Mode-conflict guard ───────────────────────────────────────────────────────
// Detect mutually exclusive mode flags being combined (e.g. --doctor --report).
// Each documented mode exits after doing its work; combining them is ambiguous.
{
  const { resolveMode } = require('./lib/mode-dispatch');
  const { conflict } = resolveMode({
    list:             LIST_MODE,
    score:            SCORE_MODE,
    report:           REPORT,
    doctor:           DOCTOR,
    breachCheck:      BREACH_CHECK,
    updateBrokers:    UPDATE_BROKERS,
    pending:          PENDING_MODE,
    know:             KNOW_MODE,
    knowStatus:       KNOW_STATUS,
    complaints:       COMPLAINTS_MODE,
    confirmEmails:    CONFIRM_EMAILS,
    serpScan:         SERP_SCAN,
    serpWatch:        SERP_WATCH,
    installScheduler: INSTALL_SCHEDULER,
    encryptConfig:    ENCRYPT_CONFIG,
    decryptConfig:    DECRYPT_CONFIG,
    freeze:           FREEZE_MODE,
  });
  if (conflict) {
    console.error(`Error: ${conflict}`);
    process.exit(1);
  }
}

// ── --breach-check: query Have I Been Pwned for configured emails, then exit ─
if (BREACH_CHECK) {
  const brokers = require('./brokers');
  const {
    collectEmails,
    missingKeyMessage,
    runBreachCheck,
    formatBreachReport,
  } = require('./lib/hibp');

  const cfg     = loadConfig();
  const persons = getPersonsFromConfig(cfg);
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

  (async () => {
    console.log(`\nChecking ${emails.length} email(s) against Have I Been Pwned...`);
    const result = await runBreachCheck({ emails, apiKey, brokers });
    console.log('\n' + formatBreachReport(result) + '\n');
    process.exit(0);
  })().catch(err => {
    console.error('breach-check error:', err.message);
    process.exit(1);
  });
} else {

// ── --complaints: generate regulator complaints for brokers past the legal
//    response window (CCPA 45d / GDPR 30d) and write text + PDF to logs/. ─────
if (COMPLAINTS_MODE) {
  const brokers = require('./brokers');
  const { findOverdue, buildComplaintsForBroker, writeComplaintFiles } = require('./lib/complaint');

  const config  = loadConfig();
  const state   = loadState();
  const persons = getPersonsFromConfig(config);
  const brokerMap = new Map(brokers.map(b => [b.name, b]));
  // Resolve the complaint's complainant back to the person named in the
  // composite state key (B2); fall back to the first person for bare keys.
  const personByName = new Map(
    persons
      .filter(p => p && (p.firstName || p.lastName))
      .map(p => [`${p.firstName || ''} ${p.lastName || ''}`.trim(), p])
  );

  const overdueList = findOverdue(state, { persons });
  if (overdueList.length === 0) {
    console.log('\nNo brokers are past their legal response window. Nothing to escalate.\n');
    process.exit(0);
  }

  const outDir = path.join(__dirname, 'logs', 'complaints');
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
    return { broker: overdue.broker, complaints: buildComplaintsForBroker({ person, broker, overdue }) };
  });

  (async () => {
    let newPage;
    let context;
    if (!DRY_RUN) {
      let chromiumForPdf;
      try {
        ({ chromium: chromiumForPdf } = require('playwright'));
      } catch (_) {
        const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
        ({ chromium: chromiumForPdf } = require(fallback));
      }
      const profileDirForPdf = (config.profileDir || '~/.config/auto-identity-remove')
        .replace(/^~(?=\/|$)/, os.homedir());
      context = await chromiumForPdf.launchPersistentContext(profileDirForPdf, {
        headless: true,
        viewport: { width: 1280, height: 900 },
      });
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
  })().catch(err => {
    console.error('complaints error:', err.message);
    process.exit(1);
  });
} else

// ── --confirm-emails [dir]: process .eml files and auto-click confirm links ───
if (CONFIRM_EMAILS) {
  const brokers = require('./brokers');
  const { processConfirmationEmails } = require('./lib/imap-confirm');

  // Launch a minimal headless browser context just for navigating confirm links
  let chromiumForConfirm;
  try {
    ({ chromium: chromiumForConfirm } = require('playwright'));
  } catch (_) {
    const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
    ({ chromium: chromiumForConfirm } = require(fallback));
  }

  const profileDirForConfirm = (loadConfig().profileDir || '~/.config/auto-identity-remove')
    .replace(/^~(?=\/|$)/, os.homedir());

  // Acquire the same process lock as main() - processConfirmationEmails calls
  // recordSuccess -> saveState, so it must not race a concurrent normal run.
  const CONFIRM_LOCK_PATH = STATE_PATH + '.lock';
  try {
    lock.acquire(CONFIRM_LOCK_PATH);
  } catch (err) {
    const pidMatch = err.message.match(/pid (\d+)/);
    console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
    process.exit(1);
  }

  (async () => {
    console.log(`\nProcessing confirmation emails from: ${confirmEmailsDir}`);
    const context = await chromiumForConfirm.launchPersistentContext(profileDirForConfirm, {
      headless: true,
      viewport: { width: 1280, height: 900 },
    });

    try {
      const result = await processConfirmationEmails(context, brokers, {
        dir: confirmEmailsDir,
        dryRun: DRY_RUN,
      });

      for (const entry of result.processed) {
        console.log(`  confirmed: ${entry.broker.name} -> ${entry.url}`);
      }
      for (const entry of result.unmatched) {
        console.log(`  unmatched (${entry.reason}): ${entry.file}`);
      }
      for (const entry of result.failed) {
        console.log(`  failed: ${entry.broker.name} -> ${entry.error}`);
      }

      const total = result.processed.length + result.unmatched.length + result.failed.length;
      console.log(`\nDone: ${result.processed.length} confirmed, ${result.unmatched.length} unmatched, ${result.failed.length} failed (${total} .eml files)\n`);
    } finally {
      await context.close().catch(() => {});
      lock.release(CONFIRM_LOCK_PATH);
    }
    process.exit(0);
  })().catch(err => {
    lock.release(CONFIRM_LOCK_PATH);
    console.error('confirm-emails error:', err.message);
    process.exit(1);
  });
} else if (REPORT) {

// ── --report: build monthly PDF + emailable HTML report and exit ─────────────
const brokers = require('./brokers');
const { buildReportModel, renderReportHtml, renderReportPdf, reportPdfPath, REPORT_DIR } = require('./lib/report');
const {
  computeExposureScore,
  serpResultsFromHistory,
  loadExposureHistory,
  exposureToReportAdapter,
} = require('./lib/exposure');

let chromiumForReport;
try {
  ({ chromium: chromiumForReport } = require('playwright'));
} catch (_) {
  const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
  ({ chromium: chromiumForReport } = require(fallback));
}

const reportConfig = loadConfig();
const profileDirForReport = (reportConfig.profileDir || '~/.config/auto-identity-remove')
  .replace(/^~(?=\/|$)/, os.homedir());

const REPORT_LOCK_PATH = STATE_PATH + '.lock';
try {
  lock.acquire(REPORT_LOCK_PATH);
} catch (err) {
  const pidMatch = err.message.match(/pid (\d+)/);
  console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
  process.exit(1);
}

(async () => {
  const state = loadState();

  // Compute current exposure so the report can show a real trend.
  let serpRowsForReport = [];
  try {
    const serpHistoryPathForReport = path.join(__dirname, 'data', 'serp-history.json');
    serpRowsForReport = JSON.parse(fs.readFileSync(serpHistoryPathForReport, 'utf8'));
    if (!Array.isArray(serpRowsForReport)) serpRowsForReport = [];
  } catch (_) { serpRowsForReport = []; }
  const serpResultsForReport = serpResultsFromHistory(serpRowsForReport);
  const exposureSummary = computeExposureScore({ state, serpResults: serpResultsForReport, breachCount: 0, brokers });
  const priorHistory = loadExposureHistory();
  const exposure = exposureToReportAdapter(exposureSummary, priorHistory);

  const model = buildReportModel({ state, brokers, exposure });
  const html = renderReportHtml(model);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = reportPdfPath(new Date());

  const context = await chromiumForReport.launchPersistentContext(profileDirForReport, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });

  try {
    await renderReportPdf({ html, outPath, context });
    console.log(`\nReport PDF written: ${outPath}`);

    const smtp = reportConfig.email && reportConfig.email.smtp;
    let emailed = false;
    if (smtp && reportConfig.notify && reportConfig.notify.emailReportTo) {
      let nodemailer;
      try {
        nodemailer = require('nodemailer');
      } catch (_) {
        nodemailer = null;
      }
      if (nodemailer) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port || 587,
            secure: (smtp.port || 587) === 465,
            auth: { user: smtp.user, pass: smtp.pass },
          });
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

    if (!emailed) {
      desktopNotify('Privacy report', `Monthly report saved: ${outPath}`);
      console.log(`Report saved (no SMTP configured or email failed). Actions needed: ${model.actionsNeeded.length}`);
    }
  } finally {
    await context.close().catch(() => {});
    lock.release(REPORT_LOCK_PATH);
  }
  process.exit(0);
})().catch(err => {
  lock.release(REPORT_LOCK_PATH);
  console.error('report error:', err.message);
  process.exit(1);
});

} else {

// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
  const { runDoctor } = require('./lib/doctor');
  runDoctor().then(results => {
    process.exit(results.exitCode);
  }).catch(err => {
    console.error('doctor error:', err.message);
    process.exit(1);
  });
} else if (UPDATE_BROKERS) {
  // ── --update-brokers: refresh data/feeds-brokers.json from live registries ──
  // Pure HTTP + file write; no Playwright, no loadConfig. Fetches the California
  // + Vermont data-broker registries, normalizes, dedups against brokers.js, and
  // writes the feed file consumed by generic-runner.js. Markup data remains the
  // fallback. Async, so this lives as a peer of --doctor (not a standalone
  // pre-ladder block) to avoid falling through into the normal Playwright run.
  const brokers = require('./brokers');
  const { runUpdateBrokers } = require('./lib/feeds');
  runUpdateBrokers({ brokers, logFn: (m) => console.log(m) })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('update-brokers error:', err.message);
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

// -- --know: fire right-to-know (data access) requests to email brokers, exit --
// No browser needed - email-method brokers only. Acquires the state lock since
// recordKnowRequest -> saveState writes state.json.
if (KNOW_MODE) {
  const brokers = require('./brokers');
  const { sendKnowRequests } = require('./lib/right-to-know-runner');
  const { getPendingKnowRequests } = require('./lib/config');
  const KNOW_LOCK_PATH = STATE_PATH + '.lock';
  try {
    lock.acquire(KNOW_LOCK_PATH);
  } catch (err) {
    const pidMatch = err.message.match(/pid (\d+)/);
    console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
    process.exit(1);
  }

  (async () => {
    console.log('\nRight-to-know - requesting disclosure of held data from email brokers');
    if (DRY_RUN) console.log('DRY RUN - previews only, nothing sent, no state saved.');
    const emailBrokerCount = brokers.filter(b => b.method === 'email').length;
    console.log(`${emailBrokerCount} email broker(s) x ${persons.length} person(s)\n`);

    const result = await sendKnowRequests(brokers, config, { dryRun: DRY_RUN });

    console.log('\n' + '='.repeat(54));
    console.log('Right-to-know results - ' + new Date().toLocaleString());
    console.log('='.repeat(54));
    console.log(`  sent (SMTP) : ${result.sent.length}`);
    console.log(`  manual      : ${result.manual.length}`);
    console.log(`  errors      : ${result.errors.length}`);
    for (const e of result.errors) console.log(`    - ${e.name}: ${e.error}`);
    const pending = getPendingKnowRequests(brokers, { olderThanDays: 45 });
    console.log(`\n  ${pending.length} prior request(s) now past 45 days (run --know-status for detail).`);
    console.log('='.repeat(54) + '\n');
  })().then(() => {
    lock.release(STATE_PATH + '.lock');
    process.exit(0);
  }).catch(err => {
    lock.release(STATE_PATH + '.lock');
    console.error('know error:', err.message);
    process.exit(1);
  });
} else {

brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config });

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
// Timestamped to the second (B8): two runs on the same day must not overwrite
// each other, otherwise loadPreviousLog/diffResults can never diff intraday runs.
const logFile = path.join(LOG_DIR, `run-${timestampForFilename(new Date().toISOString())}.json`);
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
  if (VERIFY)        console.log('🔍 VERIFY — re-checking listings. No forms submitted. Verification results are saved.');
  if (POLLUTE_COUNT) console.log(`⚠️  NOISE MODE — ${POLLUTE_COUNT} bogus record(s) will be submitted to acceptsBogus brokers.`);
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log(`📋 ${brokers.length} explicit brokers + 500+ generic | re-check window: ${RECHECK_DAYS} days\n`);

  // Launch persistent browser (reuses profile / saved logins)
  fs.mkdirSync(profileDir, { recursive: true });

  // Headless mode: respect HEADLESS env var, else auto-detect.
  // Default to false (headed) on platforms where a display is likely present.
  // In Docker (no $DISPLAY on linux), default to headless: true so the tool actually runs.
  const headlessEnv = process.env.HEADLESS;
  const headless = headlessEnv === '1' || headlessEnv === 'true'
    ? true
    : headlessEnv === '0' || headlessEnv === 'false'
    ? false
    : (process.platform === 'linux' && !process.env.DISPLAY); // auto: headless in linux containers
  console.log(`🖥  Browser mode: ${headless ? 'headless' : 'headed'}${headlessEnv === undefined && process.platform === 'linux' ? ' (auto-detected)' : ''}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  await context.addInitScript(buildStealthScript());

  // ── Verify mode: T+7 post-submit verification loop ───────────────────────
  if (VERIFY) {
    const { runVerify } = require('./lib/verify-loop');
    const result = await runVerify(context, brokers, persons, { state, config });
    saveState();
    await context.close().catch(() => {});

    // Print summary
    console.log('\n' + '='.repeat(54));
    console.log('Verification results — ' + new Date().toLocaleString());
    console.log('='.repeat(54));
    console.log(`  verified_clear : ${result.verified_clear.length}`);
    console.log(`  still_listed   : ${result.still_listed.length}`);
    console.log(`  unverifiable   : ${result.unverifiable.length}`);
    console.log(`  skipped        : ${result.skipped.length}`);
    if (result.still_listed.length > 0) {
      console.log('\nStill listed (opt-out may have failed or data was re-added):');
      for (const e of result.still_listed) {
        const name = e.person ? `${e.person.firstName} ${e.person.lastName}` : '';
        console.log(`  - ${e.broker}${name ? ` (${name})` : ''}`);
      }
    }
    console.log('='.repeat(54) + '\n');
    return;
  }

  // ── SERP scan mode: search-engine broker visibility audit ────────────────
  if (SERP_SCAN) {
    const { runSerpScan } = require('./lib/serp-scan');
    console.log('\n🔎 SERP scan — checking broker visibility in search engines');
    console.log('   DDG first, then Bing, then Google (may be blocked).\n');
    const summary = await runSerpScan(context, persons, brokers);
    await context.close().catch(() => {});

    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n' + '='.repeat(62));
    console.log('SERP Scan Results — ' + new Date().toLocaleString());
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
    } else {
      console.log('\n  No broker domains found in the top search results.');
      console.log('  Your opt-outs appear to be effective at the SERP level.');
    }

    console.log('\n' + '='.repeat(62) + '\n');
    return;
  }

  // -- SERP watch mode: scan + diff vs history + alert on NEW domains ---------
  if (SERP_WATCH) {
    const { runSerpWatch } = require('./lib/serp-watch');
    console.log('\n SERP watch - scanning, then diffing against previous history');
    console.log('   Alerts fire only when your name appears on a NEW domain.\n');
    const watch = await runSerpWatch(context, persons, brokers, { cfg: config });
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
    if (watch.diff.newDomains.length > 0) {
      console.log('\n  WARNING: NEW domains your name now appears on:');
      for (const d of watch.diff.newDomains) console.log(`     - ${d}`);
      console.log(watch.alerted ? '\n  An alert was dispatched.' : '\n  (No alert channel configured.)');
    } else {
      console.log('\n  No new broker domains since the last scan.');
    }
    console.log('\n' + '='.repeat(62) + '\n');
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

    // Resolve a masked/relay submission email for this person (cached in
    // state.relayAliases by lib/relay). Returns person.email unchanged when no
    // relay is configured, so existing setups are unaffected. Persisted later
    // by the run's saveState().
    const submissionEmail = await getSubmissionEmail({ config, person, state });
    if (submissionEmail && submissionEmail !== person.email) {
      console.log(`   Using masked email for submissions: ${submissionEmail}`);
    }

    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config, submissionEmail });

    // Email opt-outs (no browser needed - skipped in verify mode)
    if (!VERIFY) {
      console.log('── Email opt-outs ─────────────────────────────────────────');
      await sendOptOutEmails(brokers, config, undefined, { submissionEmailFor: (p) => (p === person ? submissionEmail : undefined) });
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
      console.log(`🔎 Filter applied — ${sorted.length} broker(s) will run`);
    }

    console.log('\n── Explicit broker opt-outs ───────────────────────────────');
    for (const broker of sorted) {
      process.stdout.write(`\n[${stamp()}] ${broker.name}… `);
      await brokerRunner.processBroker(context, broker);
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

  // Build the set of explicit broker hostnames so generic-runner can skip them.
  // Generic opt-outs are domain-level (not person-specific), so this runs once
  // after all persons' explicit opt-outs are complete.
  const explicitHosts = new Set(
    brokers.map(b => {
      try {
        return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, '');
      } catch(_) { return ''; }
    }).filter(Boolean)
  );

  // generic-runner.js returns { count, genericStats }; store stats so they
  // appear in the summary and in the run-log JSON. Runs once (domain-level,
  // not per-person). Uses persons[0] internally via activePerson().
  const genericResult = await runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, { dryRun: DRY_RUN });
  if (genericResult && genericResult.genericStats) {
    results.genericStats = genericResult.genericStats;
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

} // end else (not --know mode)

} // end else (not DOCTOR mode)

} // end else (not --confirm-emails mode)

} // end else (not --breach-check mode)
