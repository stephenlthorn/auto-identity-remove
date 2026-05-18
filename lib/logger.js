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
};

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌' };

const STATUS_BUCKET = {
  success:        'succeeded',
  skipped:        'skipped',
  notFound:       'notFound',
  captcha_failed: 'captchaFailed',
  manual:         'manual',
  error:          'errors',
};

function logResult(broker, status, detail = '') {
  const entry = { broker, status, detail, time: new Date().toLocaleTimeString() };
  const bucket = STATUS_BUCKET[status] || 'errors';
  results[bucket].push(entry);
  console.log(`${ICONS[status] || '?'} [${broker}] ${status}${detail ? ' — ' + detail : ''}`);
}

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

module.exports = {
  results,
  ICONS,
  STATUS_BUCKET,
  logResult,
  buildSummary,
};
