'use strict';
/**
 * lib/doctor.js
 *
 * Self-diagnose command. Called via `node watcher.js doctor` or `--doctor`.
 *
 * Each check is an async function returning `{ ok, hint }`.
 * Skipped checks use `ok: true` with a hint that says "skipped - not configured".
 *
 * `runDoctor(opts)` accepts optional dependency-injection overrides so the
 * module is fully testable without real filesystem/network I/O.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const http = require('http');
const https = require('https');
const { isPlaceholderKey } = require('./captcha');
const lock = require('./lock');
const { getScheduleStatus } = require('./scheduler');
const { defaultHeartbeatPath, lockMaxAgeMs } = require('./heartbeat');
const { describeParseError } = require('./config-check');
const { resolvePaths } = require('./paths');
const { browserConfigProblems } = require('./browser');
const {
  loadConfig, isConfigEncrypted, validateRunnableConfig, getStatePath,
  plaintextConfigCopies, legacyLayoutProblems, describeLegacyLayout,
  CONFIG_PATH, CONFIG_ENC_PATH,
} = require('./config');

// ── ANSI colour helpers (stripped when not a TTY) ────────────────────────────

const isTTY = process.stdout.isTTY;
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
};

// ── Individual check functions ───────────────────────────────────────────────

/**
 * Where doctor looks for the config. An explicit rootDir (tests, or a caller that
 * knows better) means <rootDir>/config.json[.enc]; with none, the same paths the
 * watcher uses, including the AIDR_CONFIG_PATH / AIDR_CONFIG_ENC_PATH overrides.
 */
function resolveConfigPaths(rootDir, opts = {}) {
  return {
    configPath: opts.configPath || (rootDir ? path.join(rootDir, 'config.json') : CONFIG_PATH),
    encPath:    opts.encPath    || (rootDir ? path.join(rootDir, 'config.json.enc') : CONFIG_ENC_PATH),
  };
}

/**
 * Load the config the way the watcher does (plaintext, config.json.enc, or an
 * in-place envelope; passphrase from opts, AIDR_PASSPHRASE or
 * AIDR_PASSPHRASE_FILE) without ever calling process.exit.
 *
 * @returns {{ status: 'absent'|'ok'|'error', cfg?: object, encrypted?: boolean, hint?: string }}
 */
function loadDoctorConfig(rootDir, opts = {}) {
  const paths = resolveConfigPaths(rootDir, opts);
  if (!fs.existsSync(paths.encPath) && !fs.existsSync(paths.configPath)) {
    // The old single-file Docker recipe leaves the config at the app directory
    // while AIDR_HOME points elsewhere (CFG2-8): name both places. An explicit
    // rootDir is its own home, so there is no "old" place to look in.
    const legacy = rootDir ? [] : describeLegacyLayout(legacyLayoutProblems({ ...paths, legacyRoot: opts.legacyRoot }));
    return {
      status: 'absent',
      hint: legacy.length ? `config.json not found. ${legacy.join(' ')}` : 'config.json not found - run `node setup.js`',
    };
  }
  try {
    const cfg = loadConfig({ ...paths, passphrase: opts.passphrase, _warn: () => {} });
    return { status: 'ok', cfg, encrypted: isConfigEncrypted(paths) };
  } catch (e) {
    // The same wording `aidr config check` uses: a SyntaxError message can quote
    // the bytes it choked on, and in a config those bytes are a person's details.
    const hint = e instanceof SyntaxError
      ? `config.json failed to parse: ${describeParseError(e)}`
      : `config could not be loaded: ${e.message}`;
    return { status: 'error', hint };
  }
}

