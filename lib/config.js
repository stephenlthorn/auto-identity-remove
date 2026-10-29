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
 * (e.g. watcher.js's `const state = loadState()`) stay valid - used by tests
 * and the upcoming --verify mode for isolation.
 */

const path = require('path');
const fs   = require('fs');

const secrets = require('./secrets');

// Where the config lives. The defaults are the repo root; the env overrides let a
// Docker/NAS install mount a dedicated directory (or secret) and point at it
// instead of over-mounting /app/config.json as a single file (CFG-3).
//   AIDR_CONFIG_PATH      plaintext (or in-place envelope) config file
//   AIDR_CONFIG_ENC_PATH  encrypted envelope file; defaults to <config path>.enc
const CONFIG_PATH     = process.env.AIDR_CONFIG_PATH
  ? path.resolve(process.env.AIDR_CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
const CONFIG_ENC_PATH = process.env.AIDR_CONFIG_ENC_PATH
  ? path.resolve(process.env.AIDR_CONFIG_ENC_PATH)
  : CONFIG_PATH + '.enc';
const STATE_PATH      = process.env.AIDR_STATE_PATH
  ? path.resolve(process.env.AIDR_STATE_PATH)
  : path.join(__dirname, '..', 'state.json');

/**
 * Mode for every file that holds PII or credentials: config.json,
 * config.json.enc, state.json, state.json.bak, the checkpoint.
 *
 * These were previously created with the process umask, i.e. 0644 on a default
 * Linux/macOS box - readable by every local account. Harmless on a single-user
 * laptop, a real exposure on the multi-user machines this tool gets deployed to
 * (a NAS with family accounts, a shared VPS, a box running other containers
 * under different uids). The dashboard already used 0600 for its own files.
 */
const OWNER_ONLY = 0o600;

// Environment variable that supplies the passphrase for at-rest config encryption.
const PASSPHRASE_ENV = 'AIDR_PASSPHRASE';
// For scheduled jobs and containers, where putting the passphrase in the
// environment (visible in `ps`/`docker inspect`) is worse than a 0600 file.
const PASSPHRASE_FILE_ENV = 'AIDR_PASSPHRASE_FILE';

/**
 * First line of the passphrase file. Refuses a file that other local users can
 * read: a passphrase protecting the config is only as private as the file that
 * holds it, and silently using a world-readable one would defeat the point.
 */
function readPassphraseFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new Error(
        `${PASSPHRASE_FILE_ENV} ${file} is readable by group/other (mode ${(st.mode & 0o777).toString(8)}). ` +
        `Refusing to use it. Fix with: chmod 600 ${file}`
      );
    }
    const first = fs.readFileSync(fd, 'utf8').split('\n')[0].replace(/\r$/, '');
    if (!first) throw new Error(`${PASSPHRASE_FILE_ENV} ${file} is empty: put the passphrase on its first line`);
    return first;
  } catch (err) {
    if (err.code) throw new Error(`${PASSPHRASE_FILE_ENV} ${file} cannot be read (${err.code})`);
    throw err;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Resolve the active passphrase: explicit override wins, then the env var, then
// the passphrase file, else ''. Throws when AIDR_PASSPHRASE_FILE is set but
// unusable - falling through to '' would read as "no passphrase configured".
function getPassphrase(override) {
  if (override !== undefined && override !== null && override !== '') return override;
  if (process.env[PASSPHRASE_ENV]) return process.env[PASSPHRASE_ENV];
  if (process.env[PASSPHRASE_FILE_ENV]) return readPassphraseFile(process.env[PASSPHRASE_FILE_ENV]);
  return '';
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

const CHECKPOINT_PHASES = new Set(['explicit', 'generic']);

function _isCount(n) {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Normalize a checkpoint to { phase, personIndex, key, index }, or null when it
 * is not one.
 *
 * A bare string is what every run before R2 wrote: the key of the explicit
 * broker in progress, so it means phase 'explicit' with no known person or
 * index. A structured record needs a known phase and a non-empty key; a
 * personIndex or index that is not a non-negative integer reads as null rather
 * than failing, so a hand-edited file degrades to "locate by key" instead of
 * to a wrong skip. Anything else is null, which makes --resume run everything.
 *
 * @param {unknown} raw
 * @returns {{ phase: 'explicit'|'generic', personIndex: number|null, key: string, index: number|null }|null}
 */
function normalizeCheckpoint(raw) {
  if (typeof raw === 'string') {
    const key = raw.trim();
    return key ? { phase: 'explicit', personIndex: null, key, index: null } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!CHECKPOINT_PHASES.has(raw.phase)) return null;
  if (typeof raw.key !== 'string' || raw.key === '') return null;
  return {
    phase: raw.phase,
    personIndex: _isCount(raw.personIndex) ? raw.personIndex : null,
    key: raw.key,
    index: _isCount(raw.index) ? raw.index : null,
  };
}

/**
 * Record how far a run got. Takes the bare broker key the explicit runner has
 * always written, or a structured { phase, personIndex, key, index } record (the
 * generic pass writes these). Always an atomic tmp + rename at mode 0600.
 * A malformed record throws rather than writing something --resume would trust.
 *
 * @param {string|{ phase: string, personIndex?: number, key: string, index?: number }} checkpoint
 */
function saveCheckpoint(checkpoint) {
  if (dryRun) return;
  let line;
  if (typeof checkpoint === 'string') {
    line = checkpoint;
  } else {
    const record = normalizeCheckpoint(checkpoint);
    const given = checkpoint || {};
    const badNumber = (n) => n !== undefined && n !== null && !_isCount(n);
    if (!record || badNumber(given.personIndex) || badNumber(given.index)) {
      throw new TypeError('saveCheckpoint: expected a broker key or { phase: "explicit"|"generic", personIndex, key, index }');
    }
    line = JSON.stringify(record);
  }
  // Atomic tmp + rename (B11): a kill mid-write must never leave an empty
  // checkpoint, which would make --resume silently restart from the top.
  writeFileFsync(_getCheckpointPath(), line + '\n');
}

/**
 * The saved checkpoint: the bare key string for a plain-string file (unchanged
 * from before R2, so older callers keep working), a normalized record for a
 * structured one, null when there is none or it cannot be trusted. Use
 * normalizeCheckpoint() to treat both alike.
 *
 * @returns {string|{ phase: string, personIndex: number|null, key: string, index: number|null }|null}
 */
function loadCheckpoint() {
  const p = _getCheckpointPath();
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8').trim();
  if (!text) return null;
  if (!text.startsWith('{')) return text;
  let parsed;
  // Not valid JSON: a broker name that merely starts with "{" (or a damaged
  // file). Either way it is a plain key, and a key that matches nothing re-runs.
  try { parsed = JSON.parse(text); } catch (_) { return text; }
  return normalizeCheckpoint(parsed);
}

function clearCheckpoint() {
  // A preview must not delete the checkpoint of an interrupted real run, or the
  // next --resume silently restarts from the top (CORE-7).
  if (dryRun) return;
  const p = _getCheckpointPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function getStatePath() {
  return _testStatePath || STATE_PATH;
}

/**
 * True iff `parsed` has the shape of a usable state object: a plain object
 * (not null, not an array) that carries an `optOuts` object. A hand-edited or
 * truncated state.json that parses to `[]`, `42`, or `{foo:1}` is rejected so
 * the "crash-safe load" fallback (.bak / empty) actually kicks in instead of
 * later throwing on `state.optOuts[...]`.
 *
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isValidStateShape(parsed) {
  return (
    !!parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    !!parsed.optOuts &&
    typeof parsed.optOuts === 'object' &&
    !Array.isArray(parsed.optOuts)
  );
}

/**
 * Classify a state file on disk without throwing.
 *
 *   ok          parsed, and has the shape of a state object ({ parsed })
 *   missing     no such file
 *   empty       zero-length or whitespace only (a fresh install, or the residue
 *               of an interrupted in-place write): nothing worth preserving
 *   corrupt     has content, but it is not valid JSON or not a state object
 *               ({ raw }: the bytes, so they can be quarantined)
 *   unreadable  exists but cannot be read (EACCES and friends) ({ error })
 *
 * @param {string} filePath
 */
function _inspectStateFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', error };
  }
  const text = raw.toString('utf8');
  if (!text.trim()) return { status: 'empty' };
  try {
    const parsed = JSON.parse(text);
    if (isValidStateShape(parsed)) return { status: 'ok', parsed };
  } catch (_) { /* falls through to corrupt */ }
  return { status: 'corrupt', raw };
}

/**
 * Read and parse a JSON state file safely.
 * Returns the parsed object on success, or null on any error
 * (file missing, unreadable, invalid JSON, or wrong shape).
 *
 * @param {string} filePath - Absolute path to the file to read.
 * @returns {object|null}
 */
function readStateFileSafe(filePath) {
  const r = _inspectStateFile(filePath);
  return r.status === 'ok' ? r.parsed : null;
}

/**
 * Keep a copy of an unreadable state file as <file>.corrupt-<timestamp> (0600)
 * before anything overwrites it, and return the copy's path (null if even that
 * failed). Identical bytes already quarantined are not copied again, so a
 * process that loads the same bad file several times leaves one copy.
 *
 * This exists because a corrupt state.json used to become an empty state and
 * the next save replaced it (and the .bak): the user's whole opt-out history,
 * silently. A copy costs a few KB.
 */
function _quarantineCorruptFile(filePath, raw) {
  const dir = path.dirname(filePath);
  const prefix = path.basename(filePath) + '.corrupt-';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      try {
        if (fs.readFileSync(path.join(dir, f)).equals(raw)) return path.join(dir, f);
      } catch (_) { /* unreadable sibling: ignore */ }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < 100; i++) {
      const q = path.join(dir, prefix + stamp + (i ? `-${i}` : ''));
      try {
        fs.writeFileSync(q, raw, { mode: OWNER_ONLY, flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        throw err;
      }
      _chmodOwnerOnly(q);
      return q;
    }
  } catch (_) { /* fall through: reported by the caller */ }
  return null;
}

/**
 * Load state from `target`, falling back to `<target>.bak`, then to an empty
 * state. A corrupt file is never discarded silently: it is quarantined and the
 * warning says what the user is about to lose.
 *
 * @param {string} target
 * @returns {object}
 */
function _loadStateFromDisk(target) {
  const primary = _inspectStateFile(target);
  if (primary.status === 'ok') return primary.parsed;

  const keptPrimary = primary.status === 'corrupt' ? _quarantineCorruptFile(target, primary.raw) : null;
  const bak = _inspectStateFile(target + '.bak');
  const keptBak = bak.status === 'corrupt' ? _quarantineCorruptFile(target + '.bak', bak.raw) : null;

  if (bak.status === 'ok') {
    if (primary.status === 'corrupt') {
      console.warn(`⚠ ${target} is corrupt; restored your history from ${target}.bak. ` +
        (keptPrimary ? `The corrupt file was kept at ${keptPrimary}.` : 'Could not keep a copy of the corrupt file.'));
    }
    return bak.parsed;
  }

  if (primary.status === 'corrupt') {
    console.warn(`⚠⚠ ${target} is CORRUPT and there is no usable .bak: starting with EMPTY history, ` +
      'so every broker will be treated as never submitted and re-submitted. ' +
      (keptPrimary
        ? `The corrupt file was kept at ${keptPrimary}; inspect it if you need the history.`
        : 'Could not keep a copy of the corrupt file - it will be overwritten on the next save.') +
      (keptBak ? ` The corrupt backup was kept at ${keptBak}.` : ''));
  } else if (primary.status === 'unreadable') {
    console.warn(`⚠ ${target} exists but cannot be read (${primary.error.code}); starting with empty history. ` +
      'Check the file owner/permissions (the Docker image runs as uid 1001).');
  }
  return { optOuts: {} };
}

// What saveState last wrote to each target (size:mtime). Lets the pre-write
// corruption check skip re-reading a file this process just wrote itself.
const _writtenSig = new Map();
function _sigOf(target) {
  try { const st = fs.statSync(target); return `${st.size}:${st.mtimeMs}`; } catch (_) { return null; }
}

// Before overwriting `target`, make sure a corrupt file there is not destroyed
// unrecorded - e.g. it went bad after this process loaded it.
function _guardCorruptTarget(target) {
  const sig = _sigOf(target);
  if (sig === null || _writtenSig.get(target) === sig) return;
  const cur = _inspectStateFile(target);
  if (cur.status !== 'corrupt') return;
  const kept = _quarantineCorruptFile(target, cur.raw);
  console.warn(`⚠ ${target} is corrupt and is about to be overwritten. ` +
    (kept ? `A copy was kept at ${kept}.` : 'Could not keep a copy of it.'));
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

/**
 * What to tell someone whose config is unreadable by the process: the image
 * runs as uid 1001 (pwuser), and a 0600 file owned by the host user (uid 1000
 * on most Linux boxes, 1026 on Synology) is invisible to it. Reported as the
 * bare EACCES it is, that reads like a bug in this tool.
 */
function _withAccessHint(err, file) {
  const hint =
    `Cannot read ${file}: permission denied. In the Docker image the process runs as uid 1001 (pwuser), ` +
    `so the file must be readable by that uid: chown 1001:1001 ${file} && chmod 600 ${file} ` +
    '(or run the container as the file owner with --user).';
  err.message = `${err.message}\n${hint}`;
  err.hint = hint;
  return err;
}

function _readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'EACCES') throw _withAccessHint(err, file);
    throw err;
  }
}

