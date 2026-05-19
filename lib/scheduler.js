/**
 * lib/scheduler.js
 *
 * Cross-platform scheduling for auto-identity-remove.
 * Exports installSchedule({ scriptPath, logDir }) which returns
 * { method, detail } indicating how the job was registered.
 *
 * Supported platforms:
 *   macOS   → launchd plist (~/.../LaunchAgents/com.auto-identity-remove.plist)
 *   Linux   → systemd user timer; falls back to crontab
 *   Windows → schtasks; prints command on failure instead of throwing
 */

'use strict';

const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const childProcess = require('child_process');

const { getPlatform } = require('./platform');

// Label/name reused across platforms
const JOB_NAME = 'auto-identity-remove';
const PLIST_ID = 'com.auto-identity-remove';

/**
 * Returns the launchd plist path (evaluated lazily so tests can patch os.homedir).
 * @returns {string}
 */
function getPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_ID}.plist`);
}

// ─── Platform-specific installers ────────────────────────────────────────────

/**
 * Build the launchd plist XML string (identical to original setup.js content).
 * @param {string} scriptPath  Absolute path to run.sh
 * @param {string} logDir      Absolute path to logs directory
 * @returns {string}
 */
function buildPlist(scriptPath, logDir) {
  const browsersPath =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key><integer>1</integer>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/launchd.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PLAYWRIGHT_BROWSERS_PATH</key>
        <string>${browsersPath}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;
}

/**
 * Install via launchd on macOS.
 * Behavior is byte-identical to the original setup.js scheduling block.
 * @param {string} scriptPath
 * @param {string} logDir
 * @returns {{ method: 'launchd', detail: string }}
 */
function installLaunchd(scriptPath, logDir) {
  const plistPath = getPlistPath();
  const plist = buildPlist(scriptPath, logDir);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);

  try {
    childProcess.execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`);
    const detail = `Scheduled — runs every 1st of the month at 9am.\n   Plist: ${plistPath}`;
    return { method: 'launchd', detail };
  } catch (err) {
    const detail = `launchctl error: ${err.message.slice(0, 80)}\n   Manually load with: launchctl load "${plistPath}"`;
    return { method: 'launchd', detail };
  }
}

/**
 * Build systemd user unit file contents.
 * @param {string} scriptPath
 * @param {string} logDir
 * @returns {{ service: string, timer: string }}
 */