/**
 * Check 1: the config exists (plaintext or encrypted), loads, and has the four
 * required person fields, none of them still a config.example.json placeholder.
 *
 * @param {string} [rootDir]  Project root (injectable for tests); omit for the real paths.
 * @param {{ passphrase?: string, configPath?: string, encPath?: string }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkConfig(rootDir, opts = {}) {
  const loaded = loadDoctorConfig(rootDir, opts);
  if (loaded.status !== 'ok') return { ok: false, hint: loaded.hint };
  const cfg = loaded.cfg;

  // Accept either the single-person "person" key or the multi-person
  // "persons" array, matching the precedence in lib/config.js
  // getPersonsFromConfig() (persons wins when both are present).
  let persons;
  if (cfg.persons !== undefined) {
    if (!Array.isArray(cfg.persons) || cfg.persons.length === 0) {
      return { ok: false, hint: 'config.json: persons must be a non-empty array' };
    }
    persons = cfg.persons;
  } else if (cfg.person && typeof cfg.person === 'object') {
    persons = [cfg.person];
  } else {
    return { ok: false, hint: 'config.json missing person section' };
  }

  const required = ['firstName', 'lastName', 'email', 'zip'];
  for (let i = 0; i < persons.length; i++) {
    const label = persons.length > 1 ? `persons[${i}]` : 'person';
    if (!persons[i] || typeof persons[i] !== 'object') {
      return { ok: false, hint: `config.json: ${label} is not an object` };
    }
    for (const field of required) {
      if (!persons[i][field]) {
        return { ok: false, hint: `config.json missing ${label}.${field}` };
      }
    }
  }

  // Same gate the watcher applies before a run: a copied-but-unedited example
  // config parses fine and would run as "Jane Doe".
  // A malformed browser section stops the launch, so it is a problem here too (R7).
  const problems = [...validateRunnableConfig(cfg), ...browserConfigProblems(cfg.browser)];
  if (problems.length > 0) {
    return { ok: false, hint: `config.json is not runnable: ${problems.join('; ')}` };
  }

  const ok = `config.json valid, person fields present${loaded.encrypted ? ' (encrypted)' : ''}`;
  // The encrypted config is only as private as the copies beside it: the dashboard's
  // .bak files, a kept plaintext, a killed write's temp file (CFG2-5).
  const copies = plaintextConfigCopies(resolveConfigPaths(rootDir, opts));
  if (copies.length > 0) {
    return {
      ok: true,
      warn: true,
      hint: `${ok}, but ${copies.length === 1 ? 'a plain text copy' : `${copies.length} plain text copies`} of it ` +
        `sit${copies.length === 1 ? 's' : ''} beside the encrypted one: ${copies.join(', ')} - delete ${copies.length === 1 ? 'it' : 'them'}`,
    };
  }
  return { ok: true, hint: ok };
}

/**
 * Check 2: Playwright can be required and the Chromium binary exists.
 *
 * Accepts an opts object for dependency injection in tests:
 *   opts.requirePlaywright - function that returns the playwright module
 *   opts.fsExists          - function(path) => boolean
 *
 * @param {{ requirePlaywright?: () => any, fsExists?: (p: string) => boolean }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkPlaywright(opts = {}) {
  const requirePlaywright = opts.requirePlaywright || (() => require('playwright'));
  const fsExists          = opts.fsExists          || ((p) => fs.existsSync(p));

  let pw;
  try {
    pw = requirePlaywright();
  } catch (e) {
    return { ok: false, hint: `playwright not installed - run \`npx playwright install chromium\`: ${e.message}` };
  }

  let binPath;
  try {
    binPath = pw.chromium.executablePath();
  } catch (e) {
    return { ok: false, hint: `Could not resolve chromium path: ${e.message}` };
  }

  if (!fsExists(binPath)) {
    return { ok: false, hint: `chromium binary not found - run \`npx playwright install chromium\` (expected: ${binPath})` };
  }

  return { ok: true, hint: `chromium installed at ${binPath}` };
}

/**
 * Check 3: SMTP host is reachable via TCP (if configured).
 *
 * @param {object} cfg  Parsed config object.
 * @param {{ tcpProbe?: (host: string, port: number) => Promise<boolean> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkSMTP(cfg, opts = {}) {
  const host = cfg?.email?.smtp?.host;
  const port = cfg?.email?.smtp?.port || 587;

  if (!host) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  const tcpProbe = opts.tcpProbe || defaultTcpProbe;

  try {
    await tcpProbe(host, port);
    return { ok: true, hint: `${host}:${port} reachable` };
  } catch (e) {
    return { ok: false, hint: `${host}:${port} unreachable - ${e.message}` };
  }
}

/**
 * Check 4: CapSolver API key is set and the API endpoint is reachable.
 *
 * @param {object} cfg
 * @param {{ headRequest?: (url: string) => Promise<number> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkCapsolver(cfg, opts = {}) {
  const apiKey = cfg?.capsolver?.apiKey;

  if (!apiKey) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  if (isPlaceholderKey(apiKey)) {
    return { ok: true, hint: 'skipped - placeholder key detected; set your real key at capsolver.com' };
  }

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest('https://api.capsolver.com/');
    return { ok: true, hint: 'api.capsolver.com reachable' };
  } catch (e) {
    return { ok: false, hint: `api.capsolver.com unreachable - ${e.message}` };
  }
}

/**
 * Check 5: state.json is absent or parses as valid JSON with an optOuts object.
 * Looks at the real state path (AIDR_STATE_PATH included) unless a rootDir or an
 * explicit statePath says otherwise.
 *
 * @param {string} [rootDir]
 * @param {{ statePath?: string, legacyRoot?: string }} [opts]
 * @returns {{ ok: boolean, warn?: boolean, hint: string }}
 */