/**
 * Locate, read and (if needed) decrypt the config, remembering how it was stored
 * so editConfig can write it back the same way.
 *
 * storedAs: 'enc-file' (config.json.enc), 'enc-inplace' (an envelope inside
 * config.json) or 'plain'. Throws an Error with code ENOCONFIG when there is no
 * config at all - callers decide whether that is a process.exit or an error.
 */
function _readConfigDetailed(o, warn) {
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const needPassphrase = (where) => {
    const passphrase = getPassphrase(o.passphrase);
    if (!passphrase) {
      throw new Error(`Encrypted config found (${where}) but no passphrase. Set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}.`);
    }
    return passphrase;
  };

  if (fs.existsSync(encPath)) {
    const passphrase = needPassphrase(encPath);
    const env = JSON.parse(_readText(encPath));
    return { config: secrets.decryptConfig(env, passphrase), storedAs: 'enc-file', path: encPath, passphrase };
  }

  if (!fs.existsSync(configPath)) {
    const err = new Error(`config not found: ${configPath}`);
    err.code = 'ENOCONFIG';
    throw err;
  }

  const parsed = JSON.parse(_readText(configPath));
  if (secrets.isEncryptedEnvelope(parsed)) {
    const passphrase = needPassphrase(configPath);
    return { config: secrets.decryptConfig(parsed, passphrase), storedAs: 'enc-inplace', path: configPath, passphrase };
  }

  if (o.passphrase || process.env[PASSPHRASE_ENV] || process.env[PASSPHRASE_FILE_ENV]) {
    warn(`⚠ ${PASSPHRASE_ENV} is set but config is plaintext. Run \`node watcher.js --encrypt-config\` to encrypt it.`);
  }
  return { config: parsed, storedAs: 'plain', path: configPath, passphrase: '' };
}

