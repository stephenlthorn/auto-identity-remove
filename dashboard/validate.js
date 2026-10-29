/**
 * dashboard/validate.js
 *
 * Pure request-validation helpers for the dashboard run endpoint. Kept free of
 * any express / child_process dependency so the security-critical logic can be
 * unit-tested by the project's top-level `node --test` run (which does not
 * install the dashboard's express dependency).
 *
 * Three protections live here, added after security reviews of the
 * dashboard PR:
 *
 *  1. Flag-injection guard for --only / --skip filter values. watcher.js detects
 *     several global modes with `process.argv.includes('--flag')`, scanning the
 *     WHOLE argv - including the value passed after --only/--skip. An unvalidated
 *     filter value like "--no-capsolver", "--serp-scan", "--snapshot" or
 *     "--resume" would therefore silently activate that mode. Filter values are
 *     comma-separated broker names; none can legitimately start with "-".
 *
 *  2. Server-side confirmation for "live" modes (real opt-out submission,
 *     retry-failed, snapshot, confirm-emails). These act on real broker sites
 *     with the user's PII, so they must not fire from a stray / forged / replayed
 *     request that merely names the mode - the caller must explicitly pass
 *     `confirm: true`. The browser UI sends this after its confirmation modal.
 *
 *  3. Filter-mode gating: --only/--skip are only honoured by watcher.js for
 *     preview/real/retry. Sending filters for list/pending/confirm/doctor/verify/
 *     serp modes is silently ignored by watcher.js; this helper gates them at
 *     the server so the caller gets clear feedback instead of silent no-ops.
 *
 * The same module also holds the other pure decisions the server makes: which
 * Host headers are acceptable (DNS rebinding), whether a bind address is safe,
 * what a new username may contain, and how a broker's status is aggregated over
 * the per-person keys multi-person configs write.
 */

'use strict';

// Modes that perform real, outward-facing actions (submit PII to brokers, click
// confirmation links, retry live submissions). These require explicit confirm.
const LIVE_MODES = new Set(['real', 'retry', 'snapshot', 'confirm']);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_FILTER_LENGTH = 4096;
const MAX_USERNAME_LENGTH = 64;

// Modes in which watcher.js actually applies --only / --skip filtering.
// For all other modes the filter flags are parsed but never used, so we gate
// them here to surface a clear error rather than silently discarding them.
const FILTER_MODES = new Set(['preview', 'real', 'retry']);

/**
 * Is the given run mode one that performs a real, irreversible action?
 * @param {string} mode
 * @returns {boolean}
 */
function isLiveMode(mode) {
  return LIVE_MODES.has(mode);
}

/**
 * Does the given run mode honour --only / --skip filters?
 * @param {string} mode
 * @returns {boolean}
 */
function modeHonorsFilters(mode) {
  return FILTER_MODES.has(mode);
}

/**
 * Map a raw watcher.js status string to a canonical display bucket.
 *
 * Status vocabulary (from lib/logger.js STATUS_BUCKET):
 *   success, notFound, unverified, pending_confirm, error, captcha_failed, dead, manual
 *
 * Returns one of: 'ok' | 'notfound' | 'pending' | 'error' | 'manual' | 'other'
 *
 * The browser no longer mirrors this: GET /api/brokers ships the classified
 * status, so there is one mapping and it lives here.
 *
 * @param {*} status  Raw status string from state.json history.
 * @returns {string}
 */
function classifyStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'success':         return 'ok';
    case 'notfound':        return 'notfound';
    case 'pending_confirm': return 'pending';
    case 'unverified':      return 'pending';
    case 'error':           return 'error';
    case 'captcha_failed':  return 'error';
    case 'dead':            return 'error';
    case 'manual':          return 'manual';
    default:                return 'other';
  }
}

/**
 * Decide the active credential source from env vars and whether env creds are
 * fully configured (both user AND password must be set to count as configured).
 *
 * Returns { envUser, envPass, envConfigured, warning? }
 *
 * @param {string} envUser  Value of AIDR_USER env var (empty string if unset).
 * @param {string} envPass  Value of AIDR_PASS env var (empty string if unset).
 * @returns {{ envUser: string, envPass: string, envConfigured: boolean, warning?: string }}
 */
function resolveEnvCreds(envUser, envPass) {
  const hasUser = typeof envUser === 'string' && envUser.length > 0;
  const hasPass = typeof envPass === 'string' && envPass.length > 0;
  if (hasUser && hasPass) {
    return { envUser, envPass, envConfigured: true };
  }
  if (hasUser || hasPass) {
    return {
      envUser: '',
      envPass: '',
      envConfigured: false,
      warning: 'AIDR_USER/AIDR_PASS: only one of the two is set - env credentials ignored (set BOTH to enable)',
    };
  }
  return { envUser: '', envPass: '', envConfigured: false };
}