async function checkState(rootDir, opts = {}) {
  const statePath = opts.statePath || (rootDir ? path.join(rootDir, 'state.json') : getStatePath());
  const name = path.basename(statePath);

  if (!fs.existsSync(statePath)) {
    const legacy = rootDir ? [] : legacyLayoutProblems({ statePath, legacyRoot: opts.legacyRoot }).filter(p => p.kind === 'state');
    if (legacy.length) {
      return { ok: true, warn: true, hint: `${name} absent, but ${describeLegacyLayout(legacy).join(' ')}` };
    }
    return { ok: true, hint: `${name} absent (fresh install)` };
  }

  let st;
  try {
    st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    // State keys are "Broker|First Last": never quote the bytes the parser choked on.
    const why = e instanceof SyntaxError ? `failed to parse: ${describeParseError(e)}` : `could not be read (${e.code || 'error'})`;
    return { ok: false, hint: `${name} ${why} (${statePath})` };
  }

  if (!st || !st.optOuts || typeof st.optOuts !== 'object' || Array.isArray(st.optOuts)) {
    return { ok: false, hint: `${name} missing or invalid optOuts field (${statePath})` };
  }

  const count = Object.keys(st.optOuts).length;
  return { ok: true, hint: `${name} parseable (${count} ${count === 1 ? 'entry' : 'entries'})` };
}

/**
 * Check 6: Webhook URL responds (if configured).
 *
 * The URL is the credential for Slack and ntfy, so it is never printed: the
 * hint carries scheme and host only, and the URL is scrubbed from any error text.
 *
 * @param {object} cfg
 * @param {{ headRequest?: (url: string) => Promise<number> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkWebhook(cfg, opts = {}) {
  const url = cfg?.notify?.webhook;

  if (!url) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, hint: 'webhook is not a valid URL (not shown: it is a secret)' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, hint: `webhook scheme ${parsed.protocol} is not supported (use http or https)` };
  }
  const where = `${parsed.protocol}//${parsed.host}`;

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest(url);
    return { ok: true, hint: `webhook ${where} reachable${parsed.protocol === 'http:' ? ' (plain http, not encrypted)' : ''}` };
  } catch (e) {
    const msg = String(e && e.message).split(url).join('<webhook>');
    return { ok: false, hint: `webhook ${where} unreachable - ${msg}` };
  }
}

// ── R4: schedule, run lock, unattended passphrase ────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
// A monthly job that has not run for a month plus a few days of slack is not firing.
const STALE_RUN_DAYS = 35;
// An unparseable lock this young is a writer between create and write, not debris
// (the same grace lib/lock.js gives it).
const UNREADABLE_GRACE_MS = 2000;
// A holder on another host that has missed this many refreshes in a row is gone (lib/lock.js).
const MISSED_REFRESHES = 3;

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Check 7: the monthly job exists, is loaded, and has run lately.
 *
 * `status` is getScheduleStatus()'s answer (the heartbeat is its `lastRun`). Not
 * installed is a skip, not a failure: plenty of people run by hand. A job that
 * is installed but not loaded can never fire, so that fails. A last run that is
 * older than 35 days, failed, crashed or cannot be read is a warning: the job
 * exists, but nobody should trust it until they have looked.
 *
 * @param {object} status
 * @param {{ now?: number, staleDays?: number }} [opts]
 * @returns {{ ok: boolean, warn?: boolean, hint: string }}
 */