// Returns the parsed config. Backward compatible:
//   - If config.json.enc exists, decrypt it with the passphrase (env, file or opts).
//   - Else if config.json's JSON is itself an envelope, decrypt that in place.
//   - Else treat config.json as plaintext (warns if a passphrase is set, since
//     the user likely intended encryption but the file is still in the clear).
// opts (all optional, used by tests + helpers): { configPath, encPath,
//   passphrase, _warn }. With no opts the real paths + AIDR_PASSPHRASE are used.
function loadConfig(opts) {
  const o = opts || {};
  const warn = o._warn || ((m) => console.warn(m));
  try {
    return _readConfigDetailed(o, warn).config;
  } catch (err) {
    if (err.code !== 'ENOCONFIG') throw err;
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }
}

/**
 * Load the config, apply `mutator`, and write the result back the way it was
 * stored: plaintext stays plaintext, an encrypted config is re-encrypted with
 * the same passphrase (never spilled to a plaintext file), an in-place envelope
 * stays in config.json. The write is atomic where the filesystem allows, mode
 * 0600, and falls back to an in-place write on a Docker single-file mount.
 *
 * `mutator` receives the parsed config and must return the new config object
 * (pure: build a new object rather than editing in place). Used by --allow /
 * --unallow so they work on an encrypted install and keep the file private.
 *
 * @param {(cfg: object) => object} mutator
 * @param {{ configPath?: string, encPath?: string, passphrase?: string }} [opts]
 * @returns {{ config: object, encrypted: boolean, path: string }}
 */
