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
 */

'use strict';

// Modes that perform real, outward-facing actions (submit PII to brokers, click
// confirmation links, retry live submissions). These require explicit confirm.
const LIVE_MODES = new Set(['real', 'retry', 'snapshot', 'confirm']);

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
 * NOTE: the browser app.js mirrors this mapping; keep them in sync.
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

module.exports = {
  LIVE_MODES,
  FILTER_MODES,
  isLiveMode,
  modeHonorsFilters,
  classifyStatus,
  resolveEnvCreds,
  validateFilter,
  validateRunRequest,
};
