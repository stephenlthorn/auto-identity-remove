/**
 * lib/scheduler.js
 *
 * Cross-platform scheduling for auto-identity-remove.
 * Exports installSchedule({ scriptPath, logDir, env? }) which returns
 * { method, detail } indicating how the job was registered. Every generated
 * payload quotes/escapes its paths, pins PATH to the installing node, and
 * carries AIDR_PASSPHRASE_FILE (never the passphrase) when it is set.
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

// Trailing comment on the cron line we write, so a re-install can find and
// replace its own earlier line without touching anything the user wrote.
const CRON_MARKER = `# ${JOB_NAME}`;

// PATH a job gets after the installing node's own directory. cron, launchd and
// the systemd user manager all start with a minimal PATH that rarely contains a
// version-managed node (nvm, fnm, asdf, Homebrew on Apple silicon).
const DEFAULT_JOB_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// Environment a scheduled job inherits from the installing shell. These are
// PATHS ONLY. The passphrase itself (AIDR_PASSPHRASE) is deliberately absent:
// it must never be written into a plist, unit file or crontab, all of which
// are world-readable or easily copied. An encrypted install passes a 0600
// AIDR_PASSPHRASE_FILE instead (CORE-8).
const CARRIED_ENV_VARS = ['AIDR_PASSPHRASE_FILE', 'AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH'];

// ─── Quoting and payload helpers (pure) ──────────────────────────────────────

// Characters that need no quoting in a shell word or a systemd argument.
const PLAIN_WORD = /^[A-Za-z0-9_@+=:,./-]+$/;

/** Quote one word for a POSIX shell: single quotes, with ' written as '\''. */
function shellQuote(value) {
  const text = String(value);
  if (PLAIN_WORD.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote one word for a crontab command field. cron turns an unescaped % into a
 * newline (the rest of the line becomes stdin), so % must be written \%.
 */
function cronQuote(value) {
  const text = String(value);
  if (PLAIN_WORD.test(text)) return text;
  return shellQuote(text).replace(/%/g, '\\%');
}

/** Escape text for an XML element body (plist values). */
function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Quote one argument of a systemd Exec* line. Inside double quotes \ and " need
 * a backslash, % is a specifier (write %%), and $ starts a variable (write $$).
 */
function systemdArg(value) {
  const text = String(value);
  if (PLAIN_WORD.test(text)) return text;
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

/** systemd settings that are not command lines still treat % as a specifier. */
function systemdSpecifierEscape(value) {
  return String(value).replace(/%/g, '%%');
}

/** One systemd Environment= assignment: the whole NAME=value quoted. */
function systemdEnvironment(name, value) {
  const escaped = `${name}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `Environment="${escaped}"`;
}

/** PATH for a scheduled job: the installing node's directory first, deduplicated. */
function buildJobPath(nodeBinDir) {
  return [...new Set([nodeBinDir, ...DEFAULT_JOB_PATH].filter(Boolean))].join(':');
}

/**
 * The AIDR_* variables to carry into a job, as absolute paths (a relative path
 * would resolve against the job's working directory, not the installer's).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<[string, string]>}
 */
function carriedEnvironment(env = process.env) {
  const carried = [];
  for (const name of CARRIED_ENV_VARS) {
    const value = env && env[name];
    if (typeof value === 'string' && value.trim() !== '') carried.push([name, path.resolve(value)]);
  }
  return carried;
}

/** Fill in installer options. */
function resolveJobOptions(opts = {}) {
  return {
    env: opts.env || process.env,
    nodeBinDir: opts.nodeBinDir || path.dirname(process.execPath),
  };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Reported by the installer step that needs it.
  }
}

/**
 * Write `input` to the stdin of `cmd argv...` with no shell involved.
 *
 * The crontab installer used to pipe the whole new crontab through a shell
 * (`echo "<payload>" | crontab -`). Double quotes do not stop a shell expanding
 * $(...), backticks or $VAR, so every pre-existing line in the user's crontab
 * was evaluated on the way back in - silently rewriting their unrelated jobs and
 * running whatever command substitution happened to be in there. Passing argv
 * plus stdin removes the shell from the path entirely.
 *
 * Exposed as a module-level binding so tests can substitute it without
 * monkey-patching child_process globally.
 *
 * @returns {{ status: number, stderr: string }}
 */
function _realStdinRunner(cmd, args, input) {
  const r = childProcess.spawnSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  return { status: r.status === null ? 1 : r.status, stderr: r.stderr || '' };
}

let _feedStdin = _realStdinRunner;

/** Test seam: replace the stdin runner. Call with no argument to restore. */
function _setStdinRunner(fn) {
  _feedStdin = fn || _realStdinRunner;
}

/**
 * Returns the launchd plist path (evaluated lazily so tests can patch os.homedir).
 * @returns {string}
 */
function getPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_ID}.plist`);
}

// ─── Platform-specific installers ────────────────────────────────────────────

/**
 * Build the launchd plist XML string.
 * @param {string} scriptPath  Absolute path to run.sh
 * @param {string} logDir      Absolute path to logs directory
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {string}
 */
function buildPlist(scriptPath, logDir, opts = {}) {
  const { env, nodeBinDir } = resolveJobOptions(opts);
  const browsersPath =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

  const environment = [
    ['PLAYWRIGHT_BROWSERS_PATH', browsersPath],
    ['PATH', buildJobPath(nodeBinDir)],
    ...carriedEnvironment(env),
  ]
    .map(([name, value]) => `        <key>${xmlEscape(name)}</key>\n        <string>${xmlEscape(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xmlEscape(scriptPath)}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key><integer>1</integer>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logDir)}/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logDir)}/launchd.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;
}

/**
 * Install via launchd on macOS.
 * @param {string} scriptPath
 * @param {string} logDir
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {{ method: 'launchd', detail: string }}
 */
function installLaunchd(scriptPath, logDir, opts = {}) {
  const plistPath = getPlistPath();
  ensureDir(logDir);
  const plist = buildPlist(scriptPath, logDir, opts);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);

  try {
    const quoted = shellQuote(plistPath);
    childProcess.execSync(`launchctl unload ${quoted} 2>/dev/null; launchctl load ${quoted}`);
    const detail = `Scheduled - runs every 1st of the month at 9am.\n   Plist: ${plistPath}`;
    return { method: 'launchd', detail };
  } catch (err) {
    const detail = `launchctl error: ${err.message.slice(0, 80)}\n   Manually load with: launchctl load ${shellQuote(plistPath)}`;
    return { method: 'launchd', detail };
  }
}

/**
 * Build systemd user unit file contents.
 * @param {string} scriptPath
 * @param {string} logDir
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {{ service: string, timer: string }}
 */
function buildSystemdUnits(scriptPath, logDir, opts = {}) {
  const { env, nodeBinDir } = resolveJobOptions(opts);
  const environment = [['PATH', buildJobPath(nodeBinDir)], ...carriedEnvironment(env)]
    .map(([name, value]) => systemdEnvironment(name, value))
    .join('\n');

  const service = `[Unit]
Description=auto-identity-remove monthly opt-out runner
After=network.target

[Service]
Type=oneshot
${environment}
ExecStart=/bin/bash ${systemdArg(scriptPath)}
StandardOutput=append:${systemdSpecifierEscape(logDir)}/systemd.log
StandardError=append:${systemdSpecifierEscape(logDir)}/systemd.error.log

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
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {{ method: 'systemd'|'crontab', detail: string }}
 */
function installLinux(scriptPath, logDir, opts = {}) {
  // Probe for systemd
  let hasSystemd = false;
  try {
    childProcess.execSync('which systemctl', { stdio: 'pipe' });
    hasSystemd = true;
  } catch (_) {
    hasSystemd = false;
  }

  if (hasSystemd) {
    return installSystemd(scriptPath, logDir, opts);
  }
  return installCrontab(scriptPath, logDir, opts);
}

/**
 * Install via systemd user timer.
 * @param {string} scriptPath
 * @param {string} logDir
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {{ method: 'systemd', detail: string }}
 */
function installSystemd(scriptPath, logDir, opts = {}) {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  ensureDir(logDir);

  const { service, timer } = buildSystemdUnits(scriptPath, logDir, opts);
  fs.writeFileSync(path.join(unitDir, `${JOB_NAME}.service`), service);
  fs.writeFileSync(path.join(unitDir, `${JOB_NAME}.timer`), timer);

  try {
    childProcess.execSync(
      `systemctl --user daemon-reload && systemctl --user enable --now ${JOB_NAME}.timer`,
      { stdio: 'pipe' }
    );
    const detail =
      `Systemd user timer enabled - runs every 1st of the month at 9am.\n` +
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
 * Build the crontab line for the monthly job: pin PATH to the installing node,
 * carry the AIDR_* path variables, quote every path, and log to
 * <logDir>/cron.log (cron mails or drops output otherwise).
 *
 * @param {string} scriptPath  absolute path to run.sh
 * @param {string} logDir
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {string}
 */
function buildCronLine(scriptPath, logDir, opts = {}) {
  const { env, nodeBinDir } = resolveJobOptions(opts);
  const logFile = `${logDir}/cron.log`;
  // A newline would end the crontab line mid-command and run the rest as a new entry.
  if (/[\r\n]/.test(scriptPath) || /[\r\n]/.test(logFile) || /[\r\n]/.test(nodeBinDir)) {
    throw new Error('cannot schedule a path containing a newline');
  }
  const assignments = [['PATH', buildJobPath(nodeBinDir)], ...carriedEnvironment(env)]
    .map(([name, value]) => `${name}=${cronQuote(value)}`)
    .join(' ');
  return `0 9 1 * * ${assignments} /bin/bash ${cronQuote(scriptPath)} >> ${cronQuote(logFile)} 2>&1 ${CRON_MARKER}`;
}

/**
 * Compose the new crontab: the user's existing content, unchanged, with our
 * monthly line appended.
 *
 * Pure so the preservation guarantee is directly testable. It is the whole point
 * of this function: whatever `crontab -l` produced must come back out byte for
 * byte, metacharacters and all.
 *
 * @param {string} existing  raw output of `crontab -l` ('' when there is none)
 * @param {string} cronLine  the line to append
 * @returns {string} payload for `crontab -` stdin, newline-terminated
 */
function buildCrontabPayload(existing, cronLine) {
  const body = String(existing == null ? '' : existing).replace(/\n+$/, '');
  return (body ? body + '\n' : '') + cronLine + '\n';
}

/**
 * Add our line to a crontab, or bring our earlier line for the same script up to
 * date, leaving every other line byte for byte as it was.
 *
 * "Ours" is deliberately narrow: the exact legacy line (`0 9 1 * * /bin/bash
 * <script>`) or a line carrying our trailing marker that runs this script. A
 * hand-written line that merely mentions the script (say a weekly --dry-run) is
 * the user's and is never touched.
 *
 * @param {string} existing    raw output of `crontab -l`
 * @param {string} cronLine    the line buildCronLine produced
 * @param {string} scriptPath  the script that line runs
 * @returns {{ status: 'added'|'updated'|'unchanged', payload: string }}
 */
function buildCrontabUpdate(existing, cronLine, scriptPath) {
  const body = String(existing == null ? '' : existing).replace(/\n+$/, '');
  const lines = body === '' ? [] : body.split('\n');

  const legacyLines = new Set([
    `0 9 1 * * /bin/bash ${scriptPath}`,
    `0 9 1 * * /bin/bash ${shellQuote(scriptPath)}`,
  ]);
  const invocation = `/bin/bash ${cronQuote(scriptPath)} `;
  const isOurs = line => legacyLines.has(line.trim()) ||
    (line.trimEnd().endsWith(CRON_MARKER) && line.includes(invocation));

  const ours = lines.filter(isOurs);
  if (ours.length === 1 && ours[0] === cronLine) {
    return { status: 'unchanged', payload: String(existing) };
  }
  const kept = lines.filter(line => !isOurs(line));
  return {
    status: ours.length > 0 ? 'updated' : 'added',
    payload: buildCrontabPayload(kept.join('\n'), cronLine),
  };
}

function installCrontab(scriptPath, logDir, opts = {}) {
  let cronLine;
  try {
    cronLine = buildCronLine(scriptPath, logDir, opts);
  } catch (err) {
    return { method: 'crontab', detail: `crontab error: ${err.message}\n   Choose an install path without newlines.` };
  }
  ensureDir(logDir);

  try {
    // Read existing crontab
    let existing = '';
    try {
      existing = childProcess.execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    } catch (_) {
      existing = '';
    }

    const update = buildCrontabUpdate(existing, cronLine, scriptPath);
    if (update.status === 'unchanged') {
      return { method: 'crontab', detail: 'Crontab entry already present - no changes made.' };
    }

    // argv + stdin, never a shell: the user's existing crontab lines must come
    // back out byte for byte. See _realStdinRunner.
    const written = _feedStdin('crontab', ['-'], update.payload);
    if (written.status !== 0) {
      return {
        method: 'crontab',
        detail: `crontab error: ${(written.stderr || 'non-zero exit').slice(0, 80)}\n   Manually add: ${cronLine}`,
      };
    }
    const verb = update.status === 'updated' ? 'updated' : 'added';
    return {
      method: 'crontab',
      detail: `Crontab entry ${verb} - runs every 1st of the month at 9am.\n   Line: ${cronLine}`,
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
 *
 * schtasks is run with an argv array, not a shell string: cmd.exe tracks quote
 * state across the \" we need inside /TR, so an & in a path would otherwise be
 * taken as a command separator.
 *
 * @param {string} scriptPath
 * @param {{ env?: NodeJS.ProcessEnv, nodeExe?: string }} [opts]
 * @returns {{ method: 'schtasks'|'manual', detail: string }}
 */
function installWindows(scriptPath, logDir, opts = {}) {
  const { env } = resolveJobOptions(opts);
  // On Windows, node.exe is used to run the watcher directly
  const nodeExe = opts.nodeExe || process.execPath;
  const watcherPath = path.win32.join(path.win32.dirname(scriptPath), 'watcher.js');

  const schtasksArgs = buildWindowsSchtasksArgs(nodeExe, watcherPath);
  const schtasksCmd = buildWindowsSchtasksCmd(nodeExe, watcherPath);

  // schtasks cannot carry environment variables into a task.
  const passphraseNote = carriedEnvironment(env).some(([name]) => name === 'AIDR_PASSPHRASE_FILE')
    ? '\n   AIDR_PASSPHRASE_FILE is set, but Task Scheduler tasks do not inherit it: set it for your user with' +
      '\n   `setx AIDR_PASSPHRASE_FILE <path>` (also AIDR_CONFIG_PATH / AIDR_CONFIG_ENC_PATH if you use them).'
    : '';

  try {
    childProcess.execFileSync('schtasks', schtasksArgs, { stdio: 'pipe' });
    return {
      method: 'schtasks',
      detail: `Windows Task Scheduler task "${JOB_NAME}" created - runs every 1st of the month at 9am.${passphraseNote}`,
    };
  } catch (err) {
    console.log(`\n⚠  Task Scheduler error: ${err.message.slice(0, 120)}`);
    console.log('   Run this command manually as Administrator:');
    console.log(`   ${schtasksCmd}\n`);
    return {
      method: 'manual',
      detail: `Could not create scheduled task automatically.\n   Run manually: ${schtasksCmd}${passphraseNote}`,
    };
  }
}

// ─── Pure helpers (testable without OS calls) ────────────────────────────────

/**
 * The argv for `schtasks /Create`. /TR is ONE value: the quoted node path and
 * the quoted watcher path (a task action is a single command line).
 *
 * @param {string} nodeExePath   Absolute path to node.exe
 * @param {string} watcherPath   Absolute path to watcher.js
 * @param {{ hour?: number, minute?: number }} [opts]
 * @returns {string[]}
 */
function buildWindowsSchtasksArgs(nodeExePath, watcherPath, opts = {}) {
  const hour   = (opts.hour   !== undefined) ? opts.hour   : 9;
  const minute = (opts.minute !== undefined) ? opts.minute : 0;
  const time   = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return [
    '/Create', '/F', '/SC', 'MONTHLY', '/D', '1', '/ST', time,
    '/TN', JOB_NAME,
    '/TR', `"${nodeExePath}" "${watcherPath}"`,
  ];
}

/**
 * The same command as one string, for display and the manual fallback. The inner
 * quotes of /TR are escaped (\") so the whole task action stays one argument.
 * Pure function - no OS calls - so tests can inspect the command string directly.
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
  const tr     = `"\\"${nodeExePath}\\" \\"${watcherPath}\\""`;

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
 * @param {{ platform: 'macos'|'linux'|'windows'|string, scriptPath: string, logDir: string,
 *           env?: NodeJS.ProcessEnv, nodeBinDir?: string }} opts
 *   env is the installing shell's environment (default process.env): the AIDR_*
 *   path variables in it (AIDR_PASSPHRASE_FILE, ...) are carried into the job.
 * @returns {{ method: string, detail: string }}
 */
function installScheduleForPlatform({ platform, scriptPath, logDir, env, nodeBinDir }) {
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir, { env, nodeBinDir });
}

/**
 * Return the scheduler function for the given platform string.
 * Exposed for unit testing - callers pass 'macos'|'linux'|'windows'.
 * @param {'macos'|'linux'|'windows'} platform
 * @returns {(scriptPath: string, logDir: string, opts?: object) => { method: string, detail: string }}
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
 * @param {{ scriptPath: string, logDir: string, env?: NodeJS.ProcessEnv, nodeBinDir?: string }} options
 *   scriptPath - absolute path to run.sh (or watcher.js on Windows)
 *   logDir     - absolute path to the logs directory (created if absent)
 * @returns {{ method: 'launchd'|'systemd'|'crontab'|'schtasks'|'manual', detail: string }}
 */
function installSchedule({ scriptPath, logDir, env, nodeBinDir }) {
  fs.mkdirSync(logDir, { recursive: true });
  const platform = getPlatform();
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir, { env, nodeBinDir });
}

module.exports = {
  installSchedule,
  installScheduleForPlatform,
  pickScheduler,
  buildCrontabPayload,
  buildCrontabUpdate,
  buildCronLine,
  _setStdinRunner,
  buildPlist,
  buildSystemdUnits,
  buildWindowsSchtasksCmd,
  buildWindowsSchtasksArgs,
  shellQuote,
  cronQuote,
  xmlEscape,
  systemdArg,
  carriedEnvironment,
  buildJobPath,
};