function editConfig(mutator, opts) {
  if (typeof mutator !== 'function') throw new TypeError('editConfig: mutator must be a function');
  const o = opts || {};
  const loaded = _readConfigDetailed(o, () => {});
  const next = mutator(loaded.config);
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('editConfig: mutator must return the new config object');
  }
  const encrypted = loaded.storedAs !== 'plain';
  writeJsonAtomic(loaded.path, encrypted ? secrets.encryptConfig(next, loaded.passphrase) : next);
  return { config: next, encrypted, path: loaded.path };
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

/**
 * Move `tmp` onto `target`, falling back to an in-place write when the rename
 * cannot work.
 *
 * rename() is the atomic primitive every durable write here relies on, but it
 * fails with EBUSY when `target` is a Docker single-file bind mount (the kernel
 * holds the mount on that inode) and with EXDEV when tmp and target are on
 * different devices. The documented `docker run -v ./state.json:/app/state.json`
 * recipe hits the EBUSY case on every write, so without this fallback the
 * container persisted no state at all and re-submitted every broker on every
 * scheduled run.
 *
 * The fallback gives up atomicity, which is a real loss - a kill mid-write can
 * truncate the target. saveState() still writes a .bak, and loadState() already
 * recovers from it, so the exposure is one interrupted write rather than lost
 * history. Persisting non-atomically beats not persisting - but it is said out
 * loud, once per process, so nobody believes they have crash safety they lack.
 *
 * Any other error is rethrown: EACCES and friends are genuine misconfiguration
 * and must not be papered over. On every failure the temp file is removed: it
 * can hold the plaintext config.
 */
// Best-effort: an existing file keeps its old mode through a rename, and some
// filesystems (exFAT, a Windows share, a bind mount) reject chmod entirely.
function _chmodOwnerOnly(target) {
  try { fs.chmodSync(target, OWNER_ONLY); } catch (_) {}
}

let _inPlaceWarned = false;
function _resetInPlaceWarning() { _inPlaceWarned = false; }

