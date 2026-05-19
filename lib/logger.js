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

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀', pending_confirm: '📧', preview: '👀' };

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

const DISCLAIMER = 'Submitted ≠ confirmed deleted. Run `node watcher.js --verify` to spot-check.';

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
};
