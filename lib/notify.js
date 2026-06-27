/**
 * lib/notify.js
 *
 * Cross-platform notification helpers.
 *
 * Public API (signatures unchanged — watcher.js calls these directly):
 *   sendText(message, notify)   — iMessage on macOS when notify.textTo set
 *   macNotify(title, message)   — macOS Notification Center toast
 *   desktopNotify(title, msg)   — cross-platform desktop toast dispatcher
 *   openInBrowser(urls)         — opens URLs in the default browser (cross-platform)
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

// ─── Test-only platform override ─────────────────────────────────────────────

let _platformOverride = null;

/**
 * Override the platform for unit testing. Pass null to reset.
 * @param {string|null} platform - e.g. 'darwin', 'linux', 'win32', or null to reset
 */
function setPlatformForTesting(platform) {
  _platformOverride = platform;
}

function _currentPlatform() {
  return _platformOverride !== null ? _platformOverride : process.platform;
}

// ─── Low-level helpers (original implementations, unchanged) ─────────────────

function sendText(message, notifyCfg, _platform) {
  const platform = _platform || process.platform;
  if (platform !== 'darwin') {
    if (process.env.DEBUG) console.debug('[notify] sendText: skipped (non-Mac platform)');
    return false;
  }
  if (!notifyCfg?.textTo) return undefined;
  // Use execFileSync with argv array - no shell, no heredoc, no quoting issues.
  // Single-quotes and double-quotes in message/textTo are safe because they go
  // directly into the AppleScript string via JSON.stringify (which escapes them).
  const recipient = notifyCfg.textTo;
  const script = [
    'tell application "Messages"',
    'set sv to first service whose service type = iMessage',
    `set b to buddy ${JSON.stringify(String(recipient))} of sv`,
    `send ${JSON.stringify(String(message))} to b`,
    'end tell',
  ].join('\n');
  try { cp.execFileSync('osascript', ['-e', script], { stdio: 'pipe' }); } catch (_) {}
}

function macNotify(title, message) {
  // Use execFileSync with argv array - avoids shell-quoting issues with ' and "
  const script = `display notification ${JSON.stringify(String(message))} with title ${JSON.stringify(String(title))}`;
  try { cp.execFileSync('osascript', ['-e', script], { stdio: 'pipe' }); } catch (_) {}
}

function openInBrowser(urls, _platform) {
  const platform = _platform || _currentPlatform();
  for (const url of urls) {
    try {
      let cmd, args;
      if (platform === 'darwin') {
        cmd = 'open';
        args = [url];
      } else if (platform === 'linux') {
        cmd = 'xdg-open';
        args = [url];
      } else {
        // win32: needs empty title argument before the URL
        cmd = 'cmd';
        args = ['/c', 'start', '', url];
      }
      const proc = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' });
      proc.unref();
    } catch (_) {}
  }
}

// ─── Cross-platform dispatcher ───────────────────────────────────────────────

/**
 * Check whether a CLI binary exists on $PATH.
 * Uses spawnSync with argv array (no shell) to avoid injection risks.
 * @param {string} bin
 * @returns {boolean}
 */
function _hasBinary(bin) {
  try {
    const result = cp.spawnSync('which', [bin], { stdio: 'pipe' });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Send a desktop toast on Linux via notify-send.
 * Uses spawnSync with argv array - no shell, no quoting issues.
 * Falls back gracefully if notify-send is unavailable or throws.
 * @param {string} title
 * @param {string} message
 */
function _linuxToast(title, message) {
  if (!_hasBinary('notify-send')) return;
  try {
    cp.spawnSync('notify-send', [title, message], { stdio: 'pipe' });
  } catch (_) {}
}

/**
 * Cross-platform desktop toast notification dispatcher.
 * Best-effort: all errors are swallowed, never throws.
 *
 * @param {string} title
 * @param {string} message
 * @param {string} [_platform] - Injected for testing; defaults to process.platform
 */
function desktopNotify(title, message, _platform) {
  const platform = _platform || _currentPlatform();
  try {
    if (platform === 'darwin') {
      macNotify(title, message);
    } else if (platform === 'linux') {
      cp.spawnSync('notify-send', [title, message]);
    } else {
      // win32: try PowerShell BurntToast, fall back to console log
      try {
        const s = t => t.replace(/'/g, "''");
        cp.spawnSync('powershell', [
          '-NonInteractive', '-Command',
          `New-BurntToastNotification -Text '${s(title)}','${s(message)}'`,
        ], { stdio: 'pipe' });
      } catch (_) {
        console.log(`[notify] ${title}: ${message}`);
      }
    }
  } catch (_) {}
}

/**
 * POST a message to a webhook URL (ntfy.sh / Slack / Discord compatible).
 * Uses Node 18+ global fetch — no external dependency.
 *
 * @param {string} webhookUrl
 * @param {string|object} message - String (legacy): POSTs {text: string}.
 *   Object (rich): POSTs the object as-is, adding `timestamp` if not present.
 */
async function sendWebhook(webhookUrl, message) {
  try {
    let body;
    if (typeof message === 'string') {
      body = { text: message };
    } else {
      body = { ...message, timestamp: message.timestamp || new Date().toISOString() };
    }
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    sendText(summaryText, notifyCfg, 'darwin');
    macNotify('Privacy Watcher', summaryText);
  } else if (platform === 'linux') {
    // desktopNotify already handles linux via spawnSync - reuse it to avoid duplication
    desktopNotify('Privacy Watcher', summaryText, 'linux');
  }
  // Windows: no built-in toast here; webhook covers it

  if (notifyCfg.webhook) {
    await _webhookPost(notifyCfg.webhook, summaryText);
  }
}

module.exports = {
  sendText,
  macNotify,
  desktopNotify,
  openInBrowser,
  sendWebhook,
  dispatchNotify,
  // Internal exports for unit-testing
  _hasBinary,
  _webhookPost,
  _linuxToast,
  setPlatformForTesting,
};
