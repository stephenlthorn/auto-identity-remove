'use strict';
/*
 * lib/config-check.js - `aidr config check`.
 *
 * A mistake in config.json used to surface months later as an odd broker result
 * (a form filled with a lost-zero zip, a copied example config that "succeeded"
 * as Jane Doe). checkConfig() reads the config the way a run would and reports,
 * in one pass: every reason it cannot be run, which config file and passphrase
 * source are in use, where state lives, and how much of that state is stamped
 * with an identity fingerprint.
 *
 * Read-only: it never writes, never quarantines a corrupt state file, and never
 * calls process.exit (loadConfig does that for a missing config, so existence is
 * checked first). The output is meant to be pasted into a bug report, so it
 * carries initials and a masked address instead of a name and an email, and
 * never a passphrase, a key, or a quoted fragment of the file (a JSON.parse
 * error message can quote the bytes it choked on).
 */

const fs = require('fs');
const path = require('path');

const {
  loadConfig,
  validateRunnableConfig,
  getPersonsFromConfig,
  isConfigEncrypted,
  plaintextConfigCopies,
  legacyLayoutProblems,
  describeLegacyLayout,
  readStateFileSafe,
  fingerprintMatches,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
} = require('./config');

const { browserConfigProblems } = require('./browser');
const { captchaConfigWarnings } = require('./manual-captcha');
const { retentionDaysFromConfig } = require('./retention');
const { relaySenderWarning } = require('./email');

const DEFAULT_ROOT = path.join(__dirname, '..');

// lib/paths.js (R0) owns the runtime locations once it exists. Optional, so this
// module works on a tree that does not have it yet.
function _optionalResolvePaths() {
  try {
    return require('./paths').resolvePaths;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes("'./paths'")) return null;
    throw err;
  }
}

function _locations(env, root, resolver) {
  const abs = (p) => path.resolve(p);
  const config = env.AIDR_CONFIG_PATH ? abs(env.AIDR_CONFIG_PATH) : path.join(root, 'config.json');
  const fallback = {
    config,
    configEnc: env.AIDR_CONFIG_ENC_PATH ? abs(env.AIDR_CONFIG_ENC_PATH) : config + '.enc',
    state: env.AIDR_STATE_PATH ? abs(env.AIDR_STATE_PATH) : path.join(root, 'state.json'),
  };
  const resolve = resolver || _optionalResolvePaths();
  const found = typeof resolve === 'function' ? resolve(env, root) : null;
  if (!found) return fallback;
  return {
    config: found.config || fallback.config,
    configEnc: found.configEnc || (found.config ? found.config + '.enc' : fallback.configEnc),
    state: found.state || fallback.state,
  };
}

// ---- passphrase ------------------------------------------------------------

// Same precedence as config.getPassphrase (the env var wins over the file), over
// the injected env instead of process.env.
function _passphraseSource(env) {
  if (env[PASSPHRASE_ENV]) return { source: 'env', passphrase: env[PASSPHRASE_ENV] };
  if (env[PASSPHRASE_FILE_ENV]) return { source: 'file', file: env[PASSPHRASE_FILE_ENV] };
  return { source: 'none' };
}

