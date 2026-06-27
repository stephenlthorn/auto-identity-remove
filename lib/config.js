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

const secrets = require('./secrets');

const CONFIG_PATH     = path.join(__dirname, '..', 'config.json');
const CONFIG_ENC_PATH = path.join(__dirname, '..', 'config.json.enc');
const STATE_PATH      = process.env.AIDR_STATE_PATH
  ? path.resolve(process.env.AIDR_STATE_PATH)
  : path.join(__dirname, '..', 'state.json');

// Environment variable that supplies the passphrase for at-rest config encryption.
const PASSPHRASE_ENV = 'AIDR_PASSPHRASE';

// Resolve the active passphrase: explicit override wins, else the env var, else ''.
function getPassphrase(override) {
  if (override !== undefined && override !== null && override !== '') return override;
  return process.env[PASSPHRASE_ENV] || '';
}

// Test-only override for the state file path. null means use STATE_PATH.
let _testStatePath = null;

// Checkpoint path for interrupted-run resume support.
// Default: STATE_PATH + '.checkpoint'; overridden in tests via setTestCheckpointPath.
let _checkpointPath = null;

function _getCheckpointPath() {
  return _checkpointPath || (STATE_PATH + '.checkpoint');
}

function setTestCheckpointPath(p) {
  _checkpointPath = p || null;
}

function saveCheckpoint(brokerName) {
  if (dryRun) return;
  fs.writeFileSync(_getCheckpointPath(), brokerName + '\n');
}

function loadCheckpoint() {
  const p = _getCheckpointPath();
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim() || null;
}