function checkSchedule(status, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleDays = opts.staleDays > 0 ? opts.staleDays : STALE_RUN_DAYS;

  if (!status.installed) {
    return { ok: true, hint: 'skipped - no schedule installed (aidr schedule install adds the monthly job)' };
  }
  const head = `${status.kind} job installed${status.schedule ? ` (${status.schedule})` : ''}`;
  if (status.active === false) {
    const verb = status.kind === 'launchd' ? 'loaded' : 'enabled';
    return { ok: false, hint: `${head} but not ${verb}, so it will never fire - re-run: aidr schedule install` };
  }
  const note = status.active === null ? ' (could not check whether it is loaded)' : '';

  const run = status.lastRun;
  if (!run) return { ok: true, hint: `${head}; no run recorded yet${note}` };
  if (run.unreadable) {
    return { ok: true, warn: true, hint: `${head}; last-run.json is unreadable, so the last run is unknown${note}` };
  }
  if (run.outcome === 'running') return { ok: true, hint: `${head}; running since ${run.startedAt}${note}` };

  const days = Math.floor((now - Date.parse(run.finishedAt || run.startedAt)) / DAY_MS);
  const when = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : 'today';
  const stale = days > staleDays;
  const broken = run.outcome === 'failed' || run.outcome === 'crashed';
  const state = run.outcome === 'crashed' && !run.finishedAt
    ? `last run started ${when} and never finished (crashed)`
    : `last ran ${when} (${run.outcome})`;
  const why = stale ? `: over ${staleDays} days, the monthly job may not be firing` : '';
  const hint = `${head}; ${state}${why}${note}`;
  return stale || broken ? { ok: true, warn: true, hint } : { ok: true, hint };
}

/**
 * Read a lock file without touching it. lib/lock.js does not export its reading
 * logic, so this mirrors the staleness rules of its assess(): a lock is stale
 * when it is older than the max age (counted from the last refresh), when its pid
 * is ours (a recycled pid after a restart), or when its pid is dead on THIS host.
 * A pid from another host
 * (another container on a shared mount) means nothing here, except that a holder
 * which recorded a refresh promise (`refreshMs`) and has been quiet for three of
 * them is gone. When lock.js gains an `inspect` export with this contract,
 * checkLock uses that instead.
 *
 * @returns {{ present: boolean, stale?: boolean, holder?: object|null, ageMs?: number|null, reason?: string }}
 */
function inspectLockFile(lockPath, { now, isAlive, hostname, maxAgeMs }) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false };
    return { present: true, stale: true, holder: null, ageMs: null, reason: `the lock file is unreadable (${err.code || err.message})` };
  }

  let holder = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) holder = parsed;
  } catch (_) { /* holder stays null */ }

  let fileAge = null;
  try { fileAge = now - fs.statSync(lockPath).mtimeMs; } catch (_) { /* gone since the read */ }

  if (!holder) {
    const mid = fileAge !== null && fileAge < UNREADABLE_GRACE_MS;
    return { present: true, stale: !mid, holder: null, ageMs: fileAge, reason: mid ? 'the lock file is being written' : 'the lock file is unreadable' };
  }

  // `ts` is when the lock was taken or last refreshed (a running watcher re-stamps
  // it every refreshMs); a `refreshedAt`, if a record ever carries one, counts too.
  const stamps = [holder.ts, holder.refreshedAt].map(Date.parse).filter(t => !Number.isNaN(t));
  const recordedAt = stamps.length ? Math.max(...stamps) : NaN;
  const ageMs = Number.isNaN(recordedAt) ? fileAge : now - recordedAt;
  const pid = Number(holder.pid);
  const verdict = (stale, reason) => ({ present: true, stale, holder, ageMs, reason });

  if (ageMs !== null && ageMs > maxAgeMs) return verdict(true, `older than the ${formatAge(maxAgeMs)} max age`);
  if (holder.host && holder.host !== hostname) {
    // The pid means nothing here, but a holder that promised to refresh and has
    // missed MISSED_REFRESHES in a row is not running (a container killed with
    // SIGKILL): the same rule lib/lock.js applies. A record with no promise (written
    // before locks were refreshed) is judged by the max age alone, as before.
    const promised = Number(holder.refreshMs);
    if (promised > 0 && ageMs !== null && ageMs > MISSED_REFRESHES * promised) {
      return verdict(true, `on another host, which stopped refreshing it (promised every ${formatAge(promised)})`);
    }
    return verdict(false, `on another host, so cannot check whether pid ${pid || '?'} is alive`);
  }
  if (!Number.isInteger(pid) || pid <= 0) return verdict(true, 'it records no valid pid');
  if (pid === process.pid) return verdict(true, 'it records this process\'s own pid (a recycled pid after a restart)');
  if (!isAlive(pid)) return verdict(true, 'holder process is not running');
  return verdict(false, 'holder process is running');
}

