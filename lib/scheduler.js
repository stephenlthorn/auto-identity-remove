/**
 * lib/scheduler.js
 *
 * Cross-platform scheduling for auto-identity-remove.
 * Exports installSchedule({ scriptPath, logDir, env? }) which returns
 * { ok, method, detail }: whether the job now exists, how it was registered, and
 * what to tell the user. `ok` is false whenever the OS scheduler refused (a
 * crontab write that failed, a launchctl load that did not take, a schtasks that
 * was denied, no cron in a container): callers must say "NOT installed" and exit
 * non-zero then (CLI2-4). Every generated
 * payload quotes/escapes its paths, pins PATH to the installing node, and
 * carries AIDR_PASSPHRASE_FILE (never the passphrase) when it is set.
 *
 * Supported platforms:
 *   macOS   → launchd plist (~/.../LaunchAgents/com.auto-identity-remove.plist)
 *   Linux   → systemd user timer; falls back to crontab
 *   Windows → schtasks; prints command on failure instead of throwing
 *
 * getScheduleStatus() and uninstallSchedule() (R4) inspect and remove ONLY the
 * job installed here, through an injectable runner (see _setRunner): argv in,
 * { status, stdout, stderr } out, no shell. Tests stub it; nothing in them can
 * reach the real crontab, launchd, systemd or Task Scheduler.
 */

'use strict';

const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const childProcess = require('child_process');

