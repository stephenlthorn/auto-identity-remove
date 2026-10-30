/**
 * lib/logger.js
 *
 * The shared `results` accumulator, `logResult()` routing, status→bucket map,
 * `ICONS`, and `buildSummary()`. `results` is a module-level singleton with the
 * same semantics as the original monolith (mutated in place across the run).
 */

const results = {
  runAt: new Date().toISOString(),
  succeeded: [],
  skipped: [],
  notFound: [],
  captchaFailed: [],
  manual: [],
  errors: [],
  dead: [],
  pendingConfirm: [],
  unverified: [],
  genericStats: undefined,
};

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀', pending_confirm: '📧', preview: '👀', unverified: '❓', allowlisted: '📌' };

const STATUS_BUCKET = {
  success:         'succeeded',
  skipped:         'skipped',
  notFound:        'notFound',
  captcha_failed:  'captchaFailed',
  manual:          'manual',
  error:           'errors',
  dead:            'dead',
  pending_confirm: 'pendingConfirm',
  preview:         'skipped',
  // Submitted, but the result page could not be read. Its own bucket: it is not
  // a recorded success (no 90-day cooldown) and not a plain failure either, so
  // folding it into `errors` or `succeeded` would misreport it both ways.
  unverified:      'unverified',
  allowlisted:     'skipped',
};

// "First Last" of the person the watcher is currently processing, stamped on
// every result so a two-person run does not collapse into one anonymous list
// (CFG-13). null outside the per-person loops.
let _currentPerson = null;

function personLabel(person) {
  if (!person) return null;
  if (typeof person === 'string') return person.trim() || null;
  const name = [person.firstName, person.lastName]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || null;
}

/**
 * Tag subsequent logResult entries with this person. Pass null to stop.
 * @param {{ firstName?: string, lastName?: string }|string|null} person
 */
function setCurrentPerson(person) {
  _currentPerson = personLabel(person);
}

// The crash-safe run journal (lib/journal.js), when the watcher opened one.
// Every logResult entry is appended to it as it happens, so a crash or kill
// leaves the results so far on disk instead of nothing (R3). null by default:
// no journal, no change in behaviour.
let _journal = null;

/**
 * Attach (or with null, detach) the run journal. The logger only calls
 * `journal.append(entry)`; it does not open or close the journal, so the
 * watcher owns its lifecycle. resetResults() leaves it attached: the journal
 * is the record of what happened, not run state.
 * @param {{ append: (entry: object) => any }|null} journal
 */
function setJournal(journal) {
  _journal = journal || null;
}

/**
 * Record one broker outcome.
 *
 * @param {string} broker
 * @param {string} status  a STATUS_BUCKET key
 * @param {string} [detail]
 * @param {{ host?: string }} [extra]  `host` is the site the row was about. The
 *   generic runner names rows by company, so scripts/prune-dead.js needs it to
 *   tell which host kept failing.
 */
function logResult(broker, status, detail = '', extra) {
  const entry = { broker, status, detail, time: new Date().toLocaleTimeString() };
  if (_currentPerson) entry.person = _currentPerson;
  if (extra && typeof extra.host === 'string' && extra.host) entry.host = extra.host;
  const bucket = STATUS_BUCKET[status] || 'errors';
  results[bucket].push(entry);
  // Before the console line: if the process dies right here the entry is already
  // on disk. A journal fault must never take the run down with it.
  if (_journal) {
    try { _journal.append(entry); } catch (_) { /* the in-memory result is kept regardless */ }
  }
  console.log(`${ICONS[status] || '?'} [${broker}] ${status}${detail ? ' - ' + detail : ''}`);
}

// Clear all buckets in place so the shared `results` reference stays valid.
// Used by tests and the upcoming --verify mode for run isolation.
function resetResults() {
  results.runAt = new Date().toISOString();
  for (const k of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors', 'dead', 'pendingConfirm', 'unverified']) {
    results[k] = [];
  }
  results.genericStats = undefined;
  _currentPerson = null;
  return results;
}

const { findDrifted } = require('./drift');
const { DEFUNCT_THRESHOLD } = require('./defunct');
const { outcomeFromResults } = require('./heartbeat');
const { OFFLINE_HINT } = require('./outage');

const DISCLAIMER = 'Submitted ≠ confirmed deleted. Run `node watcher.js --verify` to spot-check.';

// Optional state reference injected before buildSummary so the drift section
// can be included. Default null for backward-compatibility.
let _summaryState = null;

function setStateForSummary(state) {
  _summaryState = state;
}

// Optional list of defunct broker names surfaced in the summary.
// Set via setDefunctBrokers() before buildSummary() is called.
let _defunctBrokers = [];

/**
 * Store the list of defunct broker names so buildSummary can include them.
 * @param {string[]} names
 */