/**
 * Check 8: the run lock (state.json.lock): who holds it, for how long, and
 * whether the holder is still there. Read-only: a stale lock is reported, never
 * deleted; the next run takes it over under its own guard.
 *
 * @param {string} lockPath
 * @param {{ now?: number, isAlive?: Function, hostname?: string, maxAgeMs?: number,
 *           env?: NodeJS.ProcessEnv, inspectLock?: Function }} [opts]
 * @returns {{ ok: boolean, warn?: boolean, hint: string }}
 */
function checkLock(lockPath, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const inspect = opts.inspectLock || (typeof lock.inspect === 'function' ? lock.inspect : inspectLockFile);
  const info = inspect(lockPath, {
    now,
    isAlive: opts.isAlive || lock.isAlive,
    hostname: opts.hostname || os.hostname(),
    maxAgeMs: lockMaxAgeMs({ maxAgeMs: opts.maxAgeMs, env: opts.env }),
  });
  if (!info.present) return { ok: true, hint: 'no lock held (no run in progress)' };

  const h = info.holder;
  const who = h ? `pid ${Number(h.pid) > 0 ? Number(h.pid) : '?'}${h.host ? ` on ${h.host}` : ''}` : 'an unknown process';
  const held = info.ageMs === null || info.ageMs === undefined ? '' : ` for ${formatAge(info.ageMs)}`;
  if (info.stale) {
    return {
      ok: true,
      warn: true,
      hint: `stale lock held by ${who}${held} (${info.reason}); the next run takes it over, or delete ${lockPath}`,
    };
  }
  return { ok: true, hint: `run in progress: lock held by ${who}${held} (${info.reason})` };
}

/**
 * Why a passphrase file would not be accepted, or null if it would: the same
 * three refusals config loading makes (unreadable, readable by other accounts,
 * empty), because a scheduled job that hits one fails every month.
 */
function passphraseFileProblem(file, platform) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (platform !== 'win32' && (st.mode & 0o077) !== 0) {
      return `is readable by other accounts (mode ${(st.mode & 0o777).toString(8)}), so config loading refuses it. Fix with: chmod 600 ${file}`;
    }
    const first = fs.readFileSync(fd, 'utf8').split('\n')[0].replace(/\r$/, '');
    return first ? null : 'is empty: put the passphrase on its first line';
  } catch (err) {
    return err.code === 'ENOENT' ? 'does not exist' : `cannot be read (${err.code || err.message})`;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* nothing left to do */ } }
  }
}

/**
 * Check 9: an encrypted config has a passphrase source an unattended run can
 * use. run.sh refuses to start an encrypted config with neither AIDR_PASSPHRASE
 * nor AIDR_PASSPHRASE_FILE, so a job installed without one fails every month.
 * What counts is what the INSTALLED JOB carries (status.env), not what is set in
 * the shell running doctor: a launchd, systemd or cron job does not inherit it.
 *
 * @param {{ encrypted: boolean, status: object, env?: NodeJS.ProcessEnv, platform?: string }} args
 * @returns {{ ok: boolean, warn?: boolean, hint: string }}
 */
