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
  genericStats: undefined,
};

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀', pending_confirm: '📧', preview: '👀', unverified: '❓' };

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
  unverified:      'errors',
};

function logResult(broker, status, detail = '') {
  const entry = { broker, status, detail, time: new Date().toLocaleTimeString() };
  const bucket = STATUS_BUCKET[status] || 'errors';
  results[bucket].push(entry);
  console.log(`${ICONS[status] || '?'} [${broker}] ${status}${detail ? ' — ' + detail : ''}`);
}

// Clear all buckets in place so the shared `results` reference stays valid.
// Used by tests and the upcoming --verify mode for run isolation.
function resetResults() {
  results.runAt = new Date().toISOString();
  for (const k of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors', 'dead', 'pendingConfirm']) {
    results[k] = [];
  }
  results.genericStats = undefined;
  return results;
}

const { findDrifted } = require('./drift');
const { DEFUNCT_THRESHOLD } = require('./defunct');

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
    `🚨 Drift detected — these brokers have failed 3+ consecutive times:`,
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
  return [``, `📧 Watch your inbox — confirm removal:`, ...bullets].join('\n');
}

function buildSummary() {
  const manualNeeded = [...results.captchaFailed, ...results.manual];
  const pending = results.pendingConfirm;
  const gs = results.genericStats;
  const genericLine = gs
    ? `Generic runner: ${gs.attempted} attempted | ${gs.submitted} submitted | ${gs.no_form_found} no-form-found | ${gs.error} error`
    : '';
  const driftSection = _summaryState ? buildDriftSection(_summaryState) : '';
  const defunctSection = _defunctBrokers.length > 0
    ? [
        ``,
        `⚰️  Defunct (${DEFUNCT_THRESHOLD} consec. errors): ${_defunctBrokers.join(', ')}`,
        `    -> Run with --list to see history, then remove from brokers.js`,
      ].join('\n')
    : '';
  return [
    `🔒 Privacy Watcher — ${new Date().toLocaleDateString()}`,
    ``,
    `✅ Submitted (form accepted): ${results.succeeded.length}`,
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
};
