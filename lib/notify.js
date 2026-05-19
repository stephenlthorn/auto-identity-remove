/**
 * lib/notify.js
 *
 * Cross-platform notification helpers.
 *
 * Public API (signatures unchanged — watcher.js calls these directly):
 *   sendText(message, notify)   — iMessage on macOS when notify.textTo set
 *   macNotify(title, message)   — macOS Notification Center toast
 *   openInBrowser(urls)         — opens URLs in the default browser
 *
 * New dispatcher (also exported):
 *   notify(summaryText, cfg)    — best-effort cross-platform dispatcher:
 *                                  • macOS  → iMessage + Notification Center
 *                                  • Linux  → notify-send if available
 *                                  • any OS → webhook POST if cfg.notify.webhook set
 *
 * Each channel is wrapped in try/catch and never throws.
 * macOS default behavior is UNCHANGED when no webhook is configured.
 *
 * Injected-arg pattern preserved: notify config is the 2nd arg to sendText
 * (not a module-level closure) to avoid circular-require hazards.
 */

const cp = require('child_process');
const { getPlatform } = require('./platform');

// ─── Low-level helpers (original implementations, unchanged) ─────────────────

function sendText(message, notifyCfg, _platform) {
  const platform = _platform || process.platform;
  if (platform !== 'darwin') {
    if (process.env.DEBUG) console.debug('[notify] sendText: skipped (non-Mac platform)');
    return false;
  }
  if (!notifyCfg?.textTo) return undefined;
  const s = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Messages"',
    'set sv to first service whose service type = iMessage',
    `set b to buddy "${s(notifyCfg.textTo)}" of sv`,
    `send "${s(message)}" to b`,
    'end tell',
  ].join('\n');
  // Input is controlled (notifyCfg.textTo comes from config, not user input at runtime)
  // eslint-disable-next-line no-restricted-syntax
  try { cp.execSync(`osascript << 'OSASCRIPT'\n${script}\nOSASCRIPT`); } catch (_) {}
}

function macNotify(title, message) {
  try {
    const s = t => t.replace(/"/g, '\\"');
    cp.execSync(`osascript -e 'display notification "${s(message)}" with title "${s(title)}"'`);
  } catch (_) {}
}

function openInBrowser(urls) {
  for (const url of urls) {
    try { cp.execSync(`open "${url}"`); } catch (_) {}
    cp.execSync('sleep 0.4');
  }
}

// ─── Cross-platform dispatcher ───────────────────────────────────────────────

/**
 * Check whether a CLI binary exists on $PATH.
 * @param {string} bin
 * @returns {boolean}
 */
function _hasBinary(bin) {
  try { cp.execSync(`which ${bin}`, { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

/**
 * Send a desktop toast on Linux via notify-send (if available).
 * @param {string} title
 * @param {string} message
 */
function _linuxToast(title, message) {
  if (!_hasBinary('notify-send')) return;
  try {
    const s = t => t.replace(/'/g, "'\\''");
    cp.execSync(`notify-send '${s(title)}' '${s(message)}'`);
  } catch (_) {}
}

/**
 * POST a message to a webhook URL (ntfy.sh / Slack / Discord compatible).
 * Uses Node 18+ global fetch — no external dependency.
 * @param {string} webhookUrl
 * @param {string} message
 */
async function sendWebhook(webhookUrl, message) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (_) {}
}

/**
 * @deprecated Use sendWebhook instead.
 * Kept for internal backward-compat within the module.
 */
const _webhookPost = sendWebhook;

/**
 * Best-effort cross-platform notification dispatcher.
 *
 * @param {string} summaryText  - The summary string to send.
 * @param {object} cfg          - The full config object (cfg.notify.textTo, cfg.notify.webhook).
 * @param {string} [_platform]  - Injected for testing; defaults to process.platform.
 */
async function dispatchNotify(summaryText, cfg, _platform) {
  const platform = getPlatform(_platform || process.platform);
  const notifyCfg = cfg?.notify || {};

  if (platform === 'macos') {
    sendText(summaryText, notifyCfg);
    macNotify('Privacy Watcher', summaryText);
  } else if (platform === 'linux') {
    _linuxToast('Privacy Watcher', summaryText);
  }
  // Windows: no built-in toast here; webhook covers it

  if (notifyCfg.webhook) {
    await _webhookPost(notifyCfg.webhook, summaryText);
  }
}

module.exports = {
  sendText,
  macNotify,
  openInBrowser,
  sendWebhook,
  dispatchNotify,
  // Internal exports for unit-testing
  _hasBinary,
  _webhookPost,
  _linuxToast,
};