// The loader's rules for the passphrase file (config.js readPassphraseFile), as
// a problem string instead of a throw: refuse a file other users can read, and a
// file with nothing on its first line. The value itself only leaves this function
// as the return value handed to the decrypt attempt, never in a message.
function _readPassphraseFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      return {
        problem: `${PASSPHRASE_FILE_ENV} ${file} is readable by group/other (mode ${(st.mode & 0o777).toString(8)}). ` +
          `The loader refuses it. Fix with: chmod 600 ${file}`,
      };
    }
    const first = fs.readFileSync(fd, 'utf8').split('\n')[0].replace(/\r$/, '');
    if (!first) return { problem: `${PASSPHRASE_FILE_ENV} ${file} is empty: put the passphrase on its first line` };
    return { passphrase: first };
  } catch (err) {
    return { problem: `${PASSPHRASE_FILE_ENV} ${file} cannot be read (${err.code || 'error'})` };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// ---- loading ---------------------------------------------------------------

// A problem string for a failed load. A SyntaxError keeps only where the parser
// stopped: its message can quote the offending bytes, and in a config that is
// the person's address.
function _describeParseError(err) {
  const lineCol = err.message.match(/\(line (\d+) column (\d+)\)/);
  const position = err.message.match(/at position (\d+)/);
  const where = lineCol ? ` (line ${lineCol[1]} column ${lineCol[2]})` : position ? ` (position ${position[1]})` : '';
  return `not valid JSON${where}`;
}

function _describeLoadError(err, file) {
  if (err instanceof SyntaxError) return `${file} is ${_describeParseError(err)}`;
  if (err && err.hint) return err.hint;
  return `config could not be loaded: ${String((err && err.message) || err).split('\n')[0].slice(0, 200)}`;
}

function _load({ loc, configFile, encrypted, pass, problems }) {
  let passphrase;
  if (encrypted) {
    if (pass.source === 'none') {
      problems.push(`config is encrypted (${configFile}) but no passphrase is set: set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}`);
      return null;
    }
    if (pass.source === 'file') {
      const read = _readPassphraseFile(pass.file);
      if (read.problem) {
        problems.push(read.problem);
        return null;
      }
      passphrase = read.passphrase;
    } else {
      passphrase = pass.passphrase;
    }
  }
  try {
    // Always an explicit passphrase (or none): never fall back to process.env.
    return { cfg: loadConfig({ configPath: loc.config, encPath: loc.configEnc, passphrase, _warn: () => {} }) };
  } catch (err) {
    problems.push(_describeLoadError(err, configFile));
    return null;
  }
}

// ---- display helpers (no PII) ----------------------------------------------

/** j***@example.com. Anything that is not an address becomes ***. */
function maskEmail(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at === -1) return '***';
  const local = s.slice(0, at);
  return `${local ? `${[...local][0]}***` : '***'}@${s.slice(at + 1)}`;
}

const _initial = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t ? `${[...t][0].toUpperCase()}.` : '';
};

/** Z.Q. for Zebediah Quillfeather; ? when there is nothing to show. */
function initialsOf(person) {
  if (!person || typeof person !== 'object') return '?';
  return _initial(person.firstName) + _initial(person.lastName) || '?';
}

// ---- person-level warnings -------------------------------------------------

const _isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const _digitCount = (v) => String(v == null ? '' : v).replace(/\D/g, '').length;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Things that run fine and quietly do the wrong thing. Warnings, not problems:
// none of them stops a run, and a person's data is described by position only.
function _personWarnings(cfg, persons) {
  const warnings = [];
  const labelOf = (i) => (cfg.persons !== undefined ? `persons[${i}]` : 'person');

  persons.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const label = labelOf(i);
    if (!_isBlank(p.email) && !EMAIL_SHAPE.test(String(p.email).trim())) {
      warnings.push(`${label}.email does not look like an email address`);
    }
    const country = _isBlank(p.country) ? '' : String(p.country).trim();
    if (country && !/^[A-Za-z]{2}$/.test(country)) {
      warnings.push(`${label}.country is not a 2-letter code (use US, CA, GB and so on)`);
    }
    const isUS = !country || country.toUpperCase() === 'US';
    if (isUS && !_isBlank(p.zip) && !/^\d{5}(-?\d{4})?$/.test(String(p.zip).trim())) {
      warnings.push(`${label}.zip is not a 5-digit US ZIP (country is US; a leading zero may have been lost)`);
    }
    if (!_isBlank(p.phone) && _digitCount(p.phone) < 7) {
      warnings.push(`${label}.phone has only ${_digitCount(p.phone)} digits`);
    }
  });

  const seenName = new Map();
  const seenEmail = new Map();
  persons.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    if (!_isBlank(p.firstName)) {
      const name = `${_norm(p.firstName)}\n${_norm(p.lastName)}`;
      if (seenName.has(name)) {
        warnings.push(
          `persons[${seenName.get(name)}] and persons[${i}] have the same first and last name: they share one state ` +
          'entry per broker, so every run re-submits both instead of waiting 90 days'
        );
      } else {
        seenName.set(name, i);
      }
    }
    const email = _norm(p.email);
    if (!email) return;
    if (seenEmail.has(email)) {
      warnings.push(
        `persons[${seenEmail.get(email)}] and persons[${i}] share an email address, so a confirmation email ` +
        'cannot be matched to just one of them'
      );
    } else {
      seenEmail.set(email, i);
    }
  });
  return warnings;
}

// ---- state -----------------------------------------------------------------

