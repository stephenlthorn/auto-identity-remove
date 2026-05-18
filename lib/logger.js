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
};

const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀' };

const STATUS_BUCKET = {
  success:        'succeeded',
  skipped:        'skipped',
  notFound:       'notFound',
  captcha_failed: 'captchaFailed',
  manual:         'manual',
  error:          'errors',
  dead:           'dead',
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
  for (const k of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors', 'dead']) {
    results[k] = [];
  }
  return results;
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
    `💀 Dead (stale URL): ${results.dead.length}`,
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
  resetResults,
  buildSummary,
};