/**
 * Validate a single --only / --skip filter value.
 *
 * Filter values are a comma-separated list of broker names. No legitimate broker
 * name starts with "-", and allowing one lets the value be reinterpreted by
 * watcher.js as a global flag (argument injection).
 *
 * @param {*} value  Raw value from the request body (may be undefined).
 * @returns {{ ok: true, value: string|undefined } | { ok: false, error: string }}
 */
function validateFilter(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'filter must be a string' };
  }
  // A NUL byte makes child_process.spawn() throw synchronously; any other control
  // character is never part of a broker name and only muddles the run console.
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, error: 'filter contains a control character' };
  }
  if (value.length > MAX_FILTER_LENGTH) {
    return { ok: false, error: `filter is too long (max ${MAX_FILTER_LENGTH} characters)` };
  }
  const tokens = value.split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: true, value: undefined };
  }
  if (tokens.some(t => t.startsWith('-'))) {
    return { ok: false, error: 'filter values cannot start with "-" (flag injection blocked)' };
  }
  return { ok: true, value: tokens.join(',') };
}

/**
 * Validate a /api/run request body.
 *
 * @param {object} body          Parsed request body ({ mode, only, skip, confirm }).
 * @param {object} modeArgsMap   The MODE_ARGS allow-list ({ modeName: [...flags] }).
 * @returns {{ ok: true, mode: string, only: string|undefined, skip: string|undefined }
 *          | { ok: false, status: number, error: string }}
 */
function validateRunRequest(body, modeArgsMap) {
  const b = body || {};
  // A non-string mode is how {"mode":["real"]} slipped past the confirm guard:
  // hasOwnProperty coerced the array to "real" while the LIVE_MODES Set lookup
  // (strict equality) did not, so a real run started with no confirm.
  if (b.mode !== undefined && b.mode !== null && typeof b.mode !== 'string') {
    return { ok: false, status: 400, error: 'mode must be a string' };
  }
  const mode = b.mode || 'preview';

  if (!Object.prototype.hasOwnProperty.call(modeArgsMap, mode)) {
    return { ok: false, status: 400, error: `unknown mode: ${mode}` };
  }

  if (isLiveMode(mode) && b.confirm !== true) {
    return {
      ok: false,
      status: 400,
      error: `mode "${mode}" performs a real action and requires "confirm": true`,
    };
  }

  const only = validateFilter(b.only);
  if (!only.ok) return { ok: false, status: 400, error: only.error };
  const skip = validateFilter(b.skip);
  if (!skip.ok) return { ok: false, status: 400, error: skip.error };

  return { ok: true, mode, only: only.value, skip: skip.value };
}

/**
 * Validate the optional newUsername sent with a password change.
 *
 * HTTP Basic splits the decoded credential on the FIRST ":", so a username
 * holding one can be saved but never logs in again - the owner is locked out of
 * their own dashboard until they delete dashboard/.auth.json by hand. Control
 * characters are rejected for the same reason plus header/log injection.
 *
 * @param {*} value
 * @returns {{ ok: true, value: string|undefined } | { ok: false, error: string }}
 */
function validateUsername(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: 'username must be a string' };
  const v = value.trim();
  if (v === '') return { ok: true, value: undefined };
  if (v.includes(':')) {
    return { ok: false, error: 'username cannot contain ":" (it would never be able to log in)' };
  }
  if (CONTROL_CHARS.test(v)) return { ok: false, error: 'username contains a control character' };
  if (v.length > MAX_USERNAME_LENGTH) {
    return { ok: false, error: `username is too long (max ${MAX_USERNAME_LENGTH} characters)` };
  }
  return { ok: true, value: v };
}

// Worst-first. 'notfound' ranks lowest so one person's "not listed" never hides
// another person's success; 'error' ranks highest so a failure is never averaged away.
const STATUS_RANK = { error: 6, manual: 5, pending: 4, other: 3, ok: 2, notfound: 1 };

function lastHistoryStatus(entry) {
  const h = Array.isArray(entry && entry.history) ? entry.history : [];
  return String(h[h.length - 1] || (entry && entry.status) || '').toLowerCase();
}