function setDefunctBrokers(names) {
  _defunctBrokers = Array.isArray(names) ? names : [];
}

/**
 * Builds a markdown-style drift warning section.
 * Returns empty string when no brokers are drifted.
 *
 * @param {{ optOuts: Record<string, object> }} state
 * @returns {string}
 */
function buildDriftSection(state) {
  const drifted = findDrifted(state);
  if (drifted.length === 0) return '';

  const bullets = drifted.map(({ name, lastSuccess }) => {
    const when = lastSuccess
      ? lastSuccess.slice(0, 10) // YYYY-MM-DD
      : 'never';
    return `   • ${name} (last success: ${when})`;
  });

  return [
    `🚨 Drift detected - these brokers have had 3+ consecutive non-success outcomes (includes pending-confirm):`,
    ...bullets,
  ].join('\n');
}

function senderDomainFromDetail(brokerName, detail) {
  if (detail) {
    const match = detail.match(/optOutUrl:(https?:\/\/[^\s]+)/);
    if (match) {
      try {
        const hostname = new URL(match[1]).hostname;
        return hostname.replace(/^www\./, '');
      } catch (_) {
        // fall through to broker name fallback
      }
    }
  }
  return brokerName;
}

function buildInboxChecklist(pending) {
  if (pending.length === 0) return '';
  const bullets = pending.map(r => {
    const domain = senderDomainFromDetail(r.broker, r.detail);
    return `   • ${r.broker} (sender: ${domain})`;
  });
  return [``, `📧 Watch your inbox - confirm removal:`, ...bullets].join('\n');
}

function buildSummary() {
  const manualNeeded = [...results.captchaFailed, ...results.manual];
  const pending = results.pendingConfirm;
  const gs = results.genericStats;
  const unverified = results.unverified;
  const genericUnverified = gs && gs.unverified > 0 ? ` | ${gs.unverified} unverified` : '';
  // A form that stood behind an unsolved CAPTCHA is its own count (R2): `aidr captchas` retries them.
  const genericCaptcha = gs && gs.captcha_failed > 0 ? ` | ${gs.captcha_failed} captcha-failed` : '';
  const genericLine = gs
    ? `Generic runner: ${gs.attempted} attempted | ${gs.submitted} submitted | ${gs.no_form_found} no-form-found | ${gs.error} error${genericUnverified}${genericCaptcha}`
    : '';
  const driftSection = _summaryState ? buildDriftSection(_summaryState) : '';
  const defunctSection = _defunctBrokers.length > 0
    ? [
        ``,
        `⚰️  Defunct (${DEFUNCT_THRESHOLD} consec. errors): ${_defunctBrokers.join(', ')}`,
        `    -> Run with --list to see history, then remove from brokers.js`,
      ].join('\n')
    : '';
  // Most hosts answering "no such host" is a broken resolver or network, not a run:
  // say so before the counts, which would otherwise read as a normal one.
  const offlineLine = outcomeFromResults(results).offline ? `🌐 ${OFFLINE_HINT}` : '';
  return [
    `🔒 Privacy Watcher - ${new Date().toLocaleDateString()}`,
    offlineLine,
    ``,
    `✅ Submitted (form accepted): ${results.succeeded.length}`,
    unverified.length > 0 ? `❓ Submitted, result unconfirmed: ${unverified.length}` : '',
    `📧 Awaiting email confirm:    ${pending.length}`,
    `⏭  Skipped (fresh):           ${results.skipped.length}`,
    `🔍 Not listed:                ${results.notFound.length}`,
    `📋 Manual needed:             ${manualNeeded.length}`,
    `❌ Errors:                    ${results.errors.length}`,
    `💀 Dead (stale URL):          ${results.dead.length}`,
    genericLine,
    pending.length > 0
      ? [``, `── Awaiting email confirmation (check your inbox) ──`, ...pending.map(r => `  • ${r.broker}${r.detail ? '\n    ' + r.detail : ''}`)].join('\n')
      : '',
    buildInboxChecklist(pending),
    unverified.length > 0
      ? [``, `── Submitted, result unconfirmed (open the site to check) ──`, ...unverified.map(r => `  • ${r.broker}${r.detail ? '\n    ' + r.detail : ''}`)].join('\n')
      : '',
    manualNeeded.length > 0
      ? [``, `── Action Required ──────────────────────────────`, ...manualNeeded.map(r => `  • ${r.broker}${r.detail ? '\n    ' + r.detail : ''}`)].join('\n')
      : '',
    driftSection,
    defunctSection,
    ``,
    `ⓘ  ${DISCLAIMER}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  results,
  ICONS,
  STATUS_BUCKET,
  DISCLAIMER,
  logResult,
  resetResults,
  buildSummary,
  buildDriftSection,
  setStateForSummary,
  setDefunctBrokers,
  setCurrentPerson,
  setJournal,
  personLabel,
};