function clearCheckpoint() {
  const p = _getCheckpointPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function getStatePath() {
  return _testStatePath || STATE_PATH;
}

/**
 * Read and parse a JSON state file safely.
 * Returns the parsed object on success, or null on any error
 * (file missing, unreadable, or invalid JSON).
 *
 * @param {string} filePath - Absolute path to the file to read.
 * @returns {object|null}
 */
function readStateFileSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * For tests only: override the state file path so tests don't touch the real file.
 * Pass null to reset to the default STATE_PATH.
 * @param {string|null} p
 */
function setTestStatePath(p) {
  _testStatePath = p || null;
}

const RECHECK_DAYS = 90; // how often to re-submit to a broker
const CONFIRM_RECHECK_DAYS = 14; // retry pending-confirmation brokers after this many days

// Returns the parsed config. Backward compatible:
//   - If config.json.enc exists, decrypt it with the passphrase (env or opts).
//   - Else if config.json's JSON is itself an envelope, decrypt that in place.
//   - Else treat config.json as plaintext (warns if a passphrase is set, since
//     the user likely intended encryption but the file is still in the clear).
// opts (all optional, used by tests + helpers): { configPath, encPath,
//   passphrase, _warn }. With no opts the real paths + AIDR_PASSPHRASE are used.
function loadConfig(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(o.passphrase);
  const warn       = o._warn || ((m) => console.warn(m));

  if (fs.existsSync(encPath)) {
    if (!passphrase) {
      throw new Error(`Encrypted config found (${encPath}) but no passphrase. Set ${PASSPHRASE_ENV}.`);
    }
    const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
    return secrets.decryptConfig(env, passphrase);
  }

  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (secrets.isEncryptedEnvelope(parsed)) {
    if (!passphrase) {
      throw new Error(`Encrypted config found (${configPath}) but no passphrase. Set ${PASSPHRASE_ENV}.`);
    }
    return secrets.decryptConfig(parsed, passphrase);
  }

  if (passphrase) {
    warn(`⚠ ${PASSPHRASE_ENV} is set but config is plaintext. Run \`node watcher.js --encrypt-config\` to encrypt it.`);
  }
  return parsed;
}

// True iff an encrypted config exists on disk (enc file, or an envelope-shaped config.json).
function isConfigEncrypted(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  if (fs.existsSync(encPath)) return true;
  if (!fs.existsSync(configPath)) return false;
  try {
    return secrets.isEncryptedEnvelope(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (_) {
    return false;
  }
}

// Atomic write of a JSON value: tmp -> rename (atomic on POSIX). Mirrors the
// strategy in saveState() so a kill mid-write never leaves a truncated file.
function writeJsonAtomic(target, value) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

// Migration: read plaintext config, write an encrypted envelope to encPath.
// Optionally shred (delete) the plaintext afterward. Returns { encPath }.
function encryptConfigToDisk(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(o.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or pass one in.`);
  if (!fs.existsSync(configPath)) throw new Error(`Plaintext config not found: ${configPath}`);
  const plain = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (secrets.isEncryptedEnvelope(plain)) throw new Error('config.json is already encrypted');
  const envelope = secrets.encryptConfig(plain, passphrase);
  writeJsonAtomic(encPath, envelope);
  if (o.shred) {
    fs.rmSync(configPath, { force: true });
  }
  return { encPath, shredded: !!o.shred };
}

// Migration: read the encrypted envelope, write plaintext config.json.
// Optionally remove the envelope afterward. Returns { configPath }.
function decryptConfigToDisk(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(o.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or pass one in.`);
  let env;
  if (fs.existsSync(encPath)) {
    env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  } else if (fs.existsSync(configPath)) {
    env = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    throw new Error('No encrypted config found to decrypt');
  }
  const plain = secrets.decryptConfig(env, passphrase);
  writeJsonAtomic(configPath, plain);
  if (o.removeEnc && fs.existsSync(encPath)) {
    fs.rmSync(encPath, { force: true });
  }
  return { configPath, removedEnc: !!o.removeEnc };
}

// state.json tracks opt-out history so completed opt-outs aren't re-submitted
// every single run (brokers re-add data every ~90 days, so we re-check then).
//
// The eager init is wrapped in readStateFileSafe so a corrupt/truncated
// state.json at require-time does NOT crash the whole tool. Instead it falls
// back to the .bak file, and if that also fails, to an empty state object.
let state = (() => {
  const primary = readStateFileSafe(STATE_PATH);
  if (primary) return primary;
  const bak = readStateFileSafe(STATE_PATH + '.bak');
  if (bak) return bak;
  return { optOuts: {} };
})();

let dryRun = false;

function setDryRun(v) {
  dryRun = !!v;
}

function loadState() {
  return state;
}

// Reload state.json in place so existing references stay valid.
// Falls back to the .bak file when the primary is missing OR corrupt (SyntaxError
// recovery from a crash mid-write). Falls back to empty state when both fail.
function resetState() {
  const target = getStatePath();
  const bak = target + '.bak';
  const fresh =
    readStateFileSafe(target) ||
    readStateFileSafe(bak) ||
    { optOuts: {} };
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  return state;
}

function saveState() {
  if (dryRun) return; // dry-run promises no persisted state
  const target = getStatePath();
  const tmp    = target + '.tmp';
  const bak    = target + '.bak';
  const bakTmp = bak + '.tmp';

  // (a) Write the new state to a temp file, fsync it (best-effort), then
  //     atomically rename into place so a kill mid-write never truncates target.
  const data = JSON.stringify(state, null, 2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch (_) {} // best-effort: some FSes/platforms lack fsync
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    throw err;
  }
  // Single atomic rename: on POSIX this is guaranteed atomic.
  fs.renameSync(tmp, target);

  // (b) Write the .bak via its own tmp+rename so a kill mid-backup never
  //     leaves a truncated .bak (which would defeat bak recovery on next start).
  try {
    fs.writeFileSync(bakTmp, data);
    fs.renameSync(bakTmp, bak);
  } catch (_) {
    // Best-effort: if the backup fails we still have the primary.
    try { fs.unlinkSync(bakTmp); } catch (__) {}
  }
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
  const prev = state.optOuts[brokerName] || {};
  state.optOuts[brokerName] = {
    ...prev,
    lastSuccess: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
    lastDetail: detail || prev.lastDetail || '',
    totalRuns: (prev.totalRuns || 0) + 1,
  };
  // Clear any stale pending state - both canonical and legacy key names.
  delete state.optOuts[brokerName].pendingConfirm;
  delete state.optOuts[brokerName].pendingConfirmation;
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
function recordPendingConfirmation(brokerName, snippet = '') {
  appendHistory(brokerName, 'pending_confirm');
  const prev = state.optOuts[brokerName] || {};
  state.optOuts[brokerName] = {
    ...prev,
    lastAttempt: new Date().toISOString(),
    pendingConfirm: { since: new Date().toISOString(), snippet: snippet || '' },
    totalRuns: (prev.totalRuns || 0) + 1,
    detail: snippet || prev.detail || '',
  };
  saveState();
}

// True iff the broker is currently in pending-confirmation state.
function isPendingConfirmation(brokerName) {
  return !!(state.optOuts[brokerName]?.pendingConfirm);
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
  if (entry.pendingConfirm) {
    const daysAgo = lastAttemptDaysAgo(brokerName);
    if (daysAgo < CONFIRM_RECHECK_DAYS) {
      const daysLeft = Math.max(0, Math.round(CONFIRM_RECHECK_DAYS - daysAgo));
      return { reason: `Pending email confirmation - retry in ${daysLeft}d if still unconfirmed` };
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

/**
 * Returns an array of {name, since, snippet, expectedSender?} for all brokers
 * currently in pending_confirm state (i.e. pendingConfirm exists and
 * no later success has been recorded).
 *
 * @param {Array<{name: string, expectedSender?: string}>} [brokers]
 *   Optional broker definitions. When provided, the expectedSender field
 *   from the matching broker definition is included in each result entry.
 */
function getPendingConfirmations(brokers) {
  const brokerMap = new Map((brokers || []).map(b => [b.name, b]));
  const entries = [];
  for (const [name, entry] of Object.entries(state.optOuts || {})) {
    if (entry && entry.pendingConfirm && entry.pendingConfirm.since) {
      // Only pending if no later success
      const pendingSince = new Date(entry.pendingConfirm.since);
      const lastSuccess = entry.lastSuccess ? new Date(entry.lastSuccess) : null;
      if (!lastSuccess || pendingSince > lastSuccess) {
        const brokerDef = brokerMap.get(name);
        entries.push({
          name,
          since: entry.pendingConfirm.since,
          snippet: entry.pendingConfirm.snippet || '',
          expectedSender: brokerDef?.expectedSender,
        });
      }
    }
  }
  return entries.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * Return the canonical state key for a (brokerName, person, totalPersons) triple.
 *
 * Single-person mode (totalPersons <= 1 OR no person): returns bare broker name.
 * Multi-person mode (totalPersons > 1 AND person provided): returns "BrokerName|First Last".
 *
 * This is the single source of truth used by both broker-runner (write) and
 * verify-loop (read), ensuring their keys always match.
 *
 * @param {string} brokerName
 * @param {object|null|undefined} person
 * @param {number|undefined} totalPersons
 * @returns {string}
 */
function stateKey(brokerName, person, totalPersons) {
  if (!person || (totalPersons || 1) <= 1) return brokerName;
  return `${brokerName}|${person.firstName} ${person.lastName}`;
}

/**
 * Extracts the array of persons from a config object.
 * Supports both:
 *   { "person": {...} }          - existing single-person format
 *   { "persons": [{...}, {...}] } - new multi-person format
 *
 * The "persons" array takes precedence over "person" when both are present.
 */
function getPersonsFromConfig(config) {
  if (config.persons !== undefined) {
    if (!Array.isArray(config.persons) || config.persons.length === 0) {
      throw new Error('config.persons must be a non-empty array');
    }
    return config.persons;
  }
  if (config.person) {
    return [config.person];
  }
  throw new Error('config.json must include "person" or "persons"');
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

// -- Right-to-know (data access / disclosure) request tracking --
// Records that a "show me what you have" disclosure request was sent to a
// broker. Stored as state.optOuts[name].knowRequestedAt (ISO timestamp).
// Independent of opt-out history so it does not interfere with the 90-day
// re-check window used by shouldSkip.
function recordKnowRequest(brokerName) {
  const prev = state.optOuts[brokerName] || {};
  state.optOuts[brokerName] = {
    ...prev,
    knowRequestedAt: new Date().toISOString(),
  };
  saveState();
}

// Returns [{ name, knowRequestedAt, daysAgo, expectedSender? }] for brokers
// whose right-to-know request is older than opts.olderThanDays (default 45),
// sorted oldest-first. Brokers without knowRequestedAt are excluded. When a
// matching broker definition is supplied, its expectedSender is attached.
function getPendingKnowRequests(brokers, opts = {}) {
  const olderThanDays = opts.olderThanDays != null ? opts.olderThanDays : 45;
  const brokerMap = new Map((brokers || []).map(b => [b.name, b]));
  const out = [];
  for (const [name, entry] of Object.entries(state.optOuts || {})) {
    if (!entry || !entry.knowRequestedAt) continue;
    const daysAgo = (Date.now() - new Date(entry.knowRequestedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < olderThanDays) continue;
    out.push({
      name,
      knowRequestedAt: entry.knowRequestedAt,
      daysAgo,
      expectedSender: brokerMap.get(name)?.expectedSender,
    });
  }
  return out.sort((a, b) => a.knowRequestedAt.localeCompare(b.knowRequestedAt));
}

module.exports = {
  CONFIG_PATH,
  CONFIG_ENC_PATH,
  PASSPHRASE_ENV,
  STATE_PATH,
  RECHECK_DAYS,
  CONFIRM_RECHECK_DAYS,
  readStateFileSafe,
  loadConfig,
  getPassphrase,
  isConfigEncrypted,
  encryptConfigToDisk,
  decryptConfigToDisk,
  loadState,
  resetState,
  setDryRun,
  saveState,
  setTestStatePath,
  lastOptOutDaysAgo,
  lastAttemptDaysAgo,
  isPendingConfirmation,
  shouldSkip,
  recordSuccess,
  recordPendingConfirmation,
  recordFailure,
  normalizePhone,
  getPendingConfirmations,
  getPersonsFromConfig,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  setTestCheckpointPath,
  stateKey,
  recordKnowRequest,
  getPendingKnowRequests,
};