/**
 * Collapse every state.optOuts entry that belongs to one broker into a single
 * display status.
 *
 * Single-person runs key state by the bare broker name; multi-person runs key it
 * "Broker|First Last" (lib/config.js stateKey). Looking up only the bare name
 * made a multi-person install read "0 opted out" with every broker succeeded.
 *
 * @param {object} optOuts      state.optOuts (anything else is treated as empty)
 * @param {string} brokerName
 * @returns {{ key: string, label: string, date: string, count: number,
 *             people: Array<{ person: string|null, key: string, label: string, date: string }> }}
 */
function aggregateBrokerStatus(optOuts, brokerName) {
  const map = optOuts && typeof optOuts === 'object' && !Array.isArray(optOuts) ? optOuts : {};
  const prefix = `${brokerName}|`;
  const people = [];
  for (const k of Object.keys(map)) {
    if (k !== brokerName && !k.startsWith(prefix)) continue;
    const entry = map[k];
    if (!entry || typeof entry !== 'object') continue;
    const raw = lastHistoryStatus(entry);
    people.push({
      person: k === brokerName ? null : k.slice(prefix.length),
      key: raw ? classifyStatus(raw) : 'other',
      label: raw || '-',
      date: String(entry.lastSuccess || entry.lastAttempt || ''),
    });
  }
  if (people.length === 0) return { key: 'none', label: '-', date: '', count: 0, people: [] };
  const worst = people.reduce((a, b) => {
    const d = (STATUS_RANK[b.key] || 0) - (STATUS_RANK[a.key] || 0);
    if (d !== 0) return d > 0 ? b : a;
    return b.date > a.date ? b : a;
  });
  return { key: worst.key, label: worst.label, date: worst.date, count: people.length, people };
}

// ---- Host header allow-list (DNS rebinding) ---------------------------------

/**
 * Hostname (no port, lower-case) of a Host header value, or null when it is
 * empty or not a plain host[:port]. IPv6 literals keep their brackets.
 * @param {*} hostHeader
 * @returns {string|null}
 */
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const raw = hostHeader.trim();
  if (!raw || /[\s/\\@?#]/.test(raw)) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Is this a loopback name or address? Accepts brackets around IPv6.
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

const WILDCARD_BINDS = new Set(['', '0.0.0.0', '::', '[::]']);

/**
 * The non-loopback hostnames a request may carry in its Host header: whatever
 * AIDR_ALLOWED_HOSTS lists (comma separated, ports ignored) plus the concrete
 * address the server was told to bind. Loopback is always allowed separately.
 *
 * A browser only sends a Host the user typed or a rebinding page controls, so
 * checking it is what stops evil.example (resolving to 127.0.0.1 for a moment)
 * from driving an unauthenticated dashboard.
 *
 * @param {{ env?: object, bindHost?: string }} opts
 * @returns {Set<string>}
 */
function buildAllowedHosts({ env = {}, bindHost = '' } = {}) {
  const out = new Set();
  for (const entry of String(env.AIDR_ALLOWED_HOSTS || '').split(',')) {
    const h = hostnameOf(entry);
    if (h) out.add(h);
  }
  const bind = String(bindHost || '').trim().toLowerCase();
  if (!WILDCARD_BINDS.has(bind)) {
    const h = hostnameOf(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
    if (h) out.add(h);
  }
  return out;
}

/**
 * @param {*} hostHeader
 * @param {Set<string>} allowed  from buildAllowedHosts()
 * @returns {boolean}
 */
function isHostAllowed(hostHeader, allowed) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  return isLoopbackHost(h) || allowed.has(h);
}

/**
 * Decide whether the server may start on `host`. A non-loopback bind with no
 * credentials hands every machine on the network the config editor (names,
 * addresses, SMTP password) and a button that submits real opt-outs, so it is a
 * refusal rather than the warning it used to be.
 *
 * @param {{ host: string, authConfigured: boolean }} opts
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkBindSafety({ host, authConfigured }) {
  if (isLoopbackHost(host) || authConfigured) return { ok: true };
  return {
    ok: false,
    error: `refusing to listen on ${host} with no credentials: the dashboard edits personal data and can `
      + 'submit real opt-outs. Set AIDR_USER and AIDR_PASS (or AIDR_TOKEN), or bind AIDR_HOST=127.0.0.1.',
  };
}

module.exports = {
  LIVE_MODES,
  FILTER_MODES,
  isLiveMode,
  modeHonorsFilters,
  classifyStatus,
  resolveEnvCreds,
  validateFilter,
  validateRunRequest,
  validateUsername,
  aggregateBrokerStatus,
  hostnameOf,
  isLoopbackHost,
  buildAllowedHosts,
  isHostAllowed,
  checkBindSafety,
};
