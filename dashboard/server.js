'use strict';
/*
 * auto-identity-remove - web dashboard (optional)
 *
 * A small, dependency-light (express-only) control panel that wraps the
 * existing CLI. It reads the project's own files (brokers.js, config.json,
 * state.json, logs/) and drives watcher.js for runs. No personal data lives
 * here - everything is read from / written to the project's config.json.
 *
 * Endpoints (all require auth EXCEPT /api/health):
 *   GET  /api/health             -> { ok } liveness (unauthenticated, no path disclosure)
 *   GET  /api/version            -> tool version + node + broker count
 *   GET  /api/brokers            -> broker definitions + status (from ../brokers.js, state.json)
 *   GET  /api/state              -> state.json (raw; {error} if unparseable)
 *   GET  /api/summary            -> counts + config flags + run state, the people the config
 *                                   names (initials), generic-broker totals and how many sites
 *                                   the latest run left at a CAPTCHA
 *   GET  /api/config             -> config.json with secrets masked
 *   PUT  /api/config             -> merge-write config.json (masked secrets preserved);
 *                                   409 when the stored config is unreadable unless
 *                                   {overwrite:true}; a .bak copy is kept before every replace
 *   GET  /api/config/status      -> first-run gate: { configured, missing, locked, unreadable }
 *   GET  /api/logs               -> list of files in ../logs
 *   GET  /api/logs/:name         -> one log file (size-capped, streamed)
 *   GET  /api/runs               -> run history from logs/run-*.json(l), newest first,
 *                                   paginated: ?limit (max 100) & ?offset
 *   GET  /api/runs/:id           -> one run's per-broker rows (URLs reduced to their host)
 *   GET  /api/run/status         -> current/last run state
 *   GET  /api/run/stream         -> Server-Sent Events live output
 *   POST /api/run                -> { mode, only?, skip? } (modes: see MODE_ARGS)
 *   POST /api/run/stop           -> terminate current run (SIGTERM, then SIGKILL)
 *   GET  /api/schedule           -> systemd timer status (enabled/next/cadence)
 *   POST /api/schedule           -> { action: enable|disable|preset, preset? }
 *   GET  /api/auth/whoami        -> current user + credential source
 *   POST /api/auth/password      -> change login (requires current password)
 *   GET  /api/freeze             -> credit/identity freeze checklist + status
 *   POST /api/freeze             -> { key, action: done|clear } mark a freeze target
 *                                   (409 while a run is active or the state lock is held)
 *
 * Paths: config/state/logs and the SERP history default to the repo root; AIDR_HOME
 * moves them all and AIDR_CONFIG_PATH, AIDR_CONFIG_ENC_PATH, AIDR_STATE_PATH,
 * AIDR_LOG_DIR and AIDR_DATA_DIR relocate one each, exactly as they do for
 * watcher.js (lib/paths.js decides both), and createApp() takes every path as an
 * option so tests never touch the real files.
 *
 * Auth (all routes except /api/health, static + API): credentials are REQUIRED,
 *   loopback included. `aidr dashboard` generates a login; otherwise set AIDR_USER +
 *   AIDR_PASS for HTTP Basic, and/or AIDR_TOKEN for header token auth (X-AIDR-Token).
 *   A request is allowed if it satisfies EITHER. Credentials can be changed at
 *   runtime via the Admin tab, which writes a scrypt-hashed dashboard/.auth.json
 *   that overrides the env vars. Auth runs BEFORE any body is parsed. Repeated
 *   failed logins from one address are rate limited (429). Starting with no
 *   credentials is refused, and if the credentials disappear while the server runs
 *   every route answers 401 (it fails closed). The one exception is
 *   AIDR_DASHBOARD_NO_AUTH=1, for tests and local development: it switches
 *   authentication off on a loopback bind only, and only when no credentials exist
 *   at start-up. AIDR_PASS=change-me (the old example value) is never accepted.
 *
 * Request hygiene: the Host header must be a loopback name, the bind address, or
 *   listed in AIDR_ALLOWED_HOSTS (blocks DNS rebinding); cross-origin mutating
 *   requests are rejected (CSRF); every response carries CSP / nosniff /
 *   no-referrer, and /api/* is Cache-Control: no-store.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn, execFile } = require('child_process');

// Friendly failure when the dashboard's own dependency was never installed: it
// has its own package.json, so the root `npm install` does not provide it.
function loadExpress() {
  try {
    return require('express');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /['"]express['"]/.test(String(err.message))) {
      const e = new Error('the dashboard needs the "express" package, which is not installed. Run: cd dashboard && npm install');
      e.code = 'AIDR_NO_EXPRESS';
      throw e;
    }
    throw err;
  }
}
let express;
try {
  express = loadExpress();
} catch (err) {
  if (require.main === module && err.code === 'AIDR_NO_EXPRESS') {
    console.error(`aidr-dashboard: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const {
  validateRunRequest, modeHonorsFilters, resolveEnvCreds, validateUsername, aggregateBrokerStatus,
  buildAllowedHosts, isHostAllowed, checkBindSafety,
} = require('./validate');
const { configStatus } = require('./config-status');
const { TARGET_KEYS, getFreezeStatus, applyFreeze } = require('../lib/freeze');
const secrets = require('../lib/secrets');
const configLib = require('../lib/config');
const lock = require('../lib/lock');
const { resolveAuthFile } = require('../lib/dashboard-creds');
const { resolvePaths } = require('../lib/paths');
const { writeJsonAtomic, backupFile } = require('./safe-write');
const { MASK, maskConfig, mergeConfig, applyConfigEdit } = require('./config-edit');
const { listRuns, readRun, latestRun, redactDetail, redactUrls } = require('./runs');
const { peopleFromConfig, peopleFromState, ownedOptOuts } = require('./people');
const { loadGenericList, tallyGeneric } = require('./generic');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const MAX_LOG_BYTES = 10 * 1024 * 1024; // cap log file reads (avoid OOM / event-loop block)
const MAX_LINES = 5000;       // ring-buffer cap for the run output
const REPLAY_LINES = 300;     // how many tail lines a reconnecting SSE client gets
const BROKERS_CACHE_TTL = 15000; // 15 seconds
const AUTH_FAIL_LIMIT = 10;      // failed logins per address per window ...
const AUTH_FAIL_WINDOW_MS = 60 * 1000; // ... before it is answered 429 without hashing anything

// Credentials for the dashboard itself must not reach the watcher it spawns: the
// run has no use for them and a watcher plugin or crash dump would carry them.
// AIDR_PASSPHRASE* stays - the run needs it to decrypt the config.
const CHILD_ENV_STRIP = ['AIDR_PASS', 'AIDR_USER', 'AIDR_TOKEN'];

// Run modes -> watcher.js flags. Verified against ../watcher.js argv parsing:
// --preview, --verify, --doctor, --list, --pending, --confirm-emails,
// --retry-failed, --serp-scan, --snapshot (real run = no flag).
const MODE_ARGS = {
  preview: ['--preview'],
  real: [],
  verify: ['--verify'],
  doctor: ['--doctor'],
  list: ['--list'],
  pending: ['--pending'],
  confirm: ['--confirm-emails'],
  retry: ['--retry-failed'],
  serp: ['--serp-scan'],
  snapshot: ['--snapshot'],
};

const CALENDARS = { daily: '*-*-* 03:30:00', weekly: 'Sun *-*-* 03:30:00', monthly: '*-*-01 03:30:00' };
const TIMER = 'aidr.timer';
const sh = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { timeout: 8000 }, (err, out, errout) => resolve({ err, out: String(out || ''), errout: String(errout || '') })));

// ---- file helpers (module level: pure, no instance state) -------------------
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
// Distinguishes absent (exists:false) from present-but-unparseable (parseError:true).
function readJsonMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { exists: false } : { exists: true, parseError: true }; }
  try { return { exists: true, data: JSON.parse(raw) }; }
  catch (_) { return { exists: true, parseError: true }; }
}

// GET /api/state is the raw state file, minus what must not leave the machine by
// accident (the History routes already reduce URLs to hosts): the relay alias
// cache maps each person's REAL email to its alias, and a result's detail or a
// pending confirmation's snippet can carry an opt-out URL whose query holds the
// email, name or zip.
function redactState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const out = { ...state };
  if (out.relayAliases && typeof out.relayAliases === 'object') {
    out.relayAliases = { count: Object.keys(out.relayAliases).length };
  }
  if (out.optOuts && typeof out.optOuts === 'object' && !Array.isArray(out.optOuts)) {
    out.optOuts = Object.fromEntries(Object.entries(out.optOuts).map(([key, entry]) => {
      if (!entry || typeof entry !== 'object') return [key, entry];
      const next = { ...entry };
      if (typeof next.lastDetail === 'string') next.lastDetail = redactDetail(next.lastDetail);
      if (next.pendingConfirm && typeof next.pendingConfirm === 'object' && typeof next.pendingConfirm.snippet === 'string') {
        next.pendingConfirm = { ...next.pendingConfirm, snippet: redactDetail(next.pendingConfirm.snippet) };
      }
      return [key, next];
    }));
  }
  return out;
}

// Envelope-aware config reader. Prefers config.json.enc, else config.json (which
// may itself be an envelope). Decrypts with the passphrase (AIDR_PASSPHRASE).
// On a missing/wrong passphrase for an encrypted config, returns
// { parseError: true, locked: true } so the API surfaces a clear "could not read"
// (and the UI an unlock banner instead of the first-run wizard) instead of
// leaking ciphertext. opts (for tests): { configPath, encPath, passphrase }.
function readConfigMeta(opts) {
  const o = opts || {};
  const configPath = o.configPath || path.join(DEFAULT_ROOT, 'config.json');
  const encPath    = o.encPath || path.join(DEFAULT_ROOT, 'config.json.enc');
  const passphrase = o.passphrase !== undefined ? o.passphrase : (process.env.AIDR_PASSPHRASE || '');

  // `file` is where the config was read from, so a write goes back to the same
  // place: an envelope kept in config.json must not be "saved" as a config.json.enc
  // that the next read would prefer over it (CFG2-10). decryptConfigCached: the key
  // derivation is the slow part, and this runs on every request (CFG2-11).
  const tryDecrypt = (env, file) => {
    if (!passphrase) return { exists: true, parseError: true, locked: true, file };
    try { return { exists: true, data: secrets.decryptConfigCached(env, passphrase), file }; }
    catch (_) { return { exists: true, parseError: true, locked: true, file }; }
  };

  if (fs.existsSync(encPath)) {
    let env;
    try { env = JSON.parse(fs.readFileSync(encPath, 'utf8')); }
    catch (_) { return { exists: true, parseError: true, file: encPath }; }
    return tryDecrypt(env, encPath);
  }
  const m = readJsonMeta(configPath);
  if (m.exists && m.data && secrets.isEncryptedEnvelope(m.data)) return tryDecrypt(m.data, configPath);
  return { ...m, file: configPath };
}

const safeEq = (a, b) => {
  // Hash both sides first: timingSafeEqual needs equal lengths, and comparing
  // lengths up front would leak the length of the stored secret.
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
};
// Async on purpose: scryptSync on the event loop let 60 bad logins stretch
// /api/health from 7 ms to 1.1 s. The salt is the hex string itself, as always.
const hashPw = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(pw), salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
async function makeCred(user, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { user, salt, hash: await hashPw(pw, salt) };
}

/**
 * Build one dashboard instance. Every path, the environment and the spawn
 * function are options, so a test can run a complete server against a temp dir
 * and a stub watcher without touching a real file or starting a real run.
 *
 * @param {object} [options]
 * @param {string}   [options.root]        repo root (brokers.js, lib/, config.example.json); default: this repo
 * @param {string}   [options.configPath]  default AIDR_CONFIG_PATH, else <root>/config.json
 * @param {string}   [options.encPath]     default AIDR_CONFIG_ENC_PATH, else <root>/config.json.enc
 * @param {string}   [options.statePath]   default AIDR_STATE_PATH, else <root>/state.json
 * @param {string}   [options.logsDir]     default <root>/logs
 * @param {string}   [options.serpHistoryPath]
 * @param {string}   [options.authFile]    default AIDR_AUTH_FILE, else dashboard/.auth.json
 * @param {object}   [options.env]         default process.env
 * @param {string}   [options.passphrase]  default: the process passphrase
 * @param {string}   [options.bindHost]    the address the server will listen on (Host allow-list)
 * @param {Function} [options.spawn]       child_process.spawn replacement (tests)
 * @param {string}   [options.watcherScript]  default "watcher.js" (relative to cwd)
 * @param {string}   [options.cwd]         working directory of runs; default root
 * @param {Array|Function} [options.brokers]  broker list instead of requiring brokers.js
 * @param {Array|Function} [options.genericBrokers]  generic-broker rows instead of loading the shipped datasets
 * @param {number}   [options.authFailLimit]
 * @param {number}   [options.authFailWindowMs]
 * @param {Function} [options.warn]        stderr writer
 */