const { getPlatform } = require('./platform');
const { readHeartbeat, defaultHeartbeatPath } = require('./heartbeat');

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
//
// AIDR_HOME / AIDR_LOG_DIR / AIDR_DATA_DIR (R0) matter as much as the config path:
// a job that does not see them reads the app directory's (empty) config and writes
// its logs and history somewhere the installing shell never meant.
const CARRIED_ENV_VARS = [
  'AIDR_PASSPHRASE_FILE', 'AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH',
  'AIDR_HOME', 'AIDR_LOG_DIR', 'AIDR_DATA_DIR',
];

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
 * The runner behind getScheduleStatus() and uninstallSchedule(): one command as
 * argv (no shell) plus optional stdin, answered as { status, stdout, stderr }.
 * A command that is not installed answers status 127 instead of throwing, which
 * is how a missing crontab or systemctl reads as "nothing there" rather than a
 * crash.
 *
 * Tests pass their own `runner` option or replace this one with _setRunner, so
 * nothing in a test run can reach the real crontab, launchd or Task Scheduler.
 *
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function _realRunner(cmd, args, input) {
  const r = childProcess.spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20000,
    windowsHide: true,
  });
  if (r.error) return { status: r.error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let _runner = _realRunner;

/** Test seam: replace the status/uninstall runner. Call with no argument to restore. */
function _setRunner(fn) {
  _runner = fn || _realRunner;
}

/** Run one command through `runner` and normalise whatever it answered. */
function runCommand(runner, cmd, args, input) {
  const answer = runner(cmd, args, input) || {};
  return {
    status: Number.isInteger(answer.status) ? answer.status : 1,
    stdout: String(answer.stdout == null ? '' : answer.stdout),
    stderr: String(answer.stderr == null ? '' : answer.stderr),
  };
}

/**
 * Returns the launchd plist path (evaluated lazily so tests can patch os.homedir).
 * @returns {string}
 */
function getPlistPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${PLIST_ID}.plist`);
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

/** The first line of what a failed command said, for a one-line reason. */
function failureReason(err) {
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  const text = stderr || (err && err.message ? String(err.message) : 'failed');
  return text.split('\n')[0].slice(0, 120);
}

/**
 * Install via launchd on macOS.
 * @param {string} scriptPath
 * @param {string} logDir
 * @param {{ env?: NodeJS.ProcessEnv, nodeBinDir?: string }} [opts]
 * @returns {{ ok: boolean, method: 'launchd', detail: string }}
 */
function installLaunchd(scriptPath, logDir, opts = {}) {
  const plistPath = getPlistPath();
  ensureDir(logDir);
  const plist = buildPlist(scriptPath, logDir, opts);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);

  try {
    const quoted = shellQuote(plistPath);
    childProcess.execSync(`launchctl unload ${quoted} 2>/dev/null; launchctl load ${quoted}`, { stdio: 'pipe' });
    // `launchctl load` has exited 0 on a load that failed: the job has to show up
    // in `launchctl list` before it counts as installed.
    childProcess.execSync(`launchctl list ${PLIST_ID}`, { stdio: 'pipe' });
    const detail = `Scheduled - runs every 1st of the month at 9am.\n   Plist: ${plistPath}`;
    return { ok: true, method: 'launchd', detail };
  } catch (err) {
    const detail = `launchctl error: ${failureReason(err)}\n   Manually load with: launchctl load ${shellQuote(plistPath)}`;
    return { ok: false, method: 'launchd', detail };
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
 * @returns {{ ok: boolean, method: 'systemd'|'crontab', detail: string }}
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
 * @returns {{ ok: boolean, method: 'systemd', detail: string }}
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
    return { ok: true, method: 'systemd', detail };
  } catch (err) {
    const detail =
      `systemctl error: ${failureReason(err)}\n` +
      `   Manually enable with: systemctl --user daemon-reload && systemctl --user enable --now ${JOB_NAME}.timer`;
    return { ok: false, method: 'systemd', detail };
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
    return { ok: false, method: 'crontab', detail: `crontab error: ${err.message}\n   Choose an install path without newlines.` };
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
      return { ok: true, method: 'crontab', detail: 'Crontab entry already present - no changes made.' };
    }

    // argv + stdin, never a shell: the user's existing crontab lines must come
    // back out byte for byte. See _realStdinRunner.
    const written = _feedStdin('crontab', ['-'], update.payload);
    if (written.status !== 0) {
      return {
        ok: false,
        method: 'crontab',
        detail: `crontab error: ${(written.stderr || 'non-zero exit').trim().slice(0, 80)}\n   Manually add: ${cronLine}`,
      };
    }
    const verb = update.status === 'updated' ? 'updated' : 'added';
    return {
      ok: true,
      method: 'crontab',
      detail: `Crontab entry ${verb} - runs every 1st of the month at 9am.\n   Line: ${cronLine}`,
    };
  } catch (err) {
    return {
      ok: false,
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
 * @returns {{ ok: boolean, method: 'schtasks'|'manual', detail: string }}
 */
function installWindows(scriptPath, logDir, opts = {}) {
  const { env } = resolveJobOptions(opts);
  // On Windows, node.exe is used to run the watcher directly
  const nodeExe = opts.nodeExe || process.execPath;
  const watcherPath = path.win32.join(path.win32.dirname(scriptPath), 'watcher.js');

  const schtasksArgs = buildWindowsSchtasksArgs(nodeExe, watcherPath);
  const schtasksCmd = buildWindowsSchtasksCmd(nodeExe, watcherPath);

  // schtasks cannot carry environment variables into a task.
  const carried = carriedEnvironment(env).map(([name]) => name);
  const many = carried.length > 1;
  const passphraseNote = carried.length > 0
    ? `\n   ${carried.join(', ')} ${many ? 'are' : 'is'} set, but Task Scheduler tasks do not inherit environment variables: set ${many ? 'each' : 'it'} for your user, for example` +
      `\n   \`setx ${carried[0]} <path>\`.`
    : '';

  try {
    childProcess.execFileSync('schtasks', schtasksArgs, { stdio: 'pipe' });
    return {
      ok: true,
      method: 'schtasks',
      detail: `Windows Task Scheduler task "${JOB_NAME}" created - runs every 1st of the month at 9am.${passphraseNote}`,
    };
  } catch (err) {
    console.log(`\n⚠  Task Scheduler error: ${err.message.slice(0, 120)}`);
    console.log('   Run this command manually as Administrator:');
    console.log(`   ${schtasksCmd}\n`);
    return {
      ok: false,
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
 * @returns {{ ok: boolean, method: string, detail: string }}
 */
function installScheduleForPlatform({ platform, scriptPath, logDir, env, nodeBinDir }) {
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir, { env, nodeBinDir });
}

/**
 * Return the scheduler function for the given platform string.
 * Exposed for unit testing - callers pass 'macos'|'linux'|'windows'.
 * @param {'macos'|'linux'|'windows'} platform
 * @returns {(scriptPath: string, logDir: string, opts?: object) => { ok: boolean, method: string, detail: string }}
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
 * @returns {{ ok: boolean, method: 'launchd'|'systemd'|'crontab'|'schtasks'|'manual', detail: string }}
 */
function installSchedule({ scriptPath, logDir, env, nodeBinDir }) {
  fs.mkdirSync(logDir, { recursive: true });
  const platform = getPlatform();
  const installer = pickScheduler(platform);
  return installer(scriptPath, logDir, { env, nodeBinDir });
}

// ─── Status and uninstall (R4) ───────────────────────────────────────────────
//
// Both look for OUR job only, by the identifiers the installers above write:
//   launchd  the com.auto-identity-remove plist (and the job of that label)
//   systemd  auto-identity-remove.{service,timer} in the user unit directory
//   cron     a line carrying our trailing marker, or the legacy line for this script
//   schtasks the task named auto-identity-remove

const TIMER_UNIT = `${JOB_NAME}.timer`;
const SERVICE_UNIT = `${JOB_NAME}.service`;

/** The run.sh of THIS install: where the installers point the job. */
function defaultScriptPath() {
  return path.resolve(__dirname, '..', 'run.sh');
}

const systemdUnitDir = homeDir => path.join(homeDir, '.config', 'systemd', 'user');

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function describeMonthly(day, hour, minute) {
  return `monthly, day ${Number(day)} at ${pad2(hour)}:${pad2(minute)}`;
}

function xmlUnescape(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Sort the (name, value) pairs of a job definition into what status reports:
 * the AIDR_* path variables the installer carries, and whether a passphrase
 * itself was written into the job (it never is by this installer, but a hand
 * edit can, and then it sits in a file other accounts can read). The value of
 * AIDR_PASSPHRASE is never copied anywhere.
 */
function carriedFromPairs(pairs) {
  const env = {};
  let plaintextPassphrase = false;
  for (const [name, value] of pairs) {
    if (CARRIED_ENV_VARS.includes(name)) env[name] = value;
    else if (name === 'AIDR_PASSPHRASE') plaintextPassphrase = true;
  }
  return { env, plaintextPassphrase };
}

/** `/bin/bash <script>` is shown as the script; any other command as itself. */
function targetOf(words) {
  if (words.length === 0) return null;
  if (words.length >= 2 && /(^|\/)(ba)?sh$/.test(words[0])) return words[1];
  return words.join(' ');
}

/** Split a command line the way a POSIX shell does for the quoting shellQuote() writes. */
function splitShellWords(text) {
  const words = [];
  let current = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) { words.push(current); current = ''; inWord = false; }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

// ── launchd ──

/** The dict body that follows <key>name</key>, or null. */
function plistDict(xml, name) {
  const m = xml.match(new RegExp(`<key>${name}</key>\\s*<dict>([\\s\\S]*?)</dict>`));
  return m ? m[1] : null;
}

function plistPairs(body, valueTag) {
  if (body === null) return [];
  const re = new RegExp(`<key>([^<]*)</key>\\s*<${valueTag}>([^<]*)</${valueTag}>`, 'g');
  return [...body.matchAll(re)].map(m => [xmlUnescape(m[1]), xmlUnescape(m[2])]);
}

function parsePlist(xml) {
  const arrayMatch = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const args = arrayMatch ? [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => xmlUnescape(m[1])) : [];

  const calendar = Object.fromEntries(plistPairs(plistDict(xml, 'StartCalendarInterval'), 'integer'));
  const keys = Object.keys(calendar);
  const monthly = 'Day' in calendar && keys.every(k => ['Day', 'Hour', 'Minute'].includes(k));
  const schedule = monthly
    ? describeMonthly(calendar.Day, calendar.Hour || 0, calendar.Minute || 0)
    : keys.length > 0 ? 'custom calendar interval' : null;

  return { target: targetOf(args), schedule, ...carriedFromPairs(plistPairs(plistDict(xml, 'EnvironmentVariables'), 'string')) };
}

function readLaunchdJob({ homeDir, runner }) {
  const plistPath = getPlistPath(homeDir);
  let xml;
  try {
    xml = fs.readFileSync(plistPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    xml = '';
  }
  const parsed = parsePlist(xml);

  // A plist launchd has not loaded never fires; 127 means launchctl itself could not run.
  const loaded = runCommand(runner, 'launchctl', ['list', PLIST_ID]);
  const active = loaded.status === 0 ? true : loaded.status === 127 ? null : false;
  return { kind: 'launchd', location: plistPath, active, envVisible: true, ...parsed };
}

// ── systemd ──

/** Undo the quoting systemdEnvironment() writes (backslash, quote, %). */
function systemdUnquote(text) {
  return text.replace(/\\(["\\])/g, '$1').replace(/%%/g, '%');
}

/** Split an ExecStart= value and undo the quoting systemdArg() writes. */
function splitSystemdWords(text) {
  const words = [];
  let current = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      else if (ch === '\\' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === '"') {
      quoted = true;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) { words.push(current); current = ''; inWord = false; }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words.map(word => word.replace(/%%/g, '%').replace(/\$\$/g, '$'));
}

function describeOnCalendar(value) {
  const m = value.trim().match(/^\*-\*-(\d{1,2}) (\d{2}):(\d{2})(?::\d{2})?$/);
  return m ? describeMonthly(m[1], m[2], m[3]) : `OnCalendar=${value.trim()}`;
}

function parseSystemdUnits(service, timer) {
  let target = null;
  const pairs = [];
  for (const line of (service || '').split('\n')) {
    const start = line.match(/^ExecStart=(.*)$/);
    if (start) target = targetOf(splitSystemdWords(start[1]));
    const environment = line.match(/^Environment=(.*)$/);
    if (environment) {
      const raw = environment[1].trim();
      const inner = raw.startsWith('"') && raw.endsWith('"') ? systemdUnquote(raw.slice(1, -1)) : raw;
      const eq = inner.indexOf('=');
      if (eq > 0) pairs.push([inner.slice(0, eq), inner.slice(eq + 1)]);
    }
  }
  const calendar = (timer || '').match(/^OnCalendar=(.*)$/m);
  return { target, schedule: calendar ? describeOnCalendar(calendar[1]) : null, ...carriedFromPairs(pairs) };
}

function readSystemdJob({ homeDir, runner }) {
  const dir = systemdUnitDir(homeDir);
  const service = readTextOrNull(path.join(dir, SERVICE_UNIT));
  const timer = readTextOrNull(path.join(dir, TIMER_UNIT));
  if (service === null && timer === null) return null;

  // No user bus (ssh without a session, a container) is "cannot tell", not "disabled".
  const enabled = runCommand(runner, 'systemctl', ['--user', 'is-enabled', TIMER_UNIT]);
  const noBus = /Failed to connect|No medium found|bus/i.test(enabled.stderr);
  const active = enabled.status === 0 ? true : (enabled.status === 127 || noBus) ? null : false;
  return { kind: 'systemd', location: dir, active, envVisible: true, ...parseSystemdUnits(service, timer) };
}

// ── cron ──

/**
 * Is this crontab line the one this tool installed?
 *
 * Deliberately narrow, like buildCrontabUpdate's: a line carrying our trailing
 * marker after a /bin/bash command (the marker is our signature, so any such
 * line is ours whichever checkout wrote it), or the exact legacy line for THIS
 * script. A comment, or a hand-written line that merely mentions the script, is
 * the user's and is never ours.
 */
function isOurCronLine(line, scriptPath) {
  const text = line.trim();
  if (text === '' || text.startsWith('#')) return false;
  if (text.endsWith(CRON_MARKER) && /\s\/bin\/bash\s/.test(text)) return true;
  if (!scriptPath) return false;
  return text === `0 9 1 * * /bin/bash ${scriptPath}` || text === `0 9 1 * * /bin/bash ${shellQuote(scriptPath)}`;
}

function describeCron(fields) {
  const [minute, hour, day, month, weekday] = fields;
  const numeric = value => /^\d+$/.test(value);
  if (numeric(minute) && numeric(hour) && numeric(day) && month === '*' && weekday === '*') {
    return describeMonthly(day, hour, minute);
  }
  return `cron ${fields.join(' ')}`;
}

function parseCronLine(line, scriptPath) {
  const m = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
  if (!m) return { schedule: null, target: null, env: {}, plaintextPassphrase: false };
  const words = splitShellWords(m[6].replace(/\\%/g, '%'));
  const pairs = [];
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const word = words.shift();
    const eq = word.indexOf('=');
    pairs.push([word.slice(0, eq), word.slice(eq + 1)]);
  }
  // The legacy line has no marker and may hold an unquoted path with spaces,
  // which word splitting would cut short; it was matched against this script.
  const legacy = !line.trimEnd().endsWith(CRON_MARKER);
  return {
    schedule: describeCron(m.slice(1, 6)),
    target: legacy && scriptPath ? scriptPath : targetOf(words),
    ...carriedFromPairs(pairs),
  };
}

function readCronJob({ runner, scriptPath }) {
  const listed = runCommand(runner, 'crontab', ['-l']);
  if (listed.status !== 0) return null;
  const line = listed.stdout.split('\n').find(candidate => isOurCronLine(candidate, scriptPath));
  if (line === undefined) return null;
  return { kind: 'cron', location: 'crontab', active: true, envVisible: true, ...parseCronLine(line, scriptPath) };
}

// ── Task Scheduler ──

function readSchtasksJob({ runner }) {
  // /XML so the answer does not depend on the Windows display language.
  const queried = runCommand(runner, 'schtasks', ['/Query', '/TN', JOB_NAME, '/XML']);
  if (queried.status !== 0) return null;
  const xml = queried.stdout;

  const tag = name => {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? xmlUnescape(m[1].trim()) : null;
  };
  const time = xml.match(/<StartBoundary>[^T<]*T(\d{2}):(\d{2})/);
  const day = xml.match(/<DaysOfMonth>\s*<Day>(\d+)<\/Day>/);
  const schedule = time && day && /<ScheduleByMonth>/.test(xml) ? describeMonthly(day[1], time[1], time[2]) : null;

  const command = tag('Command');
  const args = tag('Arguments');
  const target = command ? [command, args].filter(Boolean).join(' ') : null;

  const settings = xml.match(/<Settings>([\s\S]*?)<\/Settings>/);
  const trigger = xml.match(/<CalendarTrigger>([\s\S]*?)<\/CalendarTrigger>/);
  const disabled = [settings, trigger].some(block => block && /<Enabled>\s*false\s*<\/Enabled>/i.test(block[1]));

  // A task carries no environment, so there is nothing to read: the caller is told
  // the variables are not visible rather than that they are absent.
  return {
    kind: 'schtasks', location: JOB_NAME, active: !disabled, envVisible: false,
    schedule, target, env: {}, plaintextPassphrase: false,
  };
}

// ── getScheduleStatus ──

/**
 * What the scheduled job looks like right now.
 *
 * @param {{ platform?: string, runner?: Function, homeDir?: string, scriptPath?: string,
 *           heartbeatPath?: string, now?: number, env?: NodeJS.ProcessEnv }} [opts]
 *   platform      'macos' | 'linux' | 'windows' (default: this machine; anything else reads as linux)
 *   runner        (cmd, args, input) => { status, stdout, stderr }; default is the real one
 *   homeDir       where the plist / unit files live (default os.homedir())
 *   scriptPath    this install's run.sh, for matching the legacy cron line
 *   heartbeatPath last-run.json (default: beside state.json)
 * @returns {{
 *   installed: boolean,
 *   kind: 'launchd'|'systemd'|'cron'|'schtasks'|null,
 *   kinds: string[],              every kind found (a cron line left behind by an older install)
 *   schedule: string|null,        human readable, e.g. 'monthly, day 1 at 09:00'
 *   target: string|null,          the script or command the job runs
 *   active: boolean|null,         loaded/enabled; null when it could not be asked
 *   env: object,                  the AIDR_* path variables the job carries
 *   envVisible: boolean,          (installed only) false where a job carries no environment (schtasks)
 *   plaintextPassphrase: boolean, AIDR_PASSPHRASE sits in the job definition
 *   location: string|null,
 *   lastRun: object|null,         the heartbeat of the last FULL run: { startedAt, finishedAt, outcome, counts },
 *                                 plus offline: true when it could not reach most sites (network or DNS)
 *   lastPartialRun: object|null,  a filtered run (--only, --retry-failed, ...) newer than it, same shape
 * }}
 */
function getScheduleStatus(opts = {}) {
  const platform = opts.platform || getPlatform();
  const ctx = {
    runner: opts.runner || _runner,
    homeDir: opts.homeDir || os.homedir(),
    scriptPath: opts.scriptPath || defaultScriptPath(),
  };

  const readers = platform === 'macos' ? [readLaunchdJob]
    : platform === 'windows' ? [readSchtasksJob]
      : [readSystemdJob, readCronJob];
  const jobs = readers.map(read => read(ctx)).filter(Boolean);

  // The newest record may be a PARTIAL run (--only, --retry-failed, ...). `lastRun`
  // is always the last FULL run, which is what says whether the monthly job works;
  // a newer partial one is reported beside it, never instead of it (CLI2-10).
  const latest = readHeartbeat(opts.heartbeatPath || defaultHeartbeatPath(), { now: opts.now, env: opts.env });
  const latestIsPartial = Boolean(latest) && latest.partial === true;
  const lastRun = latestIsPartial ? (latest.lastFull || null) : latest;
  const lastPartialRun = latestIsPartial
    ? {
      startedAt: latest.startedAt, finishedAt: latest.finishedAt, outcome: latest.outcome, counts: latest.counts,
      ...(latest.offline === true ? { offline: true } : {}),
    }
    : null;
  if (jobs.length === 0) {
    return {
      installed: false, kind: null, kinds: [], schedule: null, target: null, active: null,
      env: {}, plaintextPassphrase: false, location: null, lastRun, lastPartialRun,
    };
  }
  const [first] = jobs;
  return {
    installed: true,
    kind: first.kind,
    kinds: jobs.map(job => job.kind),
    schedule: first.schedule,
    target: first.target,
    active: first.active,
    env: first.env,
    envVisible: first.envVisible,
    plaintextPassphrase: jobs.some(job => job.plaintextPassphrase),
    location: first.location,
    lastRun,
    lastPartialRun,
  };
}

/** Plain-text lines for `aidr schedule status`. */
function formatScheduleStatus(status, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lines = [];
  if (!status.installed) {
    lines.push('Schedule: not installed');
    lines.push('  Install it with: aidr schedule install');
  } else {
    lines.push(`Schedule: installed (${status.kind})`);
    if (status.schedule) lines.push(`  When:     ${status.schedule}`);
    if (status.target) lines.push(`  Runs:     ${status.target}`);
    if (status.location) lines.push(`  Where:    ${status.location}`);
    if (status.active === true) lines.push('  Active:   yes');
    else if (status.active === false) lines.push('  Active:   NO - the job exists but will not fire. Run: aidr schedule install');
    else lines.push('  Active:   unknown (could not ask the system)');
    if (status.kinds && status.kinds.length > 1) {
      lines.push(`  Also found: ${status.kinds.slice(1).join(', ')} (a second job; aidr schedule uninstall removes them all)`);
    }
    if (status.plaintextPassphrase) {
      lines.push('  WARNING:  AIDR_PASSPHRASE is written into the job definition, readable by other accounts. Use AIDR_PASSPHRASE_FILE instead.');
    }
  }

  const describeRun = (run) => {
    const when = run.finishedAt || run.startedAt;
    const days = Math.floor((now - Date.parse(when)) / 86400000);
    const ago = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : 'today';
    const state = run.outcome === 'running' ? `started ${run.startedAt}, still running`
      : run.outcome === 'crashed' && !run.finishedAt ? `started ${run.startedAt}, never finished (crashed)`
        : `${run.finishedAt} - ${run.outcome}`;
    return { state, ago };
  };
  const countsOf = (run) => Object.entries(run.counts || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  // Why a run failed, when it was the machine and not the brokers (lib/outage.js).
  const OFFLINE_NOTE = 'Could not reach most sites: check the network or DNS.';

  const run = status.lastRun;
  if (!run) {
    lines.push(status.lastPartialRun ? '  Last run: no full run recorded yet' : '  Last run: no run recorded yet');
  } else if (run.unreadable) {
    lines.push('  Last run: unreadable (last-run.json is not a valid heartbeat)');
  } else {
    const { state, ago } = describeRun(run);
    lines.push(`  Last run: ${state} (${ago})`);
    const counts = countsOf(run);
    if (counts.length > 0) lines.push(`            ${counts.join(', ')}`);
    if (run.offline === true) lines.push(`            ${OFFLINE_NOTE}`);
  }

  const partial = status.lastPartialRun;
  if (partial) {
    const { state, ago } = describeRun(partial);
    lines.push(`  Partial:  ${state} (${ago}) - a filtered run (--only, --skip, --retry-failed, --captchas); it does not count as the monthly run`);
    if (partial.offline === true) lines.push(`            ${OFFLINE_NOTE}`);
  }
  return lines.join('\n');
}

// ── uninstallSchedule ──

function firstLine(text) {
  return String(text || '').trim().split('\n')[0].slice(0, 160);
}

function removeFileIfPresent(file, errors) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`could not delete ${file}: ${err.message}`);
    return false;
  }
}

function uninstallLaunchd({ homeDir, runner, uid }) {
  const plistPath = getPlistPath(homeDir);
  const errors = [];
  const warnings = [];
  const plistExists = fs.existsSync(plistPath);
  const isLoaded = () => runCommand(runner, 'launchctl', ['list', PLIST_ID]).status === 0;
  if (!plistExists && !isLoaded()) return { removed: false, errors, warnings };

  // bootout is the current verb; unload is what the installer used and what older macOS has.
  const bootout = runCommand(runner, 'launchctl', ['bootout', `gui/${uid}/${PLIST_ID}`]);
  if (bootout.status !== 0 && plistExists) runCommand(runner, 'launchctl', ['unload', plistPath]);

  // A job still loaded would keep firing, and deleting the plist would leave nobody
  // able to unload it by file: keep the plist and say how to finish the job.
  if (isLoaded()) {
    errors.push(`launchd would not unload ${PLIST_ID}; the plist was left in place. Run: launchctl bootout gui/${uid}/${PLIST_ID}`);
    return { removed: false, errors, warnings };
  }
  if (plistExists) removeFileIfPresent(plistPath, errors);
  if (errors.length > 0) return { removed: false, errors, warnings };
  return { removed: true, detail: `launchd job ${PLIST_ID} removed${plistExists ? ` (${plistPath})` : ''}`, errors, warnings };
}

function uninstallSystemd({ homeDir, runner }) {
  const dir = systemdUnitDir(homeDir);
  const errors = [];
  const warnings = [];
  const files = [SERVICE_UNIT, TIMER_UNIT].map(name => path.join(dir, name)).filter(file => fs.existsSync(file));
  if (files.length === 0) return { removed: false, errors, warnings };

  const disabled = runCommand(runner, 'systemctl', ['--user', 'disable', '--now', TIMER_UNIT]);
  if (disabled.status !== 0) {
    warnings.push(`systemctl could not disable ${TIMER_UNIT} (${firstLine(disabled.stderr) || `exit ${disabled.status}`}); the unit files were removed anyway`);
  }
  for (const file of files) removeFileIfPresent(file, errors);
  runCommand(runner, 'systemctl', ['--user', 'daemon-reload']);
  if (errors.length > 0) return { removed: false, errors, warnings };
  return { removed: true, detail: `systemd timer ${TIMER_UNIT} disabled and its unit files removed (${dir})`, errors, warnings };
}

function uninstallCron({ runner, scriptPath }) {
  const errors = [];
  const listed = runCommand(runner, 'crontab', ['-l']);
  // Nothing readable means nothing to remove, and writing now would replace a
  // crontab we could not see.
  if (listed.status !== 0) return { removed: false, errors, warnings: [] };

  const lines = listed.stdout.split('\n');
  const kept = lines.filter(line => !isOurCronLine(line, scriptPath));
  const dropped = lines.length - kept.length;
  if (dropped === 0) return { removed: false, errors, warnings: [] };

  const remaining = kept.join('\n');
  const written = remaining.trim() === ''
    ? runCommand(runner, 'crontab', ['-r'])
    : runCommand(runner, 'crontab', ['-'], remaining.endsWith('\n') ? remaining : remaining + '\n');
  if (written.status !== 0) {
    errors.push(`crontab could not be updated (${firstLine(written.stderr) || `exit ${written.status}`}); remove the "${CRON_MARKER}" line with: crontab -e`);
    return { removed: false, errors, warnings: [] };
  }
  return { removed: true, detail: `removed ${dropped} cron line${dropped === 1 ? '' : 's'} (every other line was left as it was)`, errors, warnings: [] };
}

function uninstallSchtasks({ runner }) {
  const errors = [];
  const queried = runCommand(runner, 'schtasks', ['/Query', '/TN', JOB_NAME, '/XML']);
  if (queried.status !== 0) return { removed: false, errors, warnings: [] };

  const deleted = runCommand(runner, 'schtasks', ['/Delete', '/TN', JOB_NAME, '/F']);
  if (deleted.status !== 0) {
    errors.push(`schtasks could not delete the task ${JOB_NAME}: ${firstLine(deleted.stderr || deleted.stdout) || `exit ${deleted.status}`}`);
    return { removed: false, errors, warnings: [] };
  }
  return { removed: true, detail: `Task Scheduler task ${JOB_NAME} deleted`, errors, warnings: [] };
}

/**
 * Remove the scheduled job this tool installed, and nothing else. Safe to run
 * again: with nothing installed it changes nothing and says so.
 *
 * launchd:  boot the job out, then delete our plist (kept if the job will not unload).
 * systemd:  disable the timer, delete our two unit files, reload.
 * cron:     drop our marker-tagged line (and this script's legacy line); every other
 *           line is written back byte for byte, and the crontab is only touched
 *           when one of ours was found.
 * schtasks: delete the task by name.
 *
 * @param {{ platform?: string, runner?: Function, homeDir?: string, scriptPath?: string, uid?: number }} [opts]
 * @returns {{ removed: boolean, kinds: string[], detail: string, errors: string[], warnings: string[] }}
 */
function uninstallSchedule(opts = {}) {
  const platform = opts.platform || getPlatform();
  const ctx = {
    runner: opts.runner || _runner,
    homeDir: opts.homeDir || os.homedir(),
    scriptPath: opts.scriptPath || defaultScriptPath(),
    uid: opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : 501),
  };

  const steps = platform === 'macos' ? [['launchd', uninstallLaunchd]]
    : platform === 'windows' ? [['schtasks', uninstallSchtasks]]
      : [['systemd', uninstallSystemd], ['cron', uninstallCron]];

  const kinds = [];
  const details = [];
  const errors = [];
  const warnings = [];
  for (const [kind, step] of steps) {
    const outcome = step(ctx);
    if (outcome.removed) {
      kinds.push(kind);
      details.push(outcome.detail);
    }
    errors.push(...outcome.errors);
    warnings.push(...outcome.warnings);
  }

  const detail = details.length > 0 ? details.join('\n')
    : errors.length > 0 ? 'The schedule could not be fully removed.'
      : 'No schedule installed - nothing to remove.';
  return { removed: kinds.length > 0, kinds, detail, errors, warnings };
}

module.exports = {
  installSchedule,
  installScheduleForPlatform,
  pickScheduler,
  buildCrontabPayload,
  buildCrontabUpdate,
  buildCronLine,
  _setStdinRunner,
  _setRunner,
  _realRunner,
  getScheduleStatus,
  formatScheduleStatus,
  uninstallSchedule,
  isOurCronLine,
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
