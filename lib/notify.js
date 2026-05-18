/**
 * lib/notify.js
 *
 * Cross-platform notification helpers (iMessage / Notification Center on macOS,
 * notify-send on Linux) and browser-open.
 */

const { execSync } = require('child_process');
const { getPlatform } = require('./platform');

const isMac = process.platform === 'darwin';

function sendText(message, notify) {
  if (!notify?.textTo) return;
  if (isMac) {
    const s = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Messages"\nset sv to first service whose service type = iMessage\nset b to buddy "${s(notify.textTo)}" of sv\nsend "${s(message)}" to b\nend tell`;
    try { execSync(`osascript << 'OSASCRIPT'\n${script}\nOSASCRIPT`); } catch(_) {}
  } else {
    const s = t => t.replace(/"/g, '\\"');
    try { execSync(`notify-send "auto-identity-remove" "${s(message)}"`); } catch(_) {}
  }
}

function desktopNotify(title, message) {
  try {
    if (isMac) {
      const s = t => t.replace(/"/g, '\\"');
      execSync(`osascript -e 'display notification "${s(message)}" with title "${s(title)}"'`);
    } else {
      const s = t => t.replace(/"/g, '\\"');
      execSync(`notify-send "${s(title)}" "${s(message)}"`);
    }
  } catch(_) {}
}

function openInBrowser(urls) {
  const cmd = isMac ? 'open' : 'xdg-open';
  for (const url of urls) {
    try { execSync(`${cmd} "${url}"`); } catch(_) {}
    execSync('sleep 0.4');
  }
}

module.exports = { sendText, desktopNotify, openInBrowser };
