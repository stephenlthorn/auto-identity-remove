/**
 * lib/notify.js
 *
 * macOS notification helpers (iMessage, Notification Center, open-in-browser).
 * Verbatim move of the original osascript/AppleScript implementations — a later
 * work package generalizes these across platforms.
 */

const { execSync } = require('child_process');

function sendText(message, notify) {
  if (!notify?.textTo) return;
  const s = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Messages"\nset sv to first service whose service type = iMessage\nset b to buddy "${s(notify.textTo)}" of sv\nsend "${s(message)}" to b\nend tell`;
  try { execSync(`osascript << 'OSASCRIPT'\n${script}\nOSASCRIPT`); } catch(_) {}
}

function macNotify(title, message) {
  try {
    const s = t => t.replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${s(message)}" with title "${s(title)}"'`);
  } catch(_) {}
}

function openInBrowser(urls) {
  for (const url of urls) {
    try { execSync(`open "${url}"`); } catch(_) {}
    execSync('sleep 0.4');
  }
}

module.exports = { sendText, macNotify, openInBrowser };