function checkUnattendedPassphrase({ encrypted, status, env = process.env, platform = process.platform }) {
  if (!encrypted) return { ok: true, hint: 'skipped - config is not encrypted' };
  if (!status.installed) {
    return { ok: true, hint: 'skipped - no schedule installed (a scheduled run of an encrypted config needs AIDR_PASSPHRASE_FILE)' };
  }

  if (status.plaintextPassphrase) {
    return {
      ok: true,
      warn: true,
      hint: 'AIDR_PASSPHRASE is written into the scheduled job, readable by other accounts; use AIDR_PASSPHRASE_FILE (a 0600 file) and re-run: aidr schedule install',
    };
  }

  // A Task Scheduler task carries no environment: the best doctor can do is look
  // at the variables of the user it runs as.
  if (status.envVisible === false) {
    if (env.AIDR_PASSPHRASE) {
      return { ok: true, hint: 'Task Scheduler tasks cannot carry variables; AIDR_PASSPHRASE is set for this user, which the task inherits' };
    }
    const file = env.AIDR_PASSPHRASE_FILE;
    if (!file) {
      return {
        ok: true,
        warn: true,
        hint: 'Task Scheduler tasks cannot carry variables, and AIDR_PASSPHRASE_FILE is not set for this user: set it with setx AIDR_PASSPHRASE_FILE <path-to-0600-file>',
      };
    }
    const problem = passphraseFileProblem(file, platform);
    if (problem) return { ok: false, hint: `AIDR_PASSPHRASE_FILE ${file} ${problem}` };
    return { ok: true, hint: `Task Scheduler tasks cannot carry variables; AIDR_PASSPHRASE_FILE is set for this user (${file}), which the task inherits` };
  }

  const file = status.env && status.env.AIDR_PASSPHRASE_FILE;
  if (!file) {
    return {
      ok: false,
      hint: 'config is encrypted but the scheduled job carries no AIDR_PASSPHRASE_FILE, so run.sh will refuse to start it. Set AIDR_PASSPHRASE_FILE (a 0600 file holding the passphrase) and re-run: aidr schedule install',
    };
  }
  const problem = passphraseFileProblem(file, platform);
  if (problem) return { ok: false, hint: `the scheduled job's AIDR_PASSPHRASE_FILE ${file} ${problem}` };
  return { ok: true, hint: `scheduled job carries AIDR_PASSPHRASE_FILE (${file})` };
}

/**
 * Check: the directory every runtime file lives in (AIDR_HOME, else the app
 * directory) exists and this user can write to it.
 *
 * It is written to at the END of a long run (state, the journal, the log, the
 * heartbeat), so a read-only mount or one owned by another uid (the Docker image
 * runs as 1001) would otherwise show up as a failed write hours after the run
 * began. A directory that does not exist yet is fine (the first write creates it,
 * owner-only) and said so. A home the user chose with AIDR_HOME that other users can
 * read is a warning: it holds PII. The app directory's own mode is not nagged about.
 *
 * @param {{ home?: string|null, explicit?: boolean, uid?: number|null }} [opts]
 *   explicit: the user set AIDR_HOME; uid: for the message (default process.getuid)
 * @returns {{ ok: boolean, warn?: boolean, hint: string }}
 */
function checkHome({ home, explicit = false, uid } = {}) {
  if (!home) return { ok: true, hint: 'skipped - no runtime directory resolved' };
  let stat;
  try {
    stat = fs.statSync(home);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, warn: true, hint: `${home} does not exist yet (the first run or \`node setup.js\` creates it, owner-only)` };
    }
    return { ok: false, hint: `${home} cannot be read (${(err && err.code) || 'error'})` };
  }
  if (!stat.isDirectory()) return { ok: false, hint: `${home} is not a directory` };

  try {
    fs.accessSync(home, fs.constants.W_OK);
  } catch (_) {
    const who = uid !== undefined && uid !== null ? uid : (typeof process.getuid === 'function' ? process.getuid() : null);
    return {
      ok: false,
      hint: `${home} is not writable by this user${who === null ? '' : ` (uid ${who})`}: state, logs and the heartbeat cannot be saved. ` +
        'In Docker the container user is uid 1001: chown -R 1001:1001 the mounted directory, or run with --user',
    };
  }

  if (explicit && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return {
      ok: true,
      warn: true,
      hint: `${home} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}) and holds your details: chmod 700 ${home}`,
    };
  }
  return { ok: true, hint: `${home} exists and is writable` };
}

/** describePaths() (lib/paths.js, R0) as printable text, whatever shape it returns. */
function formatPathsDescription(described) {
  if (typeof described === 'string') return described;
  if (Array.isArray(described)) return described.join('\n');
  if (described && typeof described === 'object') {
    const width = Math.max(0, ...Object.keys(described).map(key => key.length));
    return Object.entries(described).map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
  }
  return null;
}

/**
 * Every resolved runtime path, when lib/paths.js exists (R0 adds it; until then
 * there is nothing to print). `opts.describePaths` overrides the lookup; null
 * means "none".
 */