function buildSystemdUnits(scriptPath, logDir) {
  const service = `[Unit]
Description=auto-identity-remove monthly opt-out runner
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${scriptPath}
StandardOutput=append:${logDir}/systemd.log
StandardError=append:${logDir}/systemd.error.log

[Install]
WantedBy=default.target
`;

  const timer = `[Unit]
Description=Run auto-identity-remove on the 1st of every month

[Timer]
OnCalendar=*-*-01 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * Install via systemd user timer on Linux.
 * Falls back to crontab if systemctl is not available.
 * @param {string} scriptPath
 * @param {string} logDir
 * @returns {{ method: 'systemd'|'crontab', detail: string }}
 */
function installLinux(scriptPath, logDir) {
  // Probe for systemd
  let hasSystemd = false;
  try {
    childProcess.execSync('which systemctl', { stdio: 'pipe' });
    hasSystemd = true;
  } catch (_) {
    hasSystemd = false;
  }

  if (hasSystemd) {
    return installSystemd(scriptPath, logDir);
  }
  return installCrontab(scriptPath);
}

/**
 * Install via systemd user timer.
 * @param {string} scriptPath
 * @param {string} logDir
 * @returns {{ method: 'systemd', detail: string }}
 */
function installSystemd(scriptPath, logDir) {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });

  const { service, timer } = buildSystemdUnits(scriptPath, logDir);
  fs.writeFileSync(path.join(unitDir, `${JOB_NAME}.service`), service);
  fs.writeFileSync(path.join(unitDir, `${JOB_NAME}.timer`), timer);

  try {
    childProcess.execSync(
      `systemctl --user daemon-reload && systemctl --user enable --now ${JOB_NAME}.timer`,
      { stdio: 'pipe' }
    );
    const detail =
      `Systemd user timer enabled — runs every 1st of the month at 9am.\n` +
      `   Units: ${unitDir}/${JOB_NAME}.{service,timer}`;
    return { method: 'systemd', detail };
  } catch (err) {
    const detail =
      `systemctl error: ${err.message.slice(0, 80)}\n` +
      `   Manually enable with: systemctl --user daemon-reload && systemctl --user enable --now ${JOB_NAME}.timer`;
    return { method: 'systemd', detail };
  }
}

/**
 * Install via crontab (fallback when systemd is absent).
 * @param {string} scriptPath
 * @returns {{ method: 'crontab', detail: string }}
 */
function installCrontab(scriptPath) {
  const cronLine = `0 9 1 * * /bin/bash ${scriptPath}`;

  try {
    // Read existing crontab; skip if the line is already present
    let existing = '';
    try {
      existing = childProcess.execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    } catch (_) {
      existing = '';
    }

    if (existing.includes(cronLine)) {
      return { method: 'crontab', detail: 'Crontab entry already present — no changes made.' };
    }

    const updated = existing.trimEnd() + (existing.trimEnd() ? '\n' : '') + cronLine + '\n';
    childProcess.execSync(`echo ${JSON.stringify(updated)} | crontab -`, { stdio: 'pipe' });
    return {
      method: 'crontab',
      detail: `Crontab entry added — runs every 1st of the month at 9am.\n   Line: ${cronLine}`,
    };
  } catch (err) {
    return {
      method: 'crontab',
      detail: `crontab error: ${err.message.slice(0, 80)}\n   Manually add: ${cronLine}`,
    };
  }
}

/**
 * Install via Windows Task Scheduler.
 * Prints the command for manual execution if schtasks fails.
 * @param {string} scriptPath
 * @returns {{ method: 'schtasks'|'manual', detail: string }}
 */
function installWindows(scriptPath) {
  // On Windows, node.exe is used to run the watcher directly
  const nodeExe = process.execPath;
  const watcherPath = path.join(path.dirname(scriptPath), 'watcher.js');

  const schtasksCmd = buildWindowsSchtasksCmd(nodeExe, watcherPath);

  try {
    childProcess.execSync(schtasksCmd, { stdio: 'pipe' });
    return {
      method: 'schtasks',
      detail: `Windows Task Scheduler task "${JOB_NAME}" created — runs every 1st of the month at 9am.`,
    };
  } catch (err) {
    console.log(`\n⚠  Task Scheduler error: ${err.message.slice(0, 120)}`);
    console.log('   Run this command manually as Administrator:');
    console.log(`   ${schtasksCmd}\n`);
    return {
      method: 'manual',
      detail: `Could not create scheduled task automatically.\n   Run manually: ${schtasksCmd}`,
    };
  }
}

// ─── Pure helper (testable without OS calls) ─────────────────────────────────

/**
 * Build the schtasks /Create command string for Windows Task Scheduler.
 * Pure function — no OS calls — so tests can inspect the command string directly.
 *
 * @param {string} nodeExePath   Absolute path to node.exe
 * @param {string} watcherPath   Absolute path to watcher.js
 * @param {{ hour?: number, minute?: number }} [opts]
 * @returns {string}
 */
function buildWindowsSchtasksCmd(nodeExePath, watcherPath, opts = {}) {
  const hour   = (opts.hour   !== undefined) ? opts.hour   : 9;
  const minute = (opts.minute !== undefined) ? opts.minute : 0;
  const time   = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const tr     = `"${nodeExePath}" "${watcherPath}"`;

  return (
    `schtasks /Create /F /SC MONTHLY /D 1 /ST ${time} ` +
    `/TN "${JOB_NAME}" /TR ${tr}`
  );
}

/**
 * Install the schedule for an explicit platform string.
 * Exposed for use in watcher.js `--install-scheduler` handler and for
 * unit testing without touching process.platform.
 *
 * @param {{ platform: 'macos'|'linux'|'windows'|string, scriptPath: string, logDir: string }} opts
 * @returns {{ method: string, detail: string }}
 */
function installScheduleForPlatform({ platform, scriptPath, logDir }) {
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir);
}

/**
 * Return the scheduler function for the given platform string.
 * Exposed for unit testing — callers pass 'macos'|'linux'|'windows'.
 * @param {'macos'|'linux'|'windows'} platform
 * @returns {Function}
 */
function pickScheduler(platform) {
  if (platform === 'macos')   return installLaunchd;
  if (platform === 'windows') return installWindows;
  return installLinux;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Install the monthly schedule for the current platform.
 *
 * @param {{ scriptPath: string, logDir: string }} options
 *   scriptPath — absolute path to run.sh (or watcher.js on Windows)
 *   logDir     — absolute path to the logs directory (created if absent)
 * @returns {{ method: 'launchd'|'systemd'|'crontab'|'schtasks'|'manual', detail: string }}
 */
function installSchedule({ scriptPath, logDir }) {
  fs.mkdirSync(logDir, { recursive: true });
  const platform = getPlatform();
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir);
}

module.exports = {
  installSchedule,
  installScheduleForPlatform,
  pickScheduler,
  buildPlist,
  buildSystemdUnits,
  buildWindowsSchtasksCmd,
};
