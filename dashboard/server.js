'use strict';
/*
 * auto-identity-remove — web dashboard (optional)
 *
 * A small, dependency-light (express-only) control panel that wraps the
 * existing CLI. It reads the project's own files (brokers.js, config.json,
 * state.json, logs/) and drives watcher.js for runs. No personal data lives
 * here — everything is read from / written to the project's config.json.
 *
 * Endpoints (all require auth EXCEPT /api/health):
 *   GET  /api/health             -> { ok } liveness (unauthenticated, no path disclosure)
 *   GET  /api/version            -> tool version + node + broker count
 *   GET  /api/brokers            -> broker definitions (from ../brokers.js)
 *   GET  /api/state              -> ../state.json (raw; {error} if unparseable)
 *   GET  /api/summary            -> counts + config flags + run state
 *   GET  /api/config             -> ../config.json with secrets masked
 *   PUT  /api/config             -> merge-write ../config.json (masked secrets preserved)
 *   GET  /api/logs               -> list of files in ../logs
 *   GET  /api/logs/:name         -> one log file (size-capped, streamed)
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
 *
 * Auth (all routes except /api/health, static + API): set AIDR_USER + AIDR_PASS
 *   for HTTP Basic, and/or AIDR_TOKEN for header token auth (X-AIDR-Token). A
 *   request is allowed if it satisfies EITHER. Credentials can be changed at
 *   runtime via the Admin tab, which writes a scrypt-hashed dashboard/.auth.json
 *   that overrides the env vars. If nothing is set the dashboard is open (a
 *   warning is logged) — only acceptable on a trusted, isolated network.
 *   Cross-origin mutating requests are rejected (CSRF defense); the app does
 *   not depend on a reverse proxy for access control.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { validateRunRequest, modeHonorsFilters, classifyStatus, resolveEnvCreds } = require('./validate');
const { FREEZE_TARGETS, TARGET_KEYS, getFreezeStatus } = require('../lib/freeze');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const STATE = path.join(ROOT, 'state.json');
const LOGS = path.join(ROOT, 'logs');
const BROKERS = path.join(ROOT, 'brokers.js');
const SERP_HISTORY = path.join(ROOT, 'data', 'serp-history.json');
const EXPOSURE_LIB = path.join(ROOT, 'lib', 'exposure.js');

const PORT = Number.parseInt(process.env.AIDR_PORT, 10) || 8080;
const HOST = process.env.AIDR_HOST || '127.0.0.1';
const TOKEN = process.env.AIDR_TOKEN || '';

// Validate env credentials: BOTH must be set or neither is used (fix #6).
const _envCreds = resolveEnvCreds(process.env.AIDR_USER || '', process.env.AIDR_PASS || '');
if (_envCreds.warning) process.stderr.write(_envCreds.warning + '\n');
const ENV_USER = _envCreds.envUser;
const ENV_PASS = _envCreds.envPass;
const AUTH_FILE = path.join(__dirname, '.auth.json'); // runtime-changeable creds (gitignored)
const MASK = '••••••••';
const MAX_LOG_BYTES = 10 * 1024 * 1024; // cap log file reads (avoid OOM / event-loop block)

const app = express();
app.use(express.json({ limit: '512kb' }));

// ---- credentials (file overrides env; env is the bootstrap) ----------------
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function makeCred(user, pw) { const salt = crypto.randomBytes(16).toString('hex'); return { user, salt, hash: hashPw(pw, salt) }; }
// Returns the active credential, or {source:'broken'} (fail-closed) if .auth.json
// exists but is corrupt/incomplete — never silently downgrades to env/open in that case.
function loadCreds() {
  let raw = null;
  try { raw = fs.readFileSync(AUTH_FILE, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') return { source: 'broken' }; }
  if (raw !== null) {
    try {
      const c = JSON.parse(raw);
      if (c && c.user && c.salt && c.hash) return { source: 'file', user: c.user, salt: c.salt, hash: c.hash };
    } catch (_) {}
    return { source: 'broken' }; // present but unusable → require auth, deny everything
  }
  if (ENV_USER && ENV_PASS) return { source: 'env', user: ENV_USER, pass: ENV_PASS };
  return null;
}
function checkBasic(u, p) {
  const c = loadCreds();
  if (!c || c.source === 'broken' || !c.user || !safeEq(u, c.user)) return false;
  return c.source === 'file' ? safeEq(hashPw(p, c.salt), c.hash) : safeEq(p, c.pass);
}
const authConfigured = () => !!(loadCreds() || TOKEN);

function authorized(req) {
  if (!authConfigured()) return true;
  if (TOKEN) { // header only — never accept the token via query string (leaks to logs/history)
    const t = req.get('x-aidr-token');
    if (t && safeEq(t, TOKEN)) return true;
  }
  const c = loadCreds();
  if (c && c.source !== 'broken') {
    const h = req.get('authorization') || '';
    if (h.startsWith('Basic ')) {
      const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      if (checkBasic(u, rest.join(':'))) return true;
    }
  }
  return false;
}
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (authorized(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="aidr dashboard"');
  res.status(401).json({ error: 'unauthorized' });
});
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
app.post('/api/auth/password', (req, res) => {
  const { currentPassword, newPassword, newUsername } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
  const c = loadCreds();
  // If a basic credential exists (env or file), the current password must match.
  // (The auth middleware already gated this route; this is the extra in-session check.)
  if (c && c.source !== 'broken') {
    const ok = c.source === 'file' ? safeEq(hashPw(currentPassword || '', c.salt), c.hash) : safeEq(currentPassword || '', c.pass);
    if (!ok) return res.status(403).json({ error: 'current password is incorrect' });
  } else if (c && c.source === 'broken') {
    return res.status(409).json({ error: '.auth.json is corrupt — fix or delete it on the server first' });
  }
  const user = (newUsername && String(newUsername).trim()) || (c && c.user) || 'admin';
  try {
    writeJsonAtomic(AUTH_FILE, makeCred(user, newPassword), 0o600);
    res.json({ ok: true, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- helpers --------------------------------------------------------------
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
// Atomic write: temp file in the same dir, then rename over the target.
function writeJsonAtomic(file, obj, mode) {
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

// Small TTL cache so repeated /api/summary polls don't re-require brokers.js every time.
const BROKERS_CACHE_TTL = 15000; // 15 seconds
let _brokersCache = null;
let _brokersCacheAt = 0;
function loadBrokers() {
  // brokers.js (parent repo) exports a plain array and reads config.json at
  // require-time; clear its cache so the list reflects config edits.
  const now = Date.now();
  if (_brokersCache && now - _brokersCacheAt < BROKERS_CACHE_TTL) return _brokersCache;
  delete require.cache[require.resolve(BROKERS)];
  try { _brokersCache = require(BROKERS); } catch (e) { _brokersCache = []; }
  _brokersCacheAt = now;
  return _brokersCache;
}

// Mask secret leaves so they never reach the browser.
const SECRET_PATHS = [
  ['capsolver', 'apiKey'],
  ['email', 'smtp', 'pass'],
  ['notify', 'webhook'],
];
function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  for (const p of SECRET_PATHS) {
    let o = c; for (let i = 0; i < p.length - 1; i++) o = o && o[p[i]];
    const k = p[p.length - 1];
    if (o && typeof o[k] === 'string' && o[k]) o[k] = MASK;
  }
  if (c.accounts && typeof c.accounts === 'object') {
    for (const k of Object.keys(c.accounts)) {
      const a = c.accounts[k];
      if (a && typeof a === 'object' && a.password) a.password = MASK;
    }
  }
  return c;
}
// Merge incoming over existing; a value equal to MASK means "keep existing".
function mergeConfig(existing, incoming) {
  if (Array.isArray(incoming)) return incoming;
  if (incoming && typeof incoming === 'object') {
    const out = Array.isArray(existing) ? {} : { ...(existing || {}) };
    for (const k of Object.keys(incoming)) {
      if (incoming[k] === MASK) continue; // preserve existing secret
      out[k] = mergeConfig(existing ? existing[k] : undefined, incoming[k]);
    }
    return out;
  }
  return incoming;
}

// classifyStatus is imported from validate.js (canonical mapping, browser app.js mirrors this; keep in sync).
// Status vocab from lib/logger.js: success / notFound / unverified / pending_confirm / error / captcha_failed / dead / manual

// ---- run management -------------------------------------------------------
const MAX_LINES = 5000;       // ring-buffer cap for the run output
const REPLAY_LINES = 300;     // how many tail lines a reconnecting SSE client gets
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
// spawn can never leave run.running stuck true and wedge future runs.
function finalizeRun(code) {
  if (!run.running) return;
  run.running = false; run.endedAt = Date.now(); run.exitCode = code; run.pid = null; child = null;
  for (const [res] of sseClients) {
    try {
      res.write(`event: end\ndata: ${code}\n\n`);
    } catch (_) {
      removeSSEClient(res); // dead client - clean up immediately
    }
  }
}

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

function startRun(mode, opts = {}) {
  if (run.running) return { error: 'a run is already in progress' };
  const args = ['watcher.js', ...(MODE_ARGS[mode] || [])];
  // Only append filters for modes that actually honour them in watcher.js.
  if (modeHonorsFilters(mode)) {
    if (opts.only) { args.push('--only', String(opts.only)); }
    if (opts.skip) { args.push('--skip', String(opts.skip)); }
  }

  // Reset run state synchronously BEFORE returning so a stream that connects
  // right after the POST sees the fresh run (not the previous run's stale end).
  run = { running: true, mode, startedAt: Date.now(), endedAt: null, exitCode: null, pid: null, lines: [] };
  pushLine(`$ node ${args.join(' ')}`);

  // args are an array (no shell), so --only/--skip values can't inject commands.
  child = spawn('node', args, { cwd: ROOT, env: { ...process.env, HEADLESS: '1', CI: '1' } });
  run.pid = child.pid;

  const onData = buf => String(buf).split(/\r?\n/).forEach(l => { if (l.length) pushLine(l); });
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', code => { pushLine(`— process exited with code ${code} —`); finalizeRun(code); });
  child.on('error', err => { pushLine(`— spawn error: ${err.message} —`); finalizeRun(-1); });
  return { ok: true, mode };
}

// ---- API ------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true })); // no path disclosure

app.get('/api/brokers', (_req, res) => {
  const list = loadBrokers().map(b => ({
    name: b.name, method: b.method, priority: b.priority,
    usOnly: !!b.usOnly, captchaLikely: !!b.captchaLikely,
    confidence: b.confidence || null, optOutUrl: b.optOutUrl || null,
    note: b.note || b.notes || null,
  }));
  res.json(list);
});

app.get('/api/state', (_req, res) => {
  const m = readJsonMeta(STATE);
  if (m.parseError) return res.json({ error: 'state.json could not be parsed' });
  res.json(m.data || {});
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
  const cfg = readJsonMeta(CONFIG).data || null;
  const opts = (sm.data && sm.data.optOuts) || {};
  const lastStatus = name => {
    const o = opts[name];
    if (!o) return '';
    const h = Array.isArray(o.history) ? o.history : [];
    return String(h[h.length - 1] || o.status || '');
  };
  let opted = 0, pending = 0, manual = 0;
  for (const b of brokers) {
    if (b.method === 'manual') { manual++; continue; } // mutually exclusive, matches the table
    const cls = classifyStatus(lastStatus(b.name));
    if (cls === 'ok') opted++;
    else if (cls === 'pending') pending++;
  }
  res.json({
    brokers: brokers.length,
    optedOut: opted, pending, manual,
    configured: !!cfg,
    capsolver: !!(cfg && cfg.capsolver && cfg.capsolver.apiKey && cfg.capsolver.apiKey !== 'CAP-YOUR_KEY_HERE'),
    smtp: !!(cfg && cfg.email && cfg.email.smtp && cfg.email.smtp.host && cfg.email.smtp.user),
    webhook: !!(cfg && cfg.notify && cfg.notify.webhook),
    stateExists: sm.exists, stateError: !!sm.parseError,
    run: { running: run.running, mode: run.mode, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode },
  });
});

app.get('/api/config', (_req, res) => {
  const m = readJsonMeta(CONFIG);
  if (m.parseError) {
    const ex = readJsonSafe(path.join(ROOT, 'config.example.json'), {});
    return res.json({ exists: true, parseError: true, config: maskConfig(ex) });
  }
  if (!m.exists) {
    const ex = readJsonSafe(path.join(ROOT, 'config.example.json'), {});
    return res.json({ exists: false, config: ex });
  }
  res.json({ exists: true, config: maskConfig(m.data) });
});

app.put('/api/config', (req, res) => {
  const incoming = req.body && req.body.config ? req.body.config : req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'invalid config' });
  const existing = readJsonSafe(CONFIG, {});
  const merged = mergeConfig(existing, incoming);
  try {
    writeJsonAtomic(CONFIG, merged, 0o600);
    res.json({ ok: true, config: maskConfig(merged) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', (_req, res) => {
  let files = [];
  try {
    for (const ent of fs.readdirSync(LOGS, { withFileTypes: true })) {
      if (!ent.isFile() || !/\.(json|log|txt)$/.test(ent.name)) continue;
      try { const st = fs.statSync(path.join(LOGS, ent.name)); files.push({ name: ent.name, size: st.size, mtime: st.mtimeMs }); }
      catch (_) {} // entry vanished mid-listing — skip it, keep the rest
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
  res.type(name.endsWith('.json') ? 'application/json' : 'text/plain');
  fs.createReadStream(file).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});

app.get('/api/run/status', (_req, res) => {
  res.json({ running: run.running, mode: run.mode, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode, lineCount: run.lines.length });
});

app.get('/api/run/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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
  if (r.error) return res.status(409).json(r);
  res.json(r);
});

app.post('/api/run/stop', (_req, res) => {
  if (!child) return res.status(400).json({ error: 'no run in progress' });
  const c = child;
  try { c.kill('SIGTERM'); } catch (_) {}
  // Escalate to SIGKILL if it hasn't exited; don't leave run.running stuck.
  setTimeout(() => { try { if (child === c) c.kill('SIGKILL'); } catch (_) {} }, 8000);
  res.json({ ok: true });
});

// ---- scheduler (systemd timer aidr.timer + aidr.service) ------------------
// NOTE: the timer activates aidr.service, which the operator must install (see
// examples/ in this folder and the README). Requires the dashboard to run as root.
const TIMER = 'aidr.timer';
const sh = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { timeout: 8000 }, (err, out, errout) => resolve({ err, out: String(out || ''), errout: String(errout || '') })));

const CALENDARS = { daily: '*-*-* 03:30:00', weekly: 'Sun *-*-* 03:30:00', monthly: '*-*-01 03:30:00' };

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
    if (r.err || (r.err && r.err.code)) {
      const msg = r.errout.trim() || (r.err && r.err.message) || 'systemctl enable failed';
      return res.status(500).json({ error: msg });
    }
  } else if (action === 'disable') {
    const r = await sh('systemctl', ['disable', '--now', TIMER]);
    if (r.err || (r.err && r.err.code)) {
      const msg = r.errout.trim() || (r.err && r.err.message) || 'systemctl disable failed';
      return res.status(500).json({ error: msg });
    }
  } else if (action === 'preset' && CALENDARS[preset]) {
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

  const m = readJsonMeta(STATE);
  if (m.parseError) return res.status(409).json({ error: 'state.json could not be parsed' });
  const state = (m.exists && m.data) ? m.data : { optOuts: {} };
  if (!state.freezes || typeof state.freezes !== 'object') state.freezes = {};

  if (action === 'done') {
    state.freezes[key] = { doneAt: new Date().toISOString() };
  } else {
    delete state.freezes[key];
  }

  try {
    writeJsonAtomic(STATE, state, 0o600);
    res.json({ ok: true, targets: getFreezeStatus(state) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- static + start -------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const c = loadCreds();
    const mode = authConfigured() ? [c ? `basic(${c.source})` : null, TOKEN ? 'token' : null].filter(Boolean).join('+') : 'OPEN';
    console.log(`aidr-dashboard listening on ${HOST}:${PORT} (root=${ROOT}, auth=${mode})`);
    if (c && c.source === 'broken') console.warn('WARNING: .auth.json is present but corrupt - all logins will fail until it is fixed or removed.');
    if (!authConfigured()) console.warn('WARNING: no credentials set - dashboard is UNAUTHENTICATED. Set AIDR_USER/AIDR_PASS or restrict the network.');
  });
}

module.exports = { app, loadBrokers, maskConfig, mergeConfig, loadCreds, MASK };