function createApp(options = {}) {
  const env = options.env || process.env;
  const ROOT = path.resolve(options.root || DEFAULT_ROOT);
  // The same decision the watcher makes (lib/paths.js): AIDR_HOME moves everything,
  // each specific variable still wins, and with none set it is the repo root. An
  // option beats all of them (tests, and any caller that knows better).
  const P = resolvePaths(env, ROOT);
  const CONFIG = options.configPath || P.config;
  const CONFIG_ENC = options.encPath || P.configEnc;
  const STATE = options.statePath || P.state;
  const STATE_LOCK = STATE + '.lock'; // same name watcher.js takes (lib/config STATE_PATH + '.lock')
  const LOGS = options.logsDir || P.logs;
  const BROKERS = path.join(ROOT, 'brokers.js');
  const SERP_HISTORY = options.serpHistoryPath || path.join(P.data, 'serp-history.json');
  const EXPOSURE_LIB = path.join(ROOT, 'lib', 'exposure.js');
  const AUTH_FILE = options.authFile || resolveAuthFile(env, __dirname);
  const PASSPHRASE = options.passphrase !== undefined
    ? options.passphrase
    : (env === process.env ? configLib.getPassphrase() : (env.AIDR_PASSPHRASE || ''));
  const TOKEN = env.AIDR_TOKEN || '';
  const spawnFn = options.spawn || realSpawn;
  const WATCHER = options.watcherScript || 'watcher.js';
  const RUN_CWD = options.cwd || ROOT;
  const warn = options.warn || (m => process.stderr.write(m + '\n'));
  const failLimit = options.authFailLimit || AUTH_FAIL_LIMIT;
  const failWindowMs = options.authFailWindowMs || AUTH_FAIL_WINDOW_MS;
  const allowedHosts = buildAllowedHosts({ env, bindHost: options.bindHost || env.AIDR_HOST || '127.0.0.1' });

  // Validate env credentials: BOTH must be set or neither is used (fix #6).
  const envCreds = resolveEnvCreds(env.AIDR_USER || '', env.AIDR_PASS || '');
  if (envCreds.warning) warn(envCreds.warning);
  const ENV_USER = envCreds.envUser;
  const ENV_PASS = envCreds.envPass;

  const readConfig = () => readConfigMeta({ configPath: CONFIG, encPath: CONFIG_ENC, passphrase: PASSPHRASE });

  const app = express();
  app.disable('x-powered-by');

  // ---- response headers + Host allow-list ------------------------------------
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    if (req.path === '/api' || req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  // DNS rebinding: a page on evil.example whose name briefly resolves to
  // 127.0.0.1 reaches this server with Host: evil.example. The CSRF check below
  // compares Origin to the request's own Host, so it cannot catch that alone.
  app.use((req, res, next) => {
    if (isHostAllowed(req.headers.host, allowedHosts)) return next();
    res.status(403).json({ error: 'host not allowed; list it in AIDR_ALLOWED_HOSTS to reach the dashboard under that name' });
  });

  // ---- credentials (file overrides env; env is the bootstrap) ------------------
  // Returns the active credential, or {source:'broken'} (fail-closed) if .auth.json
  // exists but is corrupt/incomplete - never silently downgrades to env/open in that case.
  function loadCreds() {
    let raw = null;
    try { raw = fs.readFileSync(AUTH_FILE, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') return { source: 'broken' }; }
    if (raw !== null) {
      try {
        const c = JSON.parse(raw);
        if (c && c.user && c.salt && c.hash) return { source: 'file', user: c.user, salt: c.salt, hash: c.hash };
      } catch (_) {}
      return { source: 'broken' }; // present but unusable -> require auth, deny everything
    }
    if (ENV_USER && ENV_PASS) return { source: 'env', user: ENV_USER, pass: ENV_PASS };
    return null;
  }
  async function checkBasic(u, p) {
    const c = loadCreds();
    if (!c || c.source === 'broken' || !c.user || !safeEq(u, c.user)) return false;
    return c.source === 'file' ? safeEq(await hashPw(p, c.salt), c.hash) : safeEq(p, c.pass);
  }
  const authConfigured = () => !!(loadCreds() || TOKEN);

  // Credentials are required on every bind. The one way around it is the explicit
  // AIDR_DASHBOARD_NO_AUTH=1 (tests, local development), and it only counts when
  // there were no credentials AT START-UP: a login that existed then and was
  // deleted since (the corrupt-.auth.json advice is "delete it") must not turn
  // every route open - the server fails closed instead (CFG2-4, codex #1).
  const openMode = (env.AIDR_DASHBOARD_NO_AUTH === '1' || options.allowNoAuth === true) && !authConfigured();

  // Returns { ok } or { ok:false, attempted } where attempted means credentials
  // were actually presented (a browser's first, header-less request is not a guess).
  async function authorize(req) {
    if (openMode) return { ok: true };
    if (!authConfigured()) return { ok: false, attempted: false };
    let attempted = false;
    if (TOKEN) { // header only - never accept the token via query string (leaks to logs/history)
      const t = req.get('x-aidr-token');
      if (t) {
        attempted = true;
        if (safeEq(t, TOKEN)) return { ok: true };
      }
    }
    const c = loadCreds();
    if (c && c.source !== 'broken') {
      const h = req.get('authorization') || '';
      if (/^basic /i.test(h)) {
        attempted = true;
        const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
        if (await checkBasic(u, rest.join(':'))) return { ok: true };
      }
    }
    return { ok: false, attempted };
  }

  // Per-address failed-login limiter. In memory on purpose: it only has to blunt
  // online guessing and stop scrypt from monopolising the thread pool.
  const failures = new Map(); // ip -> { count, resetAt }
  const ipOf = req => (req.socket && req.socket.remoteAddress) || '';
  function lockoutMs(ip) {
    const f = failures.get(ip);
    if (!f) return 0;
    if (Date.now() >= f.resetAt) { failures.delete(ip); return 0; }
    return f.count >= failLimit ? f.resetAt - Date.now() : 0;
  }
  function noteFailure(ip) {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || now >= f.resetAt) failures.set(ip, { count: 1, resetAt: now + failWindowMs });
    else f.count += 1;
    if (failures.size > 1000) { // bound memory under a spray of source addresses
      for (const [k, v] of failures) if (now >= v.resetAt) failures.delete(k);
    }
  }

  // Auth runs BEFORE body parsing: an unauthenticated caller must not make the
  // server buffer and parse 512 KB of JSON, nor see a parser's error page.
  app.use(async (req, res, next) => {
    if (req.path === '/api/health') return next();
    try {
      const ip = ipOf(req);
      const wait = lockoutMs(ip);
      if (wait > 0) {
        res.set('Retry-After', String(Math.ceil(wait / 1000)));
        return res.status(429).json({ error: 'too many failed logins; try again shortly' });
      }
      const r = await authorize(req);
      if (r.ok) { failures.delete(ip); return next(); }
      if (r.attempted) noteFailure(ip);
      res.set('WWW-Authenticate', 'Basic realm="aidr dashboard"');
      res.status(401).json({ error: 'unauthorized' });
    } catch (err) { next(err); }
  });
  app.use(express.json({ limit: '512kb' }));
  // CSRF defense: reject cross-origin state-changing requests. Same-origin (browser
  // sends matching Origin) and tool/automation (no Origin, token-authed) both pass.
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let oh = ''; try { oh = new URL(origin).host; } catch (_) {}
      if (oh !== req.get('host')) return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    next();
  });

  // ---- account management ---------------------------------------------------
  app.get('/api/auth/whoami', (_req, res) => {
    const c = loadCreds();
    res.json({ user: c && c.user ? c.user : null, source: c ? c.source : (TOKEN ? 'token' : 'open') });
  });
  app.post('/api/auth/password', async (req, res) => {
    const { currentPassword, newPassword, newUsername } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
    const nu = validateUsername(newUsername);
    if (!nu.ok) return res.status(400).json({ error: nu.error });
    const c = loadCreds();
    // If a basic credential exists (env or file), the current password must match.
    // (The auth middleware already gated this route; this is the extra in-session check.)
    if (c && c.source !== 'broken') {
      const ok = c.source === 'file'
        ? safeEq(await hashPw(currentPassword || '', c.salt), c.hash)
        : safeEq(currentPassword || '', c.pass);
      if (!ok) return res.status(403).json({ error: 'current password is incorrect' });
    } else if (c && c.source === 'broken') {
      return res.status(409).json({ error: '.auth.json is corrupt - fix or delete it on the server first' });
    }
    const user = nu.value || (c && c.user) || 'admin';
    try {
      writeJsonAtomic(AUTH_FILE, await makeCred(user, newPassword), 0o600);
      res.json({ ok: true, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- brokers ---------------------------------------------------------------
  let brokersCache = null;
  let brokersCacheAt = 0;
  // brokers.js (parent repo) exports a plain array and reads config.json at
  // require-time; clear its cache so the list reflects config edits. A small TTL
  // keeps repeated /api/summary polls from re-requiring it every time.
  function loadBrokers() {
    if (typeof options.brokers === 'function') return options.brokers();
    if (Array.isArray(options.brokers)) return options.brokers;
    const now = Date.now();
    if (brokersCache && now - brokersCacheAt < BROKERS_CACHE_TTL) return brokersCache;
    try {
      delete require.cache[require.resolve(BROKERS)];
      brokersCache = require(BROKERS);
    } catch (_) { brokersCache = []; }
    brokersCacheAt = now;
    return brokersCache;
  }

  // The ~490 generic brokers, loaded the way generic-runner loads them (deduped
  // against the explicit list). null when the datasets cannot be read: the summary
  // then omits the totals instead of failing. Cached like brokers.js: the datasets
  // only change with an --update-brokers run.
  let genericCache = null;
  let genericCacheAt = 0;
  function loadGeneric() {
    if (typeof options.genericBrokers === 'function') {
      try { return options.genericBrokers(); } catch (_) { return null; }
    }
    if (Array.isArray(options.genericBrokers)) return options.genericBrokers;
    const now = Date.now();
    if (genericCacheAt && now - genericCacheAt < BROKERS_CACHE_TTL) return genericCache;
    genericCache = loadGenericList({ explicitBrokers: loadBrokers(), root: ROOT });
    genericCacheAt = now;
    return genericCache;
  }

  // ---- run management -------------------------------------------------------
  let run = { running: false, mode: null, startedAt: null, endedAt: null, exitCode: null, pid: null, lines: [] };
  let child = null;
  // Map from res -> keepalive interval, so we can clean up dead clients eagerly.
  const sseClients = new Map();

  function removeSSEClient(res) {
    const ka = sseClients.get(res);
    if (ka !== undefined) {
      clearInterval(ka);
      sseClients.delete(res);
    }
  }
  function pushLine(line) {
    const entry = { t: Date.now(), line };
    run.lines.push(entry);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    for (const [res] of sseClients) {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch (_) {
        removeSSEClient(res); // dead client - clean up immediately
      }
    }
  }
  // Idempotent run finalizer - called from BOTH 'close' and 'error' so a failed
  // spawn can never leave run.running stuck true and wedge future runs. `owner`
  // pins it to the child that raised the event: a late 'close' from an old child
  // must not end the run that replaced it.
  function finalizeRun(code, owner) {
    if (!run.running || (owner && child !== owner)) return;
    run.running = false; run.endedAt = Date.now(); run.exitCode = code; run.pid = null; child = null;
    for (const [res] of sseClients) {
      try {
        res.write(`event: end\ndata: ${code}\n\n`);
      } catch (_) {
        removeSSEClient(res); // dead client - clean up immediately
      }
    }
  }

  function childEnv() {
    const e = { ...env };
    for (const k of CHILD_ENV_STRIP) delete e[k];
    // The run must read and write the same files this dashboard shows.
    // The log directory too: a run that wrote its logs anywhere else would leave the
    // History tab and the latest-run summary reading a directory nothing writes to.
    return { ...e, HEADLESS: '1', CI: '1', AIDR_STATE_PATH: STATE, AIDR_CONFIG_PATH: CONFIG, AIDR_CONFIG_ENC_PATH: CONFIG_ENC, AIDR_LOG_DIR: LOGS };
  }

  function startRun(mode, opts = {}) {
    if (run.running) return { error: 'a run is already in progress', status: 409 };
    const args = [WATCHER, ...(MODE_ARGS[mode] || [])];
    // Only append filters for modes that actually honour them in watcher.js.
    if (modeHonorsFilters(mode)) {
      if (opts.only) { args.push('--only', String(opts.only)); }
      if (opts.skip) { args.push('--skip', String(opts.skip)); }
    }

    // Spawn BEFORE touching run state: spawn() can throw synchronously (a NUL byte
    // in an argument, E2BIG), and flipping running:true first used to wedge the
    // dashboard until a restart. args are an array (no shell), so --only/--skip
    // values can't inject commands. process.execPath, not "node": the PATH of a
    // systemd unit may not have one, or the wrong one.
    let c;
    try {
      c = spawnFn(process.execPath, args, { cwd: RUN_CWD, env: childEnv() });
    } catch (err) {
      return { error: `could not start the run: ${err.message}`, status: 500 };
    }

    // Reset run state synchronously BEFORE returning so a stream that connects
    // right after the POST sees the fresh run (not the previous run's stale end).
    child = c;
    run = { running: true, mode, startedAt: Date.now(), endedAt: null, exitCode: null, pid: c.pid || null, lines: [] };
    pushLine(`$ node ${args.join(' ')}`);

    const onData = buf => String(buf).split(/\r?\n/).forEach(l => { if (l.length) pushLine(l); });
    if (c.stdout) c.stdout.on('data', onData);
    if (c.stderr) c.stderr.on('data', onData);
    c.on('close', (code, signal) => {
      pushLine(signal ? `- process ended by ${signal} -` : `- process exited with code ${code} -`);
      finalizeRun(code === null || code === undefined ? -1 : code, c);
    });
    c.on('error', err => { pushLine(`- spawn error: ${err.message} -`); finalizeRun(-1, c); });
    return { ok: true, mode };
  }

  // SIGTERM now, SIGKILL if it has not exited after graceMs. Resolves once the
  // run is over (or immediately when none is running). Used by the stop button
  // and by the dashboard's own shutdown, so stopping the dashboard no longer
  // orphans a watcher that is mid-submission.
  function terminateRun(signal = 'SIGTERM', { graceMs = 8000 } = {}) {
    const c = child;
    if (!c) return Promise.resolve(false);
    return new Promise(resolve => {
      let done = false;
      let timer = null;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(true); };
      c.once('close', finish);
      c.once('error', finish);
      timer = setTimeout(() => {
        try { c.kill('SIGKILL'); } catch (_) {}
        setTimeout(finish, 500).unref();
      }, graceMs);
      timer.unref();
      try { c.kill(signal); } catch (_) { finish(); }
    });
  }

  // state.json writes must not interleave with a run: the watcher keeps its own
  // in-memory state and rewrites the whole file on its next saveState(), silently
  // dropping anything the dashboard added in between (codex #7). So refuse while a
  // run THIS dashboard started is live, or while the state lock a watcher holds
  // (state.json.lock, lib/lock.js) belongs to a live pid; otherwise take the
  // lock ourselves for the read-modify-write so a watcher cannot start under us.
  function withStateWriteAccess(res, fn) {
    if (run.running) {
      res.status(409).json({ error: 'A run is in progress; state.json cannot be changed until it finishes.', code: 'state_busy' });
      return;
    }
    try {
      lock.acquire(STATE_LOCK);
    } catch (e) {
      if (/^LockError/.test(String(e.message))) {
        res.status(409).json({ error: 'Another aidr process holds the state lock; try again when it finishes.', code: 'state_busy' });
      } else {
        res.status(500).json({ error: e.message });
      }
      return;
    }
    try { fn(); } finally { lock.release(STATE_LOCK); }
  }

  // ---- API ------------------------------------------------------------------
  app.get('/api/health', (_req, res) => res.json({ ok: true })); // no path disclosure

  app.get('/api/brokers', (_req, res) => {
    const cm = readConfig();
    const optOuts = ownedOptOuts((readJsonMeta(STATE).data || {}).optOuts, cm.parseError ? null : cm.data);
    const list = loadBrokers().map(b => ({
      name: b.name, method: b.method, priority: b.priority,
      usOnly: !!b.usOnly, captchaLikely: !!b.captchaLikely,
      confidence: b.confidence || null, optOutUrl: b.optOutUrl || null,
      note: b.note || b.notes || null,
      status: b.method === 'manual'
        ? { key: 'manual', label: 'manual', date: '', count: 0, people: [] }
        : aggregateBrokerStatus(optOuts, b.name),
    }));
    res.json(list);
  });

  app.get('/api/state', (_req, res) => {
    const m = readJsonMeta(STATE);
    if (m.parseError) return res.json({ error: 'state.json could not be parsed' });
    res.json(redactState(m.data));
  });

  // GET /api/exposure -> current exposure score (computed from state.json +
  // persisted SERP history) plus the dated snapshot history. The score math
  // lives in the parent repo's lib/exposure.js (pure, unit-tested there).
  app.get('/api/exposure', (_req, res) => {
    let exposure;
    try { exposure = require(EXPOSURE_LIB); }
    catch (e) { return res.status(500).json({ error: 'exposure module unavailable: ' + e.message }); }

    const state = readJsonSafe(STATE, { optOuts: {} });
    const serpRows = readJsonSafe(SERP_HISTORY, []);
    const serpResults = exposure.serpResultsFromHistory(Array.isArray(serpRows) ? serpRows : []);
    const summary = exposure.computeExposureScore({
      state: state && state.optOuts ? state : { optOuts: {} },
      serpResults,
      breachCount: 0,
      brokers: loadBrokers(),
    });
    const history = exposure.loadExposureHistory();
    res.json({ ...summary, history });
  });

  app.get('/api/summary', (_req, res) => {
    const brokers = loadBrokers();
    const sm = readJsonMeta(STATE);
    const cm = readConfig();
    const cfg = cm.data || null;
    // Entries stamped for a previous identity are "never run" to the runner (CFG2-7).
    const opts = ownedOptOuts((sm.data && sm.data.optOuts) || {}, cfg);
    let opted = 0, pending = 0, manual = 0;
    for (const b of brokers) {
      if (b.method === 'manual') { manual++; continue; } // mutually exclusive, matches the table
      const cls = aggregateBrokerStatus(opts, b.name).key;
      if (cls === 'ok') opted++;
      else if (cls === 'pending') pending++;
    }
    // Who the table has columns for: the config's people, or - when the config is
    // locked or unreadable - whoever state.json has results for.
    const fromConfig = peopleFromConfig(cfg);
    const generic = loadGeneric();
    const latest = latestRun(LOGS);
    res.json({
      brokers: brokers.length,
      optedOut: opted, pending, manual,
      people: fromConfig.length ? fromConfig : peopleFromState(opts),
      generic: generic ? tallyGeneric(opts, generic) : null,
      captchas: { sites: latest ? latest.captchaSites : 0, runId: latest ? latest.id : null },
      configured: !!cfg,
      configLocked: !!cm.locked,
      capsolver: !!(cfg && cfg.capsolver && cfg.capsolver.apiKey && cfg.capsolver.apiKey !== 'CAP-YOUR_KEY_HERE'),
      smtp: !!(cfg && cfg.email && cfg.email.smtp && cfg.email.smtp.host && cfg.email.smtp.user),
      webhook: !!(cfg && cfg.notify && cfg.notify.webhook),
      stateExists: sm.exists, stateError: !!sm.parseError,
      run: { running: run.running, mode: run.mode, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode },
    });
  });

  app.get('/api/config', (_req, res) => {
    const m = readConfig();
    if (m.parseError) {
      // Locked (encrypted, no/wrong passphrase): show nothing rather than the
      // example, which would look like the user's own config. Corrupt plaintext:
      // prefill the example so the form can be filled in and saved over it.
      const ex = readJsonSafe(path.join(ROOT, 'config.example.json'), {});
      return res.json({ exists: true, parseError: true, locked: !!m.locked, config: m.locked ? {} : maskConfig(ex) });
    }
    if (!m.exists) {
      const ex = readJsonSafe(path.join(ROOT, 'config.example.json'), {});
      return res.json({ exists: false, config: ex });
    }
    res.json({ exists: true, config: maskConfig(m.data) });
  });

  // First-run gate: report whether config.json has the required person identity
  // fields filled (mirrors lib/config.js getPersonsFromConfig). The browser uses
  // this on boot to decide whether to show the onboarding wizard. An ABSENT
  // config is "not configured" (wizard); a config that exists but cannot be read
  // is `locked` / `unreadable` instead - the wizard would only offer to overwrite
  // something that is fine, and its Save is refused anyway (DASH-10).
  app.get('/api/config/status', (_req, res) => {
    const m = readConfig();
    const cfg = m.parseError ? null : (m.data || null);
    res.json({ ...configStatus(cfg), locked: !!m.locked, unreadable: !!m.parseError });
  });

  app.put('/api/config', (req, res) => {
    const body = req.body;
    const incoming = body && body.config ? body.config : body;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'invalid config' });
    const overwrite = !!(body && body.config && body.overwrite === true) || req.query.overwrite === '1';
    // Use decryption-aware reader so the merge base is always the full decrypted config,
    // not an empty object (which would wipe fields not present in the submitted form).
    const m = readConfig();
    const encrypted = configLib.isConfigEncrypted({ configPath: CONFIG, encPath: CONFIG_ENC });
    // Refuse rather than fall back to plaintext. Writing config.json next to an
    // active config.json.enc put the full PII back on disk in the clear AND had no
    // effect, because loadConfig() prefers the .enc file - a silent double
    // failure. Make the operator supply the passphrase instead.
    if (encrypted && !PASSPHRASE) {
      return res.status(409).json({
        code: 'passphrase_required',
        error: 'Config is encrypted but no passphrase is available to this process. '
          + 'Restart the dashboard with AIDR_PASSPHRASE set; refusing to write a plaintext config.json.',
      });
    }
    // The stored config exists but cannot be read (wrong passphrase, truncated
    // write). Merging onto {} and writing would replace the user's real config
    // with just the form fields - for an encrypted one, under the wrong passphrase,
    // so the right one could never open it again (DASH-1).
    if (m.parseError && !overwrite) {
      return res.status(409).json({
        code: 'config_unreadable',
        locked: !!m.locked,
        error: m.locked
          ? 'The stored config could not be decrypted with the passphrase this dashboard has (wrong AIDR_PASSPHRASE?). '
            + 'Refusing to overwrite it. Restart with the right passphrase, or resend with "overwrite": true to replace it '
            + '(the old file is kept next to it as a .bak).'
          : 'The stored config exists but could not be parsed. Refusing to overwrite it. '
            + 'Fix the file, or resend with "overwrite": true to replace it (the old file is kept next to it as a .bak).',
      });
    }

    const existing = (m.exists && !m.parseError && m.data) ? m.data : {};
    const merged = applyConfigEdit(existing, incoming);
    // The file the config was read from: an envelope kept in config.json is written
    // back there, not to a config.json.enc that would shadow it (CFG2-10).
    const target = m.file || (encrypted ? CONFIG_ENC : CONFIG);
    try {
      // A copy of what we are about to replace, before every replace. When that
      // file was unreadable, also keep a copy no later save can roll over.
      if (m.parseError) backupFile(target, { suffix: `.unreadable-${new Date().toISOString().replace(/[^0-9]/g, '')}.bak` });
      backupFile(target);
      // Re-encrypt the merged config for the enc file; plaintext otherwise.
      writeJsonAtomic(target, encrypted ? secrets.encryptConfig(merged, PASSPHRASE) : merged, 0o600);
      res.json({ ok: true, config: maskConfig(merged) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/logs', (_req, res) => {
    let files = [];
    try {
      for (const ent of fs.readdirSync(LOGS, { withFileTypes: true })) {
        if (!ent.isFile() || !/\.(json|log|txt)$/.test(ent.name)) continue;
        try { const st = fs.statSync(path.join(LOGS, ent.name)); files.push({ name: ent.name, size: st.size, mtime: st.mtimeMs }); }
        catch (_) {} // entry vanished mid-listing - skip it, keep the rest
      }
      files.sort((a, b) => b.mtime - a.mtime);
    } catch (_) {} // logs dir absent/unreadable -> empty list
    res.json(files);
  });

  app.get('/api/logs/:name', (req, res) => {
    const name = path.basename(req.params.name); // strip any traversal
    const file = path.join(LOGS, name);
    if (!file.startsWith(LOGS + path.sep)) return res.status(400).json({ error: 'bad name' });
    let st;
    try { st = fs.statSync(file); } catch (_) { return res.status(404).json({ error: 'not found' }); }
    if (!st.isFile()) return res.status(404).json({ error: 'not found' });
    if (st.size > MAX_LOG_BYTES) return res.status(413).json({ error: `log too large (${st.size} bytes)` });
    // Same URL redaction as the History routes: a log line can quote an opt-out URL
    // whose query holds the user's email, name or zip. The file is capped above, so
    // reading it whole is bounded.
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return res.status(500).json({ error: 'could not read the log' }); }
    res.type(name.endsWith('.json') ? 'application/json' : 'text/plain').send(redactUrls(text));
  });

  // Run history. dashboard/runs.js owns the parsing and the path guarding: the id
  // is matched against a strict pattern and looked up with lstat, so nothing in
  // the request is ever joined into a path, and details leave with URLs reduced
  // to their host.
  app.get('/api/runs', (req, res) => {
    res.json(listRuns(LOGS, { limit: req.query.limit, offset: req.query.offset }));
  });

  app.get('/api/runs/:id', (req, res) => {
    const r = readRun(LOGS, req.params.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ run: r.run, rows: r.rows, truncated: r.truncated, rowCount: r.rowCount });
  });

  app.get('/api/run/status', (_req, res) => {
    res.json({ running: run.running, mode: run.mode, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode, lineCount: run.lines.length });
  });

  app.get('/api/run/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    const tail = run.lines.slice(-REPLAY_LINES); // only replay the tail, not the whole 5000-line buffer
    for (const e of tail) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (!run.running && run.exitCode !== null) res.write(`event: end\ndata: ${run.exitCode}\n\n`);
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) { removeSSEClient(res); } }, 20000);
    sseClients.set(res, ka);
    req.on('close', () => { removeSSEClient(res); });
  });

  app.post('/api/run', (req, res) => {
    // Validate mode (allow-list), reject flag-injection in --only/--skip, and
    // require explicit confirm:true for live modes (real / retry / snapshot /
    // confirm-emails). See dashboard/validate.js for the rationale.
    const v = validateRunRequest(req.body, MODE_ARGS);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    const r = startRun(v.mode, { only: v.only, skip: v.skip });
    if (r.error) return res.status(r.status || 409).json({ error: r.error });
    res.json(r);
  });

  app.post('/api/run/stop', (_req, res) => {
    if (!child) return res.status(400).json({ error: 'no run in progress' });
    terminateRun('SIGTERM'); // escalates to SIGKILL itself; don't leave run.running stuck
    res.json({ ok: true });
  });

  // ---- scheduler (systemd timer aidr.timer + aidr.service) ------------------
  // NOTE: the timer activates aidr.service, which the operator must install (see
  // examples/ in this folder and the README). Requires the dashboard to run as root.
  app.get('/api/schedule', async (_req, res) => {
    const enabled = (await sh('systemctl', ['is-enabled', TIMER])).out.trim();
    const active = (await sh('systemctl', ['is-active', TIMER])).out.trim();
    const list = (await sh('systemctl', ['list-timers', TIMER, '--all', '--no-pager'])).out;
    let next = null;
    const m = list.split('\n').find(l => l.includes(TIMER));
    if (m) { const parts = m.trim().split(/\s{2,}/); const v = parts[0]; next = (v && v !== 'n/a' && v !== '-') ? v : null; }
    let oncalendar = null;
    const cat = await sh('systemctl', ['cat', TIMER]);
    const cm = cat.out.match(/OnCalendar=(.+)/);
    if (cm) oncalendar = cm[1].trim();
    res.json({ enabled, active, next, oncalendar, presets: Object.keys(CALENDARS) });
  });

  app.post('/api/schedule', async (req, res) => {
    const { action, preset } = req.body || {};
    if (action === 'enable') {
      const r = await sh('systemctl', ['enable', '--now', TIMER]);
      if (r.err) {
        const msg = r.errout.trim() || (r.err && r.err.message) || 'systemctl enable failed';
        return res.status(500).json({ error: msg });
      }
    } else if (action === 'disable') {
      const r = await sh('systemctl', ['disable', '--now', TIMER]);
      if (r.err) {
        const msg = r.errout.trim() || (r.err && r.err.message) || 'systemctl disable failed';
        return res.status(500).json({ error: msg });
      }
    // hasOwnProperty, not truthiness: "constructor", "toString" and "__proto__"
    // are truthy on a plain object and reached the unit-file write.
    } else if (action === 'preset' && typeof preset === 'string' && Object.prototype.hasOwnProperty.call(CALENDARS, preset)) {
      const unit = `[Unit]\nDescription=auto-identity-remove ${preset} run\n\n[Timer]\nUnit=aidr.service\nOnCalendar=${CALENDARS[preset]}\nPersistent=true\nRandomizedDelaySec=1800\n\n[Install]\nWantedBy=timers.target\n`;
      try { fs.writeFileSync('/etc/systemd/system/aidr.timer', unit); } catch (e) { return res.status(500).json({ error: e.message }); }
      const rd = await sh('systemctl', ['daemon-reload']);
      if (rd.err) return res.status(500).json({ error: rd.errout.trim() || (rd.err && rd.err.message) || 'daemon-reload failed' });
      const rs = await sh('systemctl', ['restart', TIMER]);
      if (rs.err) return res.status(500).json({ error: rs.errout.trim() || (rs.err && rs.err.message) || 'restart failed' });
    } else return res.status(400).json({ error: 'bad action' });
    const enabled = (await sh('systemctl', ['is-enabled', TIMER])).out.trim();
    res.json({ ok: true, enabled });
  });

  app.get('/api/version', (_req, res) => {
    const pkg = readJsonSafe(path.join(ROOT, 'package.json'), {});
    res.json({ tool: pkg.version || 'unknown', node: process.version, brokers: loadBrokers().length });
  });

  // ---- freeze checklist ------------------------------------------------------
  // Guided credit/identity freeze tracking. GET returns the canonical targets
  // merged with completion status from state.freezes; POST marks a target
  // done/cleared. State is additive - only state.freezes is touched, never
  // state.optOuts. Auth + CSRF are enforced by the global middleware above.
  app.get('/api/freeze', (_req, res) => {
    const m = readJsonMeta(STATE);
    const state = (m.exists && !m.parseError && m.data) ? m.data : { optOuts: {} };
    res.json({ targets: getFreezeStatus(state) });
  });

  app.post('/api/freeze', (req, res) => {
    const { key, action } = req.body || {};
    if (!TARGET_KEYS.has(key)) return res.status(400).json({ error: `unknown freeze target: ${key}` });
    if (action !== 'done' && action !== 'clear') return res.status(400).json({ error: 'bad action (expected "done" or "clear")' });

    withStateWriteAccess(res, () => {
      const m = readJsonMeta(STATE);
      if (m.parseError) return res.status(409).json({ error: 'state.json could not be parsed' });
      const next = applyFreeze((m.exists && m.data) ? m.data : { optOuts: {} }, key, action);
      try {
        writeJsonAtomic(STATE, next, 0o600);
        res.json({ ok: true, targets: getFreezeStatus(next) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  // ---- static + fallbacks -----------------------------------------------------
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // JSON for every failure, with no stack trace and no filesystem path in it.
  // express's default handler renders an HTML page with both, and with the body
  // parser mounted ahead of auth it did so for unauthenticated callers (DASH-8).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return req.socket.destroy();
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'request body is not valid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad request' });
    warn(`aidr-dashboard: ${req.method} ${req.path} failed: ${err && err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  function close() {
    for (const [res] of sseClients) { removeSSEClient(res); try { res.end(); } catch (_) {} }
    return terminateRun('SIGTERM', { graceMs: 2000 });
  }

  return {
    app, close, terminateRun, loadBrokers, loadCreds, authConfigured, openMode,
    paths: { root: ROOT, config: CONFIG, enc: CONFIG_ENC, state: STATE, logs: LOGS, serp: SERP_HISTORY, auth: AUTH_FILE },
  };
}

// ---- start-up -----------------------------------------------------------------

function friendlyListenError(err, host, port) {
  const wrap = (msg) => Object.assign(new Error(msg), { code: err.code });
  if (err.code === 'EADDRINUSE') {
    return wrap(`port ${port} is already in use on ${host}. Stop whatever is using it, or pick another port with AIDR_PORT (for example AIDR_PORT=${Number(port) + 1}).`);
  }
  if (err.code === 'EACCES') {
    return wrap(`not allowed to listen on ${host}:${port}. Ports below 1024 need elevated rights; use AIDR_PORT=8080 or higher.`);
  }
  if (err.code === 'EADDRNOTAVAIL') {
    return wrap(`${host} is not an address on this machine. Check AIDR_HOST (127.0.0.1 for local access only).`);
  }
  return err;
}

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === '') return 8080;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8080;
}

/**
 * Create the app and listen. Rejects (never throws raw) with a message fit to
 * print when the bind is unsafe or the port is taken.
 *
 * @param {object} [opts]  createApp() options plus { host, port, handleSignals }
 * @returns {Promise<{ server: http.Server, host: string, port: number, instance: object }>}
 */
function startServer(opts = {}) {
  const env = opts.env || process.env;
  const host = opts.host || env.AIDR_HOST || '127.0.0.1';
  const instance = createApp({ ...opts, env, bindHost: host });

  const safety = checkBindSafety({ host, authConfigured: instance.authConfigured(), allowNoAuth: instance.openMode });
  if (!safety.ok) return Promise.reject(Object.assign(new Error(safety.error), { code: safety.code }));

  const requested = opts.port !== undefined ? opts.port : parsePort(env.AIDR_PORT);
  return new Promise((resolve, reject) => {
    const server = http.createServer(instance.app);
    server.once('error', err => reject(friendlyListenError(err, host, requested)));
    server.listen(requested, host, () => {
      const port = server.address().port;
      if (opts.handleSignals) forwardSignals(server, instance);
      resolve({ server, host, port, instance });
    });
  });
}

// Stopping the dashboard (systemd stop, Ctrl-C, `kill`) must not leave a watcher
// running unsupervised, mid-submission, with nobody able to stop it from the UI.
function forwardSignals(server, instance) {
  let closing = false;
  const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const sig of Object.keys(exitCodes)) {
    process.on(sig, () => {
      if (closing) return; // the terminal also signals the child's process group
      closing = true;
      server.close();
      instance.terminateRun(sig).then(() => process.exit(exitCodes[sig]));
    });
  }
}

function describeAuth(instance, env) {
  const c = instance.loadCreds();
  const token = !!env.AIDR_TOKEN;
  if (instance.openMode) return 'OPEN (AIDR_DASHBOARD_NO_AUTH=1)';
  if (!instance.authConfigured()) return 'CLOSED (no credentials)';
  return [c ? `basic(${c.source})` : null, token ? 'token' : null].filter(Boolean).join('+');
}

function main() {
  startServer({ handleSignals: true }).then(({ host, port, instance }) => {
    console.log(`aidr-dashboard listening on ${host}:${port} (root=${instance.paths.root}, auth=${describeAuth(instance, process.env)})`);
    const c = instance.loadCreds();
    if (c && c.source === 'broken') console.warn('WARNING: .auth.json is present but corrupt - all logins will fail until it is fixed or removed.');
    if (instance.openMode) console.warn('WARNING: AIDR_DASHBOARD_NO_AUTH=1 - the dashboard is UNAUTHENTICATED (loopback only). For development only: anyone on this machine can read your data and start runs.');
    // The CLI waits for this before printing its URL banner: it must not claim
    // the dashboard is up (or show a password) before it has actually bound.
    if (typeof process.send === 'function') {
      try { process.send({ type: 'aidr-dashboard-listening', host, port }, () => {}); } catch (_) {}
    }
  }).catch(err => {
    console.error(`aidr-dashboard: ${err.message}`);
    process.exit(1);
  });
}

if (require.main === module) main();

// Legacy surface: `require('./server').app` and friends still work, bound to a
// lazily created default instance (paths from the environment, as before).
let defaultInstance = null;
const getDefault = () => (defaultInstance || (defaultInstance = createApp()));

module.exports = {
  createApp,
  startServer,
  MODE_ARGS,
  MASK,
  configStatus,
  readConfigMeta,
  maskConfig,
  mergeConfig,
  get app() { return getDefault().app; },
  loadBrokers: (...a) => getDefault().loadBrokers(...a),
  loadCreds: (...a) => getDefault().loadCreds(...a),
};