function describeRuntimePaths(opts) {
  let describe = opts.describePaths;
  if (describe === undefined) {
    try { describe = require('./paths').describePaths; } catch (_) { describe = null; }
  }
  if (typeof describe !== 'function') return null;
  try {
    return formatPathsDescription(describe());
  } catch (_) {
    return null;
  }
}

// ── Default I/O helpers (not used in tests) ──────────────────────────────────

function defaultTcpProbe(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 5000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TCP connection timed out'));
    });
  });
}

function defaultHeadRequest(url) {
  return new Promise((resolve, reject) => {
    // https.request throws on an http: URL; ntfy on a LAN is commonly plain http.
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const req = transport.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

// ── runDoctor ────────────────────────────────────────────────────────────────

/**
 * Run all checks and print a coloured summary (unless printOutput === false).
 *
 * @param {object} [opts]
 * @param {string}  [opts.rootDir]           Project root. Omit to use the real config/state paths
 *                                           (AIDR_CONFIG_PATH, AIDR_CONFIG_ENC_PATH, AIDR_STATE_PATH included)
 * @param {string}  [opts.passphrase]        Passphrase override (default: AIDR_PASSPHRASE / AIDR_PASSPHRASE_FILE)
 * @param {boolean} [opts.printOutput]       Set false to suppress console output (for tests)
 * @param {Function} [opts.requirePlaywright]  DI override
 * @param {Function} [opts.fsExists]           DI override
 * @param {Function} [opts.tcpProbe]           DI override
 * @param {Function} [opts.headRequest]        DI override
 * @param {object|Function} [opts.scheduleStatus]  DI override: a getScheduleStatus() answer (or a function returning one)
 * @param {object}  [opts.scheduleOptions]   Passed to getScheduleStatus when scheduleStatus is not given
 *                                           ({ platform, runner, homeDir, scriptPath })
 * @param {string}  [opts.statePath]         Where state.json is; the lock and last-run.json are looked for beside it
 * @param {string}  [opts.lockPath]          Override for <state>.lock
 * @param {string}  [opts.heartbeatPath]     Override for last-run.json
 * @param {number}  [opts.now]               Clock override (ms), for the age checks
 * @param {Function|null} [opts.describePaths]  Override for lib/paths.js describePaths(); null prints none
 * @param {string|null} [opts.runtimeHome]   Override for the directory the home check looks at (default: rootDir, else AIDR_HOME / the app directory)
 * @param {object}  [opts.env]               Environment for AIDR_HOME and the lock age (default process.env)
 *
 * @returns {Promise<Array<{name: string, ok: boolean, warn?: boolean, hint: string}> & { exitCode: number, summary: object, paths?: string }>}
 *   A check with `warn: true` is ok (it does not fail the run) but worth a look.
 */
async function runDoctor(opts = {}) {
  const rootDir = opts.rootDir; // undefined -> the real paths, see resolveConfigPaths
  const print   = opts.printOutput !== false;

  // Load config for checks that need it (best-effort; checkConfig reports why
  // it could not be loaded).
  const loaded = loadDoctorConfig(rootDir, { passphrase: opts.passphrase });
  const cfg = loaded.status === 'ok' ? loaded.cfg : {};

  const pwOpts = {
    requirePlaywright: opts.requirePlaywright,
    fsExists:          opts.fsExists,
  };
  const netOpts = {
    tcpProbe:    opts.tcpProbe,
    headRequest: opts.headRequest,
  };

  // The lock and the heartbeat sit beside state.json, the same place the watcher
  // puts them, so a rootDir or AIDR_STATE_PATH moves all three together.
  const statePath = opts.statePath || (rootDir ? path.join(rootDir, 'state.json') : getStatePath());
  const lockPath = opts.lockPath || `${statePath}.lock`;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  // The schedule is read once and shared by the schedule and unattended checks.
  let scheduleRead = null;
  const readSchedule = async () => {
    if (scheduleRead === null) {
      scheduleRead = (async () => {
        try {
          const given = opts.scheduleStatus;
          if (given !== undefined) return { status: typeof given === 'function' ? await given() : given };
          return {
            status: getScheduleStatus({
              heartbeatPath: opts.heartbeatPath || defaultHeartbeatPath({ statePath }),
              now,
              ...opts.scheduleOptions,
            }),
          };
        } catch (error) {
          return { error };
        }
      })();
    }
    return scheduleRead;
  };
  const configIsEncrypted = () => {
    try {
      return isConfigEncrypted(resolveConfigPaths(rootDir));
    } catch (_) {
      return false;
    }
  };

  // The directory runtime files go to: a rootDir (tests) is its own home; otherwise
  // whatever lib/paths.js resolves for this environment.
  const env = opts.env || process.env;
  const runtimeHome = opts.runtimeHome !== undefined ? opts.runtimeHome : (rootDir || resolvePaths(env).home);

  const checks = [
    { name: 'home',       run: () => checkHome({ home: runtimeHome, explicit: !rootDir && Boolean(env.AIDR_HOME) }) },
    { name: 'config',     run: () => checkConfig(rootDir, { passphrase: opts.passphrase }) },
    { name: 'playwright', run: () => checkPlaywright(pwOpts) },
    { name: 'smtp',       run: () => checkSMTP(cfg, netOpts) },
    { name: 'capsolver',  run: () => checkCapsolver(cfg, netOpts) },
    { name: 'state',      run: () => checkState(rootDir) },
    { name: 'webhook',    run: () => checkWebhook(cfg, netOpts) },
    { name: 'schedule',   run: async () => {
      const read = await readSchedule();
      return read.error
        ? { ok: false, hint: `could not read the schedule: ${read.error.message}` }
        : checkSchedule(read.status, { now });
    } },
    { name: 'lock',       run: () => checkLock(lockPath, { now, env: opts.env }) },
    { name: 'unattended', run: async () => {
      const read = await readSchedule();
      return read.error
        ? { ok: true, hint: 'skipped - the schedule could not be read' }
        : checkUnattendedPassphrase({ encrypted: configIsEncrypted(), status: read.status, env: opts.env });
    } },
  ];

  if (print) {
    console.log(`\n${c.bold('🩺 doctor')} - running ${checks.length} checks…`);
  }

  const results = [];

  for (const check of checks) {
    let result;
    try {
      result = await check.run();
    } catch (e) {
      result = { ok: false, hint: `check failed unexpectedly: ${e.message}` };
    }
    const item = { name: check.name, ok: result.ok, hint: result.hint };
    if (result.warn) item.warn = true;
    results.push(item);

    if (print) {
      const isSkip = result.ok && /skipped/i.test(result.hint);
      const icon   = (isSkip || result.warn) ? '⚠️ ' : (result.ok ? '✅' : '❌');
      const label  = check.name.padEnd(11);
      console.log(`  ${icon} ${label} ${result.hint}`);
    }
  }

  // Where every runtime path resolves (lib/paths.js, once it exists).
  const pathsText = describeRuntimePaths(opts);
  if (pathsText) {
    if (print) {
      console.log(`\n${c.bold('Paths')}`);
      for (const line of pathsText.split('\n')) console.log(`  ${line}`);
    }
  }

  // Tally
  const isSkipped = r => r.ok && !r.warn && /skipped/i.test(r.hint);
  const failed   = results.filter(r => !r.ok).length;
  const warnings = results.filter(r => r.ok && r.warn).length;
  const skipped  = results.filter(isSkipped).length;
  const ok       = results.filter(r => r.ok && !r.warn && !isSkipped(r)).length;
  const summary  = { ok, skipped, warnings, failed };

  if (print) {
    const parts = [];
    if (ok)       parts.push(c.green(`${ok} ok`));
    if (skipped)  parts.push(c.yellow(`${skipped} skipped`));
    if (warnings) parts.push(c.yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`));
    if (failed)   parts.push(c.red(`${failed} failed`));
    console.log(`\nResult: ${parts.join(', ')}\n`);
  }

  const exitCode = failed > 0 ? 1 : 0;

  // Attach summary and exitCode to the results array so callers can destructure
  results.exitCode = exitCode;
  results.summary  = summary;
  if (pathsText) results.paths = pathsText;

  return results;
}

module.exports = {
  checkHome,
  checkConfig,
  checkPlaywright,
  checkSMTP,
  checkCapsolver,
  checkState,
  checkWebhook,
  checkSchedule,
  checkLock,
  checkUnattendedPassphrase,
  runDoctor,
};