function _stateReport(statePath, persons, problems, warnings) {
  const summary = { exists: false, entries: 0, stamped: 0, otherIdentity: 0 };

  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    problems.push(`state directory ${dir} does not exist, so state cannot be saved`);
  } else {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (_) {
      warnings.push(
        `state directory ${dir} is not writable by this user (a scheduled run may use another account; ` +
        'the Docker image runs as uid 1001)'
      );
    }
  }

  if (!fs.existsSync(statePath)) return summary;
  summary.exists = true;

  const parsed = readStateFileSafe(statePath);
  if (!parsed) {
    let text;
    try {
      text = fs.readFileSync(statePath, 'utf8');
    } catch (err) {
      // A problem, not a warning: saving over a file this user cannot read is
      // refused (CFG2-2), so a run could not record anything.
      problems.push(
        `state file ${statePath} cannot be read (${err.code || 'error'}), so a run cannot save its progress: ` +
        `fix the owner/permissions (chown $(id -un) ${statePath} && chmod 600 ${statePath}; the Docker image runs as uid 1001)`
      );
      return summary;
    }
    if (text.trim()) {
      warnings.push(
        `state file ${statePath} is not valid state JSON: the next run keeps a copy of it and restores ` +
        `from ${path.basename(statePath)}.bak when that is usable, else starts with empty history`
      );
    }
    return summary;
  }

  for (const entry of Object.values(parsed.optOuts)) {
    summary.entries++;
    if (!entry || typeof entry !== 'object' || !entry.fp) continue;
    summary.stamped++;
    // Either generation of the fingerprint counts as theirs (CFG2-7).
    if (persons.length > 0 && !persons.some((p) => fingerprintMatches(entry.fp, p))) summary.otherIdentity++;
  }
  return summary;
}

// ---- the check -------------------------------------------------------------

/**
 * @param {{ env?: object, root?: string, legacyRoot?: string, _resolvePaths?: Function }} [options]
 *   env   environment to read (default process.env); never mutated
 *   root  install directory holding config.json and state.json by default
 *   legacyRoot  where an old-layout config.json / state.json would sit (default: root)
 *   _resolvePaths  test hook standing in for lib/paths.js resolvePaths
 * @returns {{ ok: boolean, problems: string[], warnings: string[], info: {
 *   configFile: string, configExists: boolean, encrypted: boolean,
 *   passphraseSource: 'env'|'file'|'none', statePath: string, persons: number,
 *   people: Array<{ initials: string, email: string }>,
 *   state: { exists: boolean, entries: number, stamped: number, otherIdentity: number } } }}
 */