function _renameOrRewrite(tmp, target, data) {
  try {
    fs.renameSync(tmp, target);
    return;
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EXDEV' && err.code !== 'EPERM') {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
    if (!_inPlaceWarned) {
      _inPlaceWarned = true;
      console.warn(`⚠ Cannot atomically replace ${target} (${err.code}): it is a single-file mount or on another ` +
        'filesystem, so it is rewritten in place and a crash mid-write can truncate it (no crash safety). ' +
        'Mount the containing directory instead and point AIDR_STATE_PATH / AIDR_CONFIG_PATH into it.');
    }
    try {
      fs.writeFileSync(target, data, { mode: OWNER_ONLY });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
}

// Durable write: write `data` to a temp file, fsync it (best-effort), then
// atomically rename into place. Mirrors saveState()'s guarantees so a crash
// after the rename never leaves a zero-length target. Shared by saveState,
// saveCheckpoint, and the config-encryption migrations (B10, B11). The temp
// file is removed on every error path (CFG-15a): for config.json it is plaintext.
function writeFileFsync(target, data) {
  const tmp = target + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', OWNER_ONLY);
    // The mode argument only applies when the file is created; a stale temp
    // file from a crashed run would otherwise keep its old, looser mode.
    try { fs.fchmodSync(fd, OWNER_ONLY); } catch (_) {}
    fs.writeSync(fd, data);
    try { fs.fsyncSync(fd); } catch (_) {} // best-effort: some FSes/platforms lack fsync
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
  _renameOrRewrite(tmp, target, data);
  _chmodOwnerOnly(target);
}

// Atomic + fsync'd write of a JSON value: tmp -> fsync -> rename. Used by the
// config-encryption migrations so an interrupted --encrypt-config never leaves
// a truncated config.json.enc when the plaintext has already been shredded, and
// by setup/editConfig for the config itself. Result is always mode 0600.
function writeJsonAtomic(target, value) {
  writeFileFsync(target, JSON.stringify(value, null, 2));
}

/**
 * Remove the plaintext config after it has been encrypted.
 *
 * rm fails with EBUSY when config.json is a Docker single-file bind mount. The
 * old code let that throw (after the .enc was written), or - with the encrypted
 * copy sitting in the container's writable layer - reported success while
 * persisting nothing. When the file cannot be removed it is overwritten with
 * zeros and truncated, so no PII is left in it, and the result says plainly that
 * it was NOT removed. If even that fails the error says the plaintext is still
 * on disk.
 */
function _shredPlaintext(configPath) {
  try {
    fs.rmSync(configPath, { force: true });
    return { shredded: true };
  } catch (rmErr) {
    try {
      const size = fs.statSync(configPath).size;
      fs.writeFileSync(configPath, Buffer.alloc(size));
      fs.writeFileSync(configPath, '');
    } catch (wipeErr) {
      throw new Error(
        `Encrypted config was written, but the plaintext config at ${configPath} could not be removed ` +
        `(${rmErr.code || rmErr.message}) or emptied (${wipeErr.code || wipeErr.message}). ` +
        'It still holds your PII: delete it yourself.'
      );
    }
    return {
      shredded: false,
      plaintextEmptied: true,
      notice: `${configPath} could not be deleted (${rmErr.code || rmErr.message}; a single-file bind mount?). ` +
        'Its contents were overwritten and truncated, so no PII remains in it. Delete the empty file yourself.',
    };
  }
}

// Migration: read plaintext config, write an encrypted envelope to encPath.
// Optionally shred (delete) the plaintext afterward. Returns
// { encPath, shredded, plaintextEmptied?, notice? }; shredded is false whenever
// the plaintext file still exists, whatever the reason.
function encryptConfigToDisk(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(o.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}, or pass one in.`);
  if (!fs.existsSync(configPath)) throw new Error(`Plaintext config not found: ${configPath}`);
  const plain = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (secrets.isEncryptedEnvelope(plain)) throw new Error('config.json is already encrypted');
  writeJsonAtomic(encPath, secrets.encryptConfig(plain, passphrase));

  // Read it back before the plaintext is touched: a write that "succeeded" onto
  // a mount that does not persist (or a full disk) must not cost the only copy.
  let roundTrip;
  try {
    roundTrip = secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), passphrase);
  } catch (err) {
    throw new Error(`Encrypted config could not be read back from ${encPath} (${err.message}); the plaintext was left in place.`);
  }
  if (JSON.stringify(roundTrip) !== JSON.stringify(plain)) {
    throw new Error(`Encrypted config read back from ${encPath} does not match; the plaintext was left in place.`);
  }

  if (!o.shred) return { encPath, shredded: false };
  return { encPath, ..._shredPlaintext(configPath) };
}

// Migration: read the encrypted envelope, write plaintext config.json.
// Optionally remove the envelope afterward. Returns { configPath }.
function decryptConfigToDisk(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath    = o.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(o.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}, or pass one in.`);
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
let state = _loadStateFromDisk(STATE_PATH);

let dryRun = false;

function setDryRun(v) {
  dryRun = !!v;
}

function loadState() {
  return state;
}

// Reload state.json in place so existing references stay valid.
// Falls back to the .bak file when the primary is missing OR corrupt (SyntaxError
// recovery from a crash mid-write). Falls back to empty state when both fail;
// a corrupt file is quarantined and warned about, never silently dropped (CFG-6).
function resetState() {
  const fresh = _loadStateFromDisk(getStatePath());
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  return state;
}

function saveState() {
  if (dryRun) return; // dry-run promises no persisted state
  const target = getStatePath();
  const bak    = target + '.bak';
  const bakTmp = bak + '.tmp';

  // (a) Write the new state to a temp file, fsync it (best-effort), then
  //     atomically rename into place so a kill mid-write never truncates target.
  //     Degrades to an in-place write when target is a bind mount or on another
  //     device - see _renameOrRewrite. A corrupt file already at `target` is
  //     copied aside first (CFG-6), never overwritten unrecorded.
  const data = JSON.stringify(state, null, 2);
  _guardCorruptTarget(target);
  writeFileFsync(target, data);
  _writtenSig.set(target, _sigOf(target));

  // (b) Write the .bak via its own tmp+rename so a kill mid-backup never
  //     leaves a truncated .bak (which would defeat bak recovery on next start).
  try {
    fs.writeFileSync(bakTmp, data, { mode: OWNER_ONLY });
    _renameOrRewrite(bakTmp, bak, data);
    _chmodOwnerOnly(bak);
  } catch (_) {
    // Best-effort: if the backup fails we still have the primary.
    try { fs.unlinkSync(bakTmp); } catch (__) {}
  }
}

// The entry for a broker. With opts.person the lookup goes through readEntry
// (composite key, plus the legacy bare key for persons[0]); without it
// `brokerName` is taken as a literal state key, as every caller used to pass.
function _entryFor(brokerName, opts) {
  if (opts && opts.person) return readEntry(state, brokerName, opts.person, opts.personCount, opts);
  return state.optOuts[brokerName];
}

function lastOptOutDaysAgo(brokerName, opts) {
  const entry = _entryFor(brokerName, opts);
  if (!entry?.lastSuccess) return Infinity;
  return (Date.now() - new Date(entry.lastSuccess).getTime()) / (1000 * 60 * 60 * 24);
}

const HISTORY_MAX = 5;

// Defunct detection needs at least DEFUNCT_THRESHOLD trailing history entries to
// see a run of consecutive errors; if HISTORY_MAX ever drops below it, defunct
// detection silently breaks. Fail loudly at load time instead (B21).
{
  const { DEFUNCT_THRESHOLD } = require('./defunct');
  if (HISTORY_MAX < DEFUNCT_THRESHOLD) {
    throw new Error(
      `HISTORY_MAX (${HISTORY_MAX}) must be >= DEFUNCT_THRESHOLD (${DEFUNCT_THRESHOLD}); ` +
      'defunct detection needs the full run of trailing history entries.'
    );
  }
}

function appendHistory(brokerName, kind) {
  const entry = state.optOuts[brokerName] || {};
  const history = [...(entry.history || []), kind].slice(-HISTORY_MAX);
  state.optOuts[brokerName] = { ...entry, history };
}

function recordSuccess(brokerName, detail = '') {
  appendHistory(brokerName, 'success');
  const prev = state.optOuts[brokerName] || {};
  // Single clock read (B23): lastAttempt must not predate lastSuccess by a tick.
  const now = new Date().toISOString();
  state.optOuts[brokerName] = {
    ...prev,
    lastSuccess: now,
    lastAttempt: now,
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
// re-check window does not apply - pending entries are retried after
// CONFIRM_RECHECK_DAYS so the user has a chance to click the confirmation link.
function recordPendingConfirmation(brokerName, snippet = '') {
  appendHistory(brokerName, 'pending_confirm');
  const prev = state.optOuts[brokerName] || {};
  const now = new Date().toISOString();
  state.optOuts[brokerName] = {
    ...prev,
    lastAttempt: now,
    pendingConfirm: { since: now, snippet: snippet || '' },
    totalRuns: (prev.totalRuns || 0) + 1,
    // Unified on lastDetail (B7): recordSuccess also writes lastDetail; the old
    // `detail` field was never read anywhere.
    lastDetail: snippet || prev.lastDetail || '',
  };
  saveState();
}

// True iff the broker is currently in pending-confirmation state.
function isPendingConfirmation(brokerName, opts) {
  return !!(_entryFor(brokerName, opts)?.pendingConfirm);
}

// Days since the last attempt (lastSuccess OR lastAttempt). Used together with
// `isPendingConfirmation` to decide whether to re-attempt a pending entry.
function lastAttemptDaysAgo(brokerName, opts) {
  const entry = _entryFor(brokerName, opts);
  if (!entry) return Infinity;
  const stamp = entry.lastAttempt || entry.lastSuccess;
  if (!stamp) return Infinity;
  return (Date.now() - new Date(stamp).getTime()) / (1000 * 60 * 60 * 24);
}

// Decide whether to skip a broker this run. Returns either null (do NOT skip)
// or `{ reason }` with a human-readable explanation logged as the skip detail.
//
// `brokerName` is a literal state key unless opts.person is given, in which case
// it is the bare broker name and the key is derived (see readEntry):
//   opts = { person, personCount, personIndex | persons }
function shouldSkip(brokerName, opts) {
  const entry = _entryFor(brokerName, opts);
  if (!entry) return null;
  if (entry.pendingConfirm) {
    const daysAgo = lastAttemptDaysAgo(brokerName, opts);
    if (daysAgo < CONFIRM_RECHECK_DAYS) {
      const daysLeft = Math.max(0, Math.round(CONFIRM_RECHECK_DAYS - daysAgo));
      return { reason: `Pending email confirmation - retry in ${daysLeft}d if still unconfirmed` };
    }
    return null; // confirmation window elapsed, re-attempt
  }
  const daysAgo = lastOptOutDaysAgo(brokerName, opts);
  if (daysAgo < RECHECK_DAYS) {
    const daysLeft = Math.round(RECHECK_DAYS - daysAgo);
    return { reason: `Last removed ${Math.round(daysAgo)}d ago - re-check in ${daysLeft}d` };
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
        const brokerDef = brokerMap.get(name) || brokerMap.get(brokerPart(name));
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
 * The broker half of a state key: "Broker|First Last" -> "Broker". Writers key
 * multi-person entries by the composite, but broker definitions (expectedSender
 * and friends) are keyed by name alone, so every reader that crosses the two
 * must strip it (CFG-8).
 */
function brokerPart(key) {
  const i = String(key).indexOf('|');
  return i === -1 ? String(key) : String(key).slice(0, i);
}

function _isFirstPerson(person, opts) {
  if (!opts) return false;
  if (opts.personIndex !== undefined && opts.personIndex !== null) return opts.personIndex === 0;
  const first = Array.isArray(opts.persons) ? opts.persons[0] : null;
  return !!(first && person && first.firstName === person.firstName && first.lastName === person.lastName);
}

/**
 * The one reader for a (broker, person) state entry.
 *
 * Returns the entry under stateKey(brokerName, person, personCount). For
 * persons[0] only, it falls back to the legacy bare-broker key: a single-person
 * install writes bare keys, and adding a second person flips person 1 to
 * "Broker|Name", which would orphan their whole history (and re-submit every
 * broker) without this. persons[1..] never fall back - the bare entry is not
 * theirs.
 *
 * Who counts as persons[0] must be stated: opts.personIndex (0-based) or
 * opts.persons (the config's array, compared by first+last name). With neither
 * there is no fallback; guessing could hand one person another's history.
 *
 * @param {{ optOuts?: object }} st
 * @param {string} brokerName
 * @param {object|null|undefined} person
 * @param {number|undefined} personCount
 * @param {{ personIndex?: number, persons?: object[] }} [opts]
 * @returns {object|undefined}
 */
function readEntry(st, brokerName, person, personCount, opts) {
  const optOuts = (st && st.optOuts) || {};
  const key = stateKey(brokerName, person, personCount);
  if (optOuts[key] !== undefined) return optOuts[key];
  if (key !== brokerName && _isFirstPerson(person, opts)) return optOuts[brokerName];
  return undefined;
}

/**
 * Find the index of the broker whose stateKey equals `checkpoint` (B22).
 *
 * saveCheckpoint stores the composite key ("Broker|First Last") in multi-person
 * mode, so --resume must compute the same key per broker instead of comparing
 * against the bare broker.name (which silently re-runs everything in
 * multi-person mode). Returns -1 when no broker matches or checkpoint is empty.
 *
 * Takes the bare key or a structured record; only an explicit-phase one can
 * match, since a generic-phase checkpoint means the explicit pass already ended.
 *
 * @param {Array<{ name: string }>} brokers
 * @param {string|object|null|undefined} checkpoint  as returned by loadCheckpoint()
 * @param {object|null|undefined} person
 * @param {number|undefined} totalPersons
 * @returns {number}
 */
function findResumeIndex(brokers, checkpoint, person, totalPersons) {
  const record = normalizeCheckpoint(checkpoint);
  // A generic-phase record means the explicit pass is over; its key names a
  // generic row, which must not be matched against the explicit list.
  if (!record || record.phase !== 'explicit') return -1;
  return (brokers || []).findIndex(
    b => stateKey(b.name, person, totalPersons) === record.key
  );
}

/**
 * Which person (index into `persons`) a checkpoint belongs to, or -1 when it
 * cannot be pinned to one of the CURRENT persons.
 *
 * The key says it: in a multi-person run the state key is "Broker|First Last",
 * in a single-person run it is the bare broker name. A key whose shape does not
 * fit today's person list (a person was added or removed since the interrupted
 * run) names nobody, which is the same refusal findResumeIndex gives a bare key
 * in a multi-person run. The record's own personIndex only breaks a tie between
 * two persons with the same name.
 */
function _checkpointPersonIndex(record, persons) {
  if (persons.length === 0) return -1;
  const pipe = record.key.indexOf('|');
  if (persons.length === 1) return pipe === -1 ? 0 : -1;
  if (pipe === -1) return -1;
  const who = record.key.slice(pipe + 1);
  const named = persons.flatMap((p, i) => (`${p.firstName} ${p.lastName}` === who ? [i] : []));
  if (named.length === 0) return -1;
  return named.includes(record.personIndex) ? record.personIndex : named[0];
}

/**
 * What --resume should skip, decided from the checkpoint alone (pure).
 *
 * A run is the explicit pass for every person in order, THEN the generic pass for
 * every person in order, so a checkpoint says which of those passes finished.
 * One entry per person, in person order:
 *
 *   skipExplicit       this person's email opt-outs and explicit forms are done
 *   explicitResumeKey  the key to pass to findResumeIndex for this person's
 *                      explicit list (only the checkpoint's own person), else null
 *   skipGeneric        this person's generic pass is done
 *   genericResume      { index, key } for runGenericBrokers' opts.resumeFrom
 *                      (only the person the generic checkpoint is inside), else null
 *
 * Skipping needs evidence. A checkpoint that cannot be pinned to a current
 * person skips nothing in its own phase; the only inference made without
 * the person is that a generic-phase checkpoint means every explicit pass ended.
 *
 * @param {string|object|null|undefined} checkpoint  as returned by loadCheckpoint()
 * @param {Array<{ firstName: string, lastName: string }>} persons
 * @returns {Array<{ skipExplicit: boolean, explicitResumeKey: string|null, skipGeneric: boolean, genericResume: { index: number|null, key: string }|null }>}
 */
function planResume(checkpoint, persons) {
  const people = Array.isArray(persons) ? persons : [];
  const plan = people.map(() => ({ skipExplicit: false, explicitResumeKey: null, skipGeneric: false, genericResume: null }));
  const record = normalizeCheckpoint(checkpoint);
  if (!record) return plan;

  if (record.phase === 'generic') plan.forEach((entry) => { entry.skipExplicit = true; });

  const at = _checkpointPersonIndex(record, people);
  if (at < 0) return plan;

  if (record.phase === 'explicit') {
    plan.forEach((entry, i) => { if (i < at) entry.skipExplicit = true; });
    plan[at].explicitResumeKey = record.key;
    return plan;
  }
  plan.forEach((entry, i) => { if (i < at) entry.skipGeneric = true; });
  plan[at].genericResume = { index: record.index, key: record.key };
  return plan;
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

const REQUIRED_PERSON_FIELDS = ['firstName', 'lastName', 'email', 'zip'];
const EXAMPLE_CONFIG_PATH = path.join(__dirname, '..', 'config.example.json');

// Fields (outside `person`) where copying config.example.json unchanged means the
// config was never filled in. Their placeholder VALUES are read from the example
// file; only the paths live here. capsolver.apiKey is deliberately absent: setup
// writes that placeholder when the user chooses not to solve CAPTCHAs.
const EXAMPLE_PLACEHOLDER_PATHS = [
  ['email', 'smtp', 'user'],
  ['email', 'smtp', 'pass'],
  ['email', 'smtp', 'from'],
  ['relay', 'apiKey'],
  ['notify', 'textTo'],
];

const _isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const _norm = (v) => String(v).trim().toLowerCase();
const _digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const _getPath = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/**
 * Reasons this config must not be run, as a list of strings ([] when fine).
 *
 * Two classes of problem both produced a "successful" run that protected nobody
 * (CFG-7): blank required person fields, and values copied unchanged from
 * config.example.json - the README says to copy that file, and an unedited copy
 * parses, runs as "Jane Doe", and records successes that then suppress the real
 * run for 90 days.
 *
 * Placeholders are read from config.example.json (opts.examplePath overrides it
 * for tests); a missing or unparsable example never blocks a run. A person is
 * flagged for the example's email, its first AND last name together, or its
 * phone number - not for a shared first name, city or state, which real people
 * have.
 *
 * @param {object} cfg
 * @param {{ examplePath?: string }} [opts]
 * @returns {string[]}
 */
function validateRunnableConfig(cfg, opts) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config is empty or not an object'];

  let persons;
  try {
    persons = getPersonsFromConfig(cfg);
  } catch (err) {
    return [err.message];
  }

  let example = {};
  try {
    example = JSON.parse(fs.readFileSync((opts && opts.examplePath) || EXAMPLE_CONFIG_PATH, 'utf8')) || {};
  } catch (_) { /* no example to compare with: only the blank checks apply */ }
  const exPerson = example.person || (Array.isArray(example.persons) ? example.persons[0] : null) || null;
  const placeholder = (what, ex) => `${what} is still the config.example.json placeholder (${ex})`;

  const problems = [];
  persons.forEach((p, i) => {
    const label = cfg.persons !== undefined ? `persons[${i}]` : 'person';
    if (!p || typeof p !== 'object') {
      problems.push(`${label} is not an object`);
      return;
    }
    for (const field of REQUIRED_PERSON_FIELDS) {
      if (_isBlank(p[field])) problems.push(`${label}.${field} is blank`);
    }
    if (!exPerson) return;
    if (!_isBlank(p.email) && !_isBlank(exPerson.email) && _norm(p.email) === _norm(exPerson.email)) {
      problems.push(placeholder(`${label}.email`, exPerson.email));
    }
    if (!_isBlank(p.firstName) && !_isBlank(p.lastName) &&
        _norm(p.firstName) === _norm(exPerson.firstName || '') && _norm(p.lastName) === _norm(exPerson.lastName || '')) {
      problems.push(placeholder(`${label} name`, `${exPerson.firstName} ${exPerson.lastName}`));
    }
    if (_digits(p.phone) && _digits(p.phone) === _digits(exPerson.phone)) {
      problems.push(placeholder(`${label}.phone`, exPerson.phone));
    }
  });

  for (const keys of EXAMPLE_PLACEHOLDER_PATHS) {
    const have = _getPath(cfg, keys);
    const ex = _getPath(example, keys);
    if (!_isBlank(have) && !_isBlank(ex) && _norm(have) === _norm(ex)) {
      problems.push(`${keys.join('.')} is still the config.example.json placeholder`);
    }
  }
  return problems;
}

// Countries that use the North American Numbering Plan (NANP).
// NANP numbers are formatted as (xxx) xxx-xxxx.
const NANP_COUNTRIES = new Set(['US', 'CA']);

/**
 * Normalize a phone number for use in form fields.
 *
 * - US and CA (NANP) numbers: strip non-digits, then format as (xxx) xxx-xxxx.
 *   Already-formatted strings that match the pattern are returned unchanged.
 * - All other countries: return the value verbatim (no reformat applied - the
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
  // Already correctly formatted - return as-is to avoid double-processing.
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
  // Non-standard length - return as-is to avoid mangling.
  return phone;
}

// -- Right-to-know (data access / disclosure) request tracking --
// Records that a "show me what you have" disclosure request was sent to a
// broker. Stored as state.optOuts[<key>].knowRequestedAt (ISO timestamp).
// Independent of opt-out history so it does not interfere with the 90-day
// re-check window used by shouldSkip.
//
// The state key is derived via stateKey (B6): in multi-person mode each person
// gets their own composite "Broker|First Last" entry, matching the keys that
// recordSuccess / the verify-loop write, instead of all persons collapsing onto
// one bare-name knowRequestedAt. `person`/`totalPersons` are optional so existing
// bare-name callers (and single-person runs) are unchanged.
//
// @param {string} brokerName
// @param {object|null} [person]
// @param {number} [totalPersons]
function recordKnowRequest(brokerName, person, totalPersons) {
  const key = stateKey(brokerName, person, totalPersons);
  const prev = state.optOuts[key] || {};
  state.optOuts[key] = {
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
      expectedSender: (brokerMap.get(name) || brokerMap.get(brokerPart(name)))?.expectedSender,
    });
  }
  return out.sort((a, b) => a.knowRequestedAt.localeCompare(b.knowRequestedAt));
}

module.exports = {
  CONFIG_PATH,
  CONFIG_ENC_PATH,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  STATE_PATH,
  RECHECK_DAYS,
  CONFIRM_RECHECK_DAYS,
  HISTORY_MAX,
  OWNER_ONLY,
  _renameOrRewrite,
  _resetInPlaceWarning,
  readStateFileSafe,
  loadConfig,
  editConfig,
  writeJsonAtomic,
  validateRunnableConfig,
  readEntry,
  brokerPart,
  getStatePath,
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
  normalizeCheckpoint,
  planResume,
  stateKey,
  findResumeIndex,
  recordKnowRequest,
  getPendingKnowRequests,
};
