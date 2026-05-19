/**
 * lib/config.js
 *
 * Config + opt-out state management.
 *
 * `state` is a single shared mutable object for the lifetime of the process.
 * `recordSuccess` writes state.json via `saveState()`.
 *
 * Dry-run: call `setDryRun(true)` and `recordSuccess`/`saveState` become
 * no-op-on-disk (in-memory mutation still happens, harmless). This closes the
 * original bug where the notFound/email paths persisted state.json even though
 * `--dry-run` promised "no state will be saved".
 *
 * `resetState()` reloads state from disk *in place* so existing references
 * (e.g. watcher.js's `const state = loadState()`) stay valid — used by tests
 * and the upcoming --verify mode for isolation.
 */

const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH  = path.join(__dirname, '..', 'state.json');

const RECHECK_DAYS = 90; // how often to re-submit to a broker
const CONFIRM_RECHECK_DAYS = 14; // retry pending-confirmation brokers after this many days

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// state.json tracks opt-out history so completed opt-outs aren't re-submitted
// every single run (brokers re-add data every ~90 days, so we re-check then).
let state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { optOuts: {} };

let dryRun = false;

function setDryRun(v) {
  dryRun = !!v;
}

function loadState() {
  return state;
}

// Reload state.json in place so existing references stay valid.
function resetState() {
  const fresh = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    : { optOuts: {} };
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  return state;
}

function saveState() {
  if (dryRun) return; // dry-run promises no persisted state
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function lastOptOutDaysAgo(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry?.lastSuccess) return Infinity;
  return (Date.now() - new Date(entry.lastSuccess).getTime()) / (1000 * 60 * 60 * 24);
}

const HISTORY_MAX = 5;

function appendHistory(brokerName, kind) {
  const entry = state.optOuts[brokerName] || {};
  const history = [...(entry.history || []), kind].slice(-HISTORY_MAX);
  state.optOuts[brokerName] = { ...entry, history };
}

function recordSuccess(brokerName, detail = '') {
  appendHistory(brokerName, 'success');
  state.optOuts[brokerName] = {
    ...state.optOuts[brokerName],
    lastSuccess: new Date().toISOString(),
    totalRuns: ((state.optOuts[brokerName]?.totalRuns) || 0) + 1,
    detail,
  };
  saveState();
}

// Record an explicit failure kind ('error', 'captcha_failed') for drift tracking.
function recordFailure(brokerName, kind) {
  appendHistory(brokerName, kind);
  saveState();
}

// WP4: record that the form was submitted but the broker is awaiting email
// confirmation. Stored separately from full successes so the regular 90-day
// re-check window does not apply — pending entries are retried after
// CONFIRM_RECHECK_DAYS so the user has a chance to click the confirmation link.
function recordPendingConfirmation(brokerName, detail = '') {
  appendHistory(brokerName, 'pending_confirm');
  const prev = state.optOuts[brokerName] || {};
  state.optOuts[brokerName] = {
    ...prev,
    lastAttempt: new Date().toISOString(),
    pendingConfirmation: true,
    totalRuns: (prev.totalRuns || 0) + 1,
    detail: detail || prev.detail || '',
  };
  saveState();
}

// True iff the broker is currently in pending-confirmation state.
function isPendingConfirmation(brokerName) {
  return !!state.optOuts[brokerName]?.pendingConfirmation;
}

// Days since the last attempt (lastSuccess OR lastAttempt). Used together with
// `isPendingConfirmation` to decide whether to re-attempt a pending entry.
function lastAttemptDaysAgo(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry) return Infinity;
  const stamp = entry.lastAttempt || entry.lastSuccess;
  if (!stamp) return Infinity;
  return (Date.now() - new Date(stamp).getTime()) / (1000 * 60 * 60 * 24);
}

// Decide whether to skip a broker this run. Returns either null (do NOT skip)
// or `{ reason }` with a human-readable explanation logged as the skip detail.
function shouldSkip(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry) return null;
  if (entry.pendingConfirmation) {
    const daysAgo = lastAttemptDaysAgo(brokerName);
    if (daysAgo < CONFIRM_RECHECK_DAYS) {
      const daysLeft = Math.max(0, Math.round(CONFIRM_RECHECK_DAYS - daysAgo));
      return { reason: `Pending email confirmation — retry in ${daysLeft}d if still unconfirmed` };
    }
    return null; // confirmation window elapsed, re-attempt
  }
  const daysAgo = lastOptOutDaysAgo(brokerName);
  if (daysAgo < RECHECK_DAYS) {
    const daysLeft = Math.round(RECHECK_DAYS - daysAgo);
    return { reason: `Last removed ${Math.round(daysAgo)}d ago — re-check in ${daysLeft}d` };
  }
  return null;
}

// Countries that use the North American Numbering Plan (NANP).
// NANP numbers are formatted as (xxx) xxx-xxxx.
const NANP_COUNTRIES = new Set(['US', 'CA']);

/**
 * Normalize a phone number for use in form fields.
 *
 * - US and CA (NANP) numbers: strip non-digits, then format as (xxx) xxx-xxxx.
 *   Already-formatted strings that match the pattern are returned unchanged.
 * - All other countries: return the value verbatim (no reformat applied — the
 *   caller's `phoneFormatted` value is assumed to be ready-to-use).
 * - Null/empty input always returns an empty string.
 *
 * @param {string|null|undefined} phone  Raw phone value from config
 * @param {string|undefined} country  ISO 3166-1 alpha-2 country code (default 'US')
 * @returns {string}
 */
function normalizePhone(phone, country) {
  if (!phone) return '';
  const cc = (country || 'US').toUpperCase();
  if (!NANP_COUNTRIES.has(cc)) return phone;

  const digits = String(phone).replace(/\D/g, '');
  // Already correctly formatted — return as-is to avoid double-processing.
  if (/^\(\d{3}\) \d{3}-\d{4}$/.test(String(phone))) return String(phone);
  // For 10-digit NANP numbers, apply (xxx) xxx-xxxx.
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // 11-digit with leading 1 (1-xxx-xxx-xxxx)
  if (digits.length === 11 && digits[0] === '1') {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  // Non-standard length — return as-is to avoid mangling.
  return phone;
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  RECHECK_DAYS,
  CONFIRM_RECHECK_DAYS,
  loadConfig,
  loadState,
  resetState,
  setDryRun,
  saveState,
  lastOptOutDaysAgo,
  lastAttemptDaysAgo,
  isPendingConfirmation,
  shouldSkip,
  recordSuccess,
  recordPendingConfirmation,
  recordFailure,
  normalizePhone,
};