function checkConfig(options = {}) {
  const env = options.env || process.env;
  const root = options.root || DEFAULT_ROOT;
  const loc = _locations(env, root, options._resolvePaths);

  const problems = [];
  const warnings = [];

  const configExists = fs.existsSync(loc.configEnc) || fs.existsSync(loc.config);
  const encrypted = isConfigEncrypted({ configPath: loc.config, encPath: loc.configEnc });
  const configFile = fs.existsSync(loc.configEnc) ? loc.configEnc : loc.config;
  const pass = _passphraseSource(env);

  const info = {
    configFile,
    configExists,
    encrypted,
    passphraseSource: pass.source,
    statePath: loc.state,
    persons: 0,
    people: [],
    state: { exists: false, entries: 0, stamped: 0, otherIdentity: 0 },
  };

  // Files left at the old app-directory location while this install reads from
  // somewhere else (the image sets AIDR_HOME): the silent failure of CFG2-8.
  const legacy = legacyLayoutProblems({
    configPath: loc.config, encPath: loc.configEnc, statePath: loc.state, legacyRoot: options.legacyRoot || root,
  });

  let persons = [];
  if (!configExists) {
    problems.push(`config not found: ${loc.config} (or ${loc.configEnc}). Run \`node setup.js\` to create it.`);
    const where = describeLegacyLayout(legacy);
    if (where.length) problems.push(where.join(' '));
  } else {
    const loaded = _load({ loc, configFile, encrypted, pass, problems });
    if (loaded) {
      const cfg = loaded.cfg;
      problems.push(...validateRunnableConfig(cfg));
      // The browser section is a problem, not a warning: a launch with a malformed
      // one throws instead of starting without its proxy (R7).
      problems.push(...browserConfigProblems(cfg.browser));
      try { persons = getPersonsFromConfig(cfg); } catch (_) { persons = []; }
      info.persons = persons.length;
      info.people = persons
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({ initials: initialsOf(p), email: maskEmail(p.email) }));
      warnings.push(..._personWarnings(cfg, persons));
      // These run fine and quietly do something else, so they warn (R1, R6).
      warnings.push(...captchaConfigWarnings(cfg));
      // A relay whose From address is a real one hides nothing from email brokers (BRK2-7).
      const senderWarning = relaySenderWarning(cfg, persons);
      if (senderWarning) warnings.push(senderWarning);
      const retention = retentionDaysFromConfig(cfg);
      if (retention.problem) warnings.push(`${retention.problem}; no files are purged automatically`);

      if (!encrypted && pass.source !== 'none') {
        warnings.push(
          `config is plaintext but a passphrase is set (${pass.source === 'env' ? PASSPHRASE_ENV : PASSPHRASE_FILE_ENV}): ` +
          'run `node watcher.js --encrypt-config` to encrypt it'
        );
      }
    }
    // The dashboard's .bak copies, a kept plaintext, a killed write's temp file: all
    // hold the config in the clear beside the one that is encrypted (CFG2-5).
    for (const copy of plaintextConfigCopies({ configPath: loc.config, encPath: loc.configEnc })) {
      warnings.push(
        `${copy} holds your config in plain text beside the encrypted one (the runtime ignores it): ` +
        `delete it with rm ${copy}`
      );
    }
    if (process.platform !== 'win32') {
      try {
        const mode = fs.statSync(configFile).mode & 0o777;
        if (mode & 0o077) {
          warnings.push(`${configFile} is readable by other users (mode ${mode.toString(8)}): chmod 600 ${configFile}`);
        }
      } catch (_) { /* unreadable: the load problem above says so */ }
    }
  }

  info.state = _stateReport(loc.state, persons.filter((p) => p && typeof p === 'object'), problems, warnings);
  if (configExists) {
    const stateLeft = describeLegacyLayout(legacy.filter((p) => p.kind === 'state'));
    if (stateLeft.length) warnings.push(stateLeft.join(' '));
  }

  return { ok: problems.length === 0, problems, warnings, info };
}

// ---- report ----------------------------------------------------------------

const _count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The report as plain lines (the caller prints them).
 * @param {ReturnType<typeof checkConfig>} result
 * @returns {string[]}
 */
function formatConfigCheck(result) {
  const { info, problems, warnings } = result;
  const row = (label, value) => `  ${(label + ':').padEnd(15)}${value}`;

  const configNote = !info.configExists ? 'not found' : info.encrypted ? 'encrypted' : 'plain text';
  const passphrase = {
    env: `${PASSPHRASE_ENV} (environment variable)`,
    file: `${PASSPHRASE_FILE_ENV} (first line of the file)`,
    none: info.encrypted ? 'none' : 'none (not needed: config is plain text)',
  }[info.passphraseSource];
  const people = info.people.length
    ? `${info.persons} (${info.people.map((p) => `${p.initials} ${p.email}`.trim()).join('; ')})`
    : String(info.persons);

  const lines = [
    'aidr config check',
    row('config file', `${info.configFile} (${configNote})`),
    row('passphrase', passphrase),
    row('state file', info.state.exists ? info.statePath : `${info.statePath} (not created yet)`),
    row('people', people),
  ];
  if (info.state.exists) {
    const { entries, stamped, otherIdentity } = info.state;
    const rerun = otherIdentity > 0
      ? `; ${otherIdentity === 1 ? 'it counts' : 'they count'} as never run and will be re-submitted`
      : '';
    lines.push(row('state entries', `${entries} (${stamped} identity-stamped, ${otherIdentity} for a previous identity)${rerun}`));
  } else {
    lines.push(row('state entries', 'none (no state file yet)'));
  }

  if (problems.length || warnings.length) lines.push('');
  for (const p of problems) lines.push(`  problem: ${p}`);
  for (const w of warnings) lines.push(`  warning: ${w}`);

  lines.push('');
  const warned = _count(warnings.length, 'warning', 'warnings');
  lines.push(problems.length
    ? `Result: ${_count(problems.length, 'problem', 'problems')}, ${warned}`
    : `Result: OK${warnings.length ? `, ${warned}` : ''}`);
  return lines;
}

module.exports = { checkConfig, formatConfigCheck, maskEmail, initialsOf, describeLoadError: _describeLoadError, describeParseError: _describeParseError };
