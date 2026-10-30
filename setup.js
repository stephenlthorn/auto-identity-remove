#!/usr/bin/env node
/**
 * auto-identity-remove - interactive setup
 *
 * Run once: node setup.js
 *
 * Creates config.json from your answers and walks you through:
 *   • Personal info (name, address, email, phone)
 *   • CapSolver API key (for CAPTCHA-protected sites)
 *   • Accounts for sites that require login (one-time)
 *   • macOS launchd scheduling (1st of every month)
 *   • iMessage notification number
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const readline = require('readline');
const { Writable } = require('stream');
const { execSync } = require('child_process');

const { installSchedule } = require('./lib/scheduler');
const { resolvePaths } = require('./lib/paths');
const { mkdirPrivate } = require('./lib/private-fs');
const {
  encryptConfigToDisk, writeJsonAtomic, getPassphrase,
  CONFIG_PATH, CONFIG_ENC_PATH, STATE_PATH,
} = require('./lib/config');

/**
 * Read the existing config so setup can offer current values as defaults.
 *
 * Must understand the encrypted layouts. Reading CONFIG_PATH directly meant that
 * on an install where `--encrypt-config` had moved the PII into config.json.enc,
 * setup saw nothing: it showed blank prompts, then wrote a fresh **plaintext**
 * config.json beside the still-active .enc file. Full PII back on disk in the
 * clear, the user's existing values lost, and no effect at runtime either since
 * loadConfig() prefers the .enc.
 *
 * @param {{ configPath?: string, encPath?: string, passphrase?: string }} [opts]
 * @returns {{ exists: boolean, encrypted: boolean, locked: boolean, corrupt?: boolean, config: object }}
 *   `locked` means an encrypted config exists but could not be decrypted (no or
 *   wrong passphrase). `corrupt` means config.json exists but is not valid JSON.
 *   In both cases the caller must refuse to overwrite the file rather than
 *   silently starting from scratch.
 */
function readExistingConfig(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath = o.encPath || CONFIG_ENC_PATH;
  const passphrase = o.passphrase !== undefined ? o.passphrase : getPassphrase();
  const secrets = require('./lib/secrets');

  const decrypt = (envelope) => {
    if (!passphrase) return { exists: true, encrypted: true, locked: true, config: {} };
    try {
      return { exists: true, encrypted: true, locked: false, config: secrets.decryptConfig(envelope, passphrase) };
    } catch (_) {
      return { exists: true, encrypted: true, locked: true, config: {} };
    }
  };

  if (fs.existsSync(encPath)) {
    try {
      return decrypt(JSON.parse(fs.readFileSync(encPath, 'utf8')));
    } catch (_) {
      return { exists: true, encrypted: true, locked: true, config: {} };
    }
  }

  if (!fs.existsSync(configPath)) {
    return { exists: false, encrypted: false, locked: false, config: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return { exists: true, encrypted: false, locked: false, corrupt: true, config: {} };
  }

  // In-place encryption leaves the envelope in config.json itself.
  if (secrets.isEncryptedEnvelope(parsed)) return decrypt(parsed);

  return { exists: true, encrypted: false, locked: false, config: parsed };
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────
//
// One readline interface owns the terminal for the whole wizard. Its output goes
// through a stream that can be muted, which is how a secret is read without
// echo: the same interface keeps line-editing it (backspace, paste), nothing
// else is listening to stdin, and no typed character can leak into the next
// prompt. (The old askSecret attached a raw 'data' listener beside a live
// readline: it got the first keystroke only and echoed the rest - CFG-2.)

function createMutableOutput(output) {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, cb) {
      if (!muted) output.write(chunk, encoding);
      cb();
    },
  });
  // readline sizes its cursor math from the output it is given.
  Object.defineProperty(stream, 'columns', { get: () => output.columns });
  Object.defineProperty(stream, 'isTTY', { get: () => !!output.isTTY });
  return { stream, setMuted: (v) => { muted = v; } };
}

// Resolve with the next line typed on `rl` with echo suppressed; reject if input
// ends first, so a half-typed secret is never mistaken for a whole one. On a
// terminal, readline flushes the partial line when the stream ends; that is not
// Enter, so it is treated as "input closed". (Piped input keeps readline's
// behaviour: a last line without a newline is a complete answer.)
function readSecretFrom(rl, { input, terminal, output, setMuted, prompt }) {
  return new Promise((resolve, reject) => {
    let inputEnded = false;
    const onEnd = () => { inputEnded = true; };
    const closed = () => new Error('input closed before the passphrase was entered');
    const onClose = () => { setMuted(false); reject(closed()); };
    if (terminal) input.prependOnceListener('end', onEnd);
    rl.once('close', onClose);
    output.write(prompt || '');
    setMuted(true);
    rl.once('line', (line) => {
      input.removeListener('end', onEnd);
      rl.removeListener('close', onClose);
      setMuted(false);
      if (inputEnded) return reject(closed());
      output.write('\n');
      resolve(line);
    });
  });
}

/**
 * Read one line from `input` without echoing it.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, prompt?: string, terminal?: boolean }} [opts]
 * @returns {Promise<string>}
 */
function readSecret(opts) {
  const o = opts || {};
  const input = o.input || process.stdin;
  const output = o.output || process.stdout;
  const terminal = o.terminal !== undefined ? o.terminal : !!input.isTTY;
  const { stream, setMuted } = createMutableOutput(output);
  const rl = readline.createInterface({ input, output: stream, terminal });
  return readSecretFrom(rl, { input, terminal, output, setMuted, prompt: o.prompt }).finally(() => rl.close());
}

/**
 * The wizard's prompts, all on one readline interface.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, terminal?: boolean }} [opts]
 */
function createPrompter(opts) {
  const o = opts || {};
  const input = o.input || process.stdin;
  const output = o.output || process.stdout;
  const terminal = o.terminal !== undefined ? o.terminal : !!input.isTTY;
  const { stream, setMuted } = createMutableOutput(output);
  const rl = readline.createInterface({ input, output: stream, terminal });

  const ask = (q, def = '') => new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('input closed before the wizard finished'));
    rl.once('close', onClose);
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (ans) => {
      rl.removeListener('close', onClose);
      resolve(ans.trim() || def);
    });
  });
  const askSecret = (q) => readSecretFrom(rl, { input, terminal, output, setMuted, prompt: `${q}: ` });
  const confirm = async (q) => {
    const ans = (await ask(`${q} (y/n)`, 'y')).toLowerCase();
    return ans === 'y' || ans === 'yes';
  };
  return { ask, askSecret, confirm, close: () => rl.close() };
}

/**
 * Ask for a new passphrase twice and return it only when both entries match.
 * Returns '' for "no passphrase" (empty first entry, or too many mismatches), so
 * the caller leaves the config unencrypted instead of encrypting it under a
 * passphrase the user may have mistyped - the file would be unrecoverable.
 *
 * @param {{ read: (question: string) => Promise<string>, say?: (msg: string) => void, attempts?: number }} deps
 * @returns {Promise<string>}
 */
async function askNewPassphrase({ read, say = console.log, attempts = 3 }) {
  for (let i = 0; i < attempts; i++) {
    const first = await read('Choose a passphrase (keep it safe - there is no recovery)');
    if (!first) return '';
    const second = await read('Type it again to confirm');
    if (first === second) return first;
    say('  The two entries did not match - try again (or press Enter at the first prompt to skip encryption).');
  }
  say('  The passphrases still did not match.');
  return '';
}

// ─── International helpers (pure, exported for unit tests) ───────────────────

/**
 * Return the correct prompt labels for region and postal fields based on country.
 * US uses "State (2-letter)" and "ZIP code"; all others use "Province/Region"
 * and "Postal code" (no format coercion).
 *
 * @param {string} country  2-letter ISO country code (upper-case)
 * @returns {{ regionLabel: string, postalLabel: string }}
 */
function regionPrompts(country) {
  if (country === 'US') {
    return { regionLabel: 'State (2-letter)', postalLabel: 'ZIP code' };
  }
  return { regionLabel: 'Province/Region', postalLabel: 'Postal code (any format, e.g. K1A 0A6)' };
}

/**
 * Format a phone number for display.
 * US 10-digit strings are formatted as (xxx) xxx-xxxx.
 * All other inputs (non-US country or non-10-digit) are returned verbatim.
 *
 * @param {string} phone    Raw phone string
 * @param {string} country  2-letter ISO country code (upper-case)
 * @returns {string}
 */
function formatPhone(phone, country) {
  if (country === 'US' && phone.length === 10) {
    return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
  }
  return phone;
}

/**
 * If a non-empty passphrase is given, encrypt the plaintext config at configPath
 * into encPath (shredding the plaintext). Returns { encrypted: boolean }.
 * Pure aside from the file I/O it delegates to lib/config.encryptConfigToDisk.
 *
 * @param {{ passphrase: string, configPath?: string, encPath?: string }} opts
 */
function maybeEncryptConfig(opts) {
  const o = opts || {};
  const passphrase = o.passphrase || '';
  if (!passphrase) return { encrypted: false };
  const res = encryptConfigToDisk({
    passphrase,
    shred: true,
    ...(o.configPath ? { configPath: o.configPath } : {}),
    ...(o.encPath ? { encPath: o.encPath } : {}),
  });
  return {
    encrypted: true,
    encPath: res.encPath,
    shredded: res.shredded,
    ...(res.notice ? { notice: res.notice } : {}),
  };
}

// ─── Config building (pure, exported for unit tests) ─────────────────────────

const REQUIRED_ANSWERS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email address'],
  ['zip', 'ZIP / postal code'],
];

/** The person record setup edits: persons[0] for a persons config, else person. */
function primaryPerson(existing) {
  const e = existing || {};
  if (Array.isArray(e.persons) && e.persons.length > 0) return e.persons[0] || {};
  return e.person || {};
}

/**
 * The value each prompt offers as its default, taken from the existing config.
 * Pressing Enter at every prompt therefore reproduces that config.
 */
function answerDefaults(existing) {
  const e = existing || {};
  const p = primaryPerson(e);
  return {
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    aliases: Array.isArray(p.aliases) ? [...p.aliases] : [],
    city: p.city || '',
    country: (p.country || 'US').toUpperCase(),
    state: p.state || '',
    zip: p.zip || '',
    email: p.email || '',
    phone: p.phone || '',
    capsolverKey: (e.capsolver || {}).apiKey || '',
    textTo: (e.notify || {}).textTo || '',
    webhook: (e.notify || {}).webhook || '',
    profileDir: e.profileDir || '',
    accounts: { ...(e.accounts || {}) },
  };
}

/**
 * Build the config setup will write: `existing` with the answered values applied
 * and every key setup does not ask about left exactly as it was (persons[1..],
 * email.smtp, relay, hibp, allowlist, notify.emailReportTo, anything added by
 * hand or by a later version). For a persons config the wizard edits persons[0]
 * in place and never adds a `person` key beside it. Throws on a blank first
 * name, last name, email or postal code: a config with those blank runs as
 * nobody and records "successes" that suppress the real run.
 *
 * Pure: neither argument is mutated.
 *
 * @param {object} existing  Current config ({} for a fresh install).
 * @param {object} answers   See answerDefaults for the shape.
 * @returns {object}
 */
function buildConfig(existing, answers) {
  const base = existing || {};
  const a = answers || {};
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  const missing = REQUIRED_ANSWERS.filter(([key]) => blank(a[key])).map(([, label]) => label);
  if (missing.length > 0) {
    const err = new Error(`Required answers are blank: ${missing.join(', ')}`);
    err.code = 'INVALID_ANSWERS';
    throw err;
  }

  const country = (a.country || 'US').toUpperCase();
  const phone = a.phone || '';
  const personFields = {
    firstName: a.firstName.trim(),
    lastName: a.lastName.trim(),
    fullName: `${a.firstName.trim()} ${a.lastName.trim()}`,
    aliases: Array.isArray(a.aliases) ? [...a.aliases] : [],
    city: a.city || '',
    country,
    state: a.state || '',
    zip: String(a.zip).trim(),
    email: a.email.trim(),
    phone,
    phoneFormatted: formatPhone(phone, country),
  };

  const config = { ...base };
  if (Array.isArray(base.persons) && base.persons.length > 0) {
    config.persons = [{ ...base.persons[0], ...personFields }, ...base.persons.slice(1)];
  } else {
    config.person = { ...(base.person || {}), ...personFields };
  }

  config.capsolver = { ...(base.capsolver || {}), apiKey: a.capsolverKey || 'CAP-YOUR_KEY_HERE' };
  config.notify = { ...(base.notify || {}), textTo: a.textTo || '', ...(a.webhook ? { webhook: a.webhook } : {}) };
  if (a.profileDir) config.profileDir = a.profileDir;
  const accounts = { ...(base.accounts || {}), ...(a.accounts || {}) };
  if (base.accounts || Object.keys(accounts).length > 0) config.accounts = accounts;
  return config;
}

/**
 * Write the config atomically (temp file + fsync + rename), always mode 0600 -
 * including over an existing 0644 file, which a plain writeFileSync `mode`
 * option leaves alone.
 *
 * @param {object} config
 * @param {{ configPath?: string }} [opts]
 * @returns {string} the path written
 */
function saveConfig(config, opts) {
  const configPath = (opts && opts.configPath) || CONFIG_PATH;
  writeJsonAtomic(configPath, config);
  return configPath;
}

/**
 * What the monthly job runs and where it logs: this install's run.sh, and the log
 * directory the runtime itself uses (AIDR_HOME / AIDR_LOG_DIR; the app directory's
 * logs/ when neither is set).
 */
function scheduleJobOptions(env = process.env) {
  return { scriptPath: path.join(__dirname, 'run.sh'), logDir: resolvePaths(env).logs };
}

/**
 * How setup reports an installSchedule() result. The installer answers `ok: false`
 * when the OS scheduler refused; that must read as a failure, never as the green
 * line a success gets, and it fails setup (a result with no verdict is not trusted).
 *
 * @param {{ ok?: boolean, method?: string, detail?: string }|undefined} result
 * @returns {{ failed: boolean, text: string }}
 */
function describeScheduleResult(result) {
  const r = result || {};
  if (r.ok === true) return { failed: false, text: `✅ [${r.method}] ${r.detail}` };
  const why = r.detail || 'the scheduler gave no reason';
  return {
    failed: true,
    text: `❌ Monthly schedule NOT installed [${r.method || 'unknown'}]: nothing will run it.\n   ${why}`,
  };
}

/**
 * The "Monthly Schedule" step: ask, install, say what happened.
 * @returns {Promise<{ asked: boolean, failed: boolean }>}
 */
async function runScheduleStep({ confirm }) {
  console.log('── Monthly Schedule ────────────────────────────────────────');
  const doSchedule = await confirm('Schedule to run automatically on the 1st of every month at 9am?');
  if (!doSchedule) return { asked: true, failed: false };
  const shown = describeScheduleResult(installSchedule(scheduleJobOptions()));
  console.log(`${shown.text}\n`);
  return { asked: true, failed: shown.failed };
}

module.exports = {
  regionPrompts, formatPhone, maybeEncryptConfig, readExistingConfig,
  buildConfig, answerDefaults, saveConfig, scheduleJobOptions,
  readSecret, createPrompter, askNewPassphrase,
  describeScheduleResult, runScheduleStep,
};

// ─── Main setup ───────────────────────────────────────────────────────────────

async function main() {
  const { ask, askSecret, confirm, close } = createPrompter();
  // A required answer is asked again until it is not blank: a blank name, email
  // or postal code would make the config run as nobody (CFG-1).
  const askRequired = async (q, def = '') => {
    for (;;) {
      const v = await ask(q, def);
      if (v) return v;
      console.log('  This one is required.');
    }
  };
  console.log('\n🔒 auto-identity-remove - Setup\n');
  console.log('This will create config.json with your personal info (gitignored).');
  console.log('Run this once. Re-run anytime to update.\n');

  // Load existing config if present - including the encrypted layouts.
  const prior = readExistingConfig();
  if (prior.encrypted && prior.locked) {
    // Never overwrite an encrypted config we cannot read. Doing so would write
    // plaintext PII beside the .enc file, lose the user's existing values, and
    // have no runtime effect (loadConfig prefers the .enc).
    console.error('\n❌ An encrypted config exists (config.json.enc) but it could not be decrypted.');
    console.error('   Set the passphrase and re-run so your current values are preserved:\n');
    console.error('     AIDR_PASSPHRASE=... node setup.js\n');
    console.error('   Refusing to continue: writing a plaintext config.json here would put your');
    console.error('   full PII back on disk in the clear and would be ignored at runtime anyway.');
    process.exit(1);
  }
  if (prior.corrupt) {
    // Starting from {} would replace a hand-edited config that merely has a typo.
    console.error(`\n❌ ${CONFIG_PATH} exists but is not valid JSON.`);
    console.error('   Fix it (or move it aside) and re-run; refusing to overwrite it.');
    process.exit(1);
  }
  const existing = prior.config;
  if (prior.exists) {
    console.log(prior.encrypted
      ? 'ℹ  Existing encrypted config found - press Enter to keep current values.\n'
      : 'ℹ  Existing config.json found - press Enter to keep current values.\n');
  }
  const editsPersonsArray = Array.isArray(existing.persons) && existing.persons.length > 0;
  if (editsPersonsArray) {
    const who = existing.persons[0].fullName || `${existing.persons[0].firstName} ${existing.persons[0].lastName}`;
    console.log(`ℹ  This config has ${existing.persons.length} person(s). Setup edits persons[0] (${who}) in place;`);
    console.log('   the other people and every other setting (SMTP, relay, allowlist...) are left as they are.');
    console.log('   To change someone else, edit config.json by hand.\n');
  }
  const d = answerDefaults(existing);

  // ── Personal info ────────────────────────────────────────────────────────
  console.log('── Personal Info ──────────────────────────────────────────');
  const firstName      = await askRequired('First name',              d.firstName);
  const lastName       = await askRequired('Last name',               d.lastName);
  const aliasInput     = await ask('Aliases (comma-separated, e.g. "Steve Doe, S Doe")', d.aliases.join(', '));
  const aliases        = aliasInput ? aliasInput.split(',').map(s => s.trim()).filter(Boolean) : [];
  const city           = await ask('City',                    d.city);
  const country        = (await ask('Country (2-letter ISO, e.g. US, CA, GB, AU)', d.country)).toUpperCase();
  const { regionLabel, postalLabel } = regionPrompts(country);
  const state          = await ask(regionLabel,               d.state);
  const zip            = await askRequired(postalLabel,       d.zip);
  const email          = await askRequired('Email address',   d.email);
  const phone          = await ask('Phone (digits only for US; any format for non-US)', d.phone);

  // ── CapSolver ────────────────────────────────────────────────────────────
  console.log('\n── CAPTCHA Solving ────────────────────────────────────────');
  console.log('Some opt-out forms have CAPTCHAs. CapSolver (capsolver.com)');
  console.log('solves them automatically for ~$0.001 each - pennies per month.');
  console.log('Sign up free at https://capsolver.com and paste your API key below.');
  console.log('Leave blank to skip (those sites go to your manual list instead).\n');
  const capsolverKey = await ask('CapSolver API key', d.capsolverKey);

  // ── Notification ─────────────────────────────────────────────────────────
  console.log('\n── Notifications ──────────────────────────────────────────');
  const textTo = await ask('iMessage number to text results to (e.g. +15125550000)', d.textTo);
  // WP2: webhook works on any OS (ntfy.sh, Slack, Discord-style). Optional.
  const webhook = await ask('Notification webhook URL - works on any OS, optional (e.g. https://ntfy.sh/my-topic)', d.webhook);

  // ── Profile dir ──────────────────────────────────────────────────────────
  const defaultProfileDir = path.join(os.homedir(), '.config', 'auto-identity-remove');
  const profileDir = await ask('Browser profile directory', d.profileDir || defaultProfileDir);

  // ── Accounts for sites that need login ───────────────────────────────────
  console.log('\n── One-Time Account Setup ─────────────────────────────────');
  console.log('A few high-priority sites require an account to opt out.');
  console.log('Create the accounts now (one-time) and paste credentials here.');
  console.log('They will be stored locally in config.json (gitignored).\n');

  const acctSites = [
    { key: 'spokeo',       url: 'https://www.spokeo.com/signup',       label: 'Spokeo'       },
    { key: 'beenverified', url: 'https://www.beenverified.com/signup', label: 'BeenVerified' },
    { key: 'mylife',       url: 'https://www.mylife.com/signup',       label: 'MyLife'       },
  ];

  const accounts = { ...d.accounts };
  for (const site of acctSites) {
    const hasExisting = accounts[site.key]?.password;
    if (hasExisting) {
      const update = await confirm(`  ${site.label} - account already stored. Update?`);
      if (!update) continue;
    } else {
      const doSetup = await confirm(`  Set up ${site.label} account? (${site.url})`);
      if (!doSetup) {
        accounts[site.key] = { email: email, password: '' };
        continue;
      }
      console.log(`  → Opening ${site.url} in your browser…`);
      try { execSync(`open "${site.url}"`); } catch(_) {}
      console.log('  Create the account, then come back here.\n');
      await ask('  Press Enter when done');
    }
    const acctEmail = await ask(`  ${site.label} login email`, email);
    const acctPass  = await ask(`  ${site.label} password`);
    accounts[site.key] = { email: acctEmail, password: acctPass };
    console.log(`  ✓ ${site.label} credentials saved.\n`);
  }

  // ── Build config ─────────────────────────────────────────────────────────
  // buildConfig keeps every key this wizard does not ask about (persons[1..],
  // email.smtp, relay, hibp, allowlist, notify.emailReportTo ...).
  const config = buildConfig(existing, {
    firstName, lastName, aliases, city, country, state, zip, email, phone,
    capsolverKey, textTo, webhook, profileDir, accounts,
  });

  // Atomic and always 0600: config.json holds the legal name, home address,
  // phone, DOB, the SMTP password and every API key. A plain writeFileSync `mode`
  // only applies when the file is created, so an existing 0644 file stayed 0644.
  saveConfig(config);
  console.log(`\n✅ ${CONFIG_PATH} saved.\n`);

  // -- At-rest encryption ------------------------------------------------------
  //
  // If the install was already encrypted, re-encrypt without asking. Leaving the
  // freshly written plaintext config.json in place would silently downgrade a
  // user who had deliberately turned encryption on, and loadConfig() would keep
  // reading the stale .enc so the edit above would not take effect either.
  if (prior.encrypted && !prior.locked) {
    const encResult = maybeEncryptConfig({ passphrase: getPassphrase() });
    if (encResult.encrypted) {
      console.log(encResult.shredded
        ? `🔒 Re-encrypted to ${encResult.encPath}; plaintext shredded.\n`
        : `🔒 Re-encrypted to ${encResult.encPath}.\n⚠  ${encResult.notice}\n`);
    } else {
      console.error('⚠  Could not re-encrypt the config. config.json is currently PLAINTEXT.');
      console.error('   Fix it now with: AIDR_PASSPHRASE=... node watcher.js --encrypt-config\n');
    }
  } else {
    console.log('-- Encrypt config at rest? ----------------------------------------');
    console.log('Your config holds PII, the CapSolver key, and (optionally) an SMTP');
    console.log('password. You can encrypt it with AES-256-GCM. You will then need to');
    console.log('set AIDR_PASSPHRASE in the environment when running the watcher.\n');
    const doEncrypt = await confirm('Encrypt config.json now?');
    if (doEncrypt) {
      // Typed twice and compared before anything is encrypted: a mistyped
      // passphrase would make the config unrecoverable.
      const passphrase = await askNewPassphrase({ read: askSecret });
      if (passphrase) {
        const encResult = maybeEncryptConfig({ passphrase });
        if (encResult.encrypted) {
          console.log(encResult.shredded
            ? `\nconfig encrypted to ${encResult.encPath}; plaintext shredded.`
            : `\nconfig encrypted to ${encResult.encPath}.\n⚠  ${encResult.notice}`);
          console.log('   Run the watcher with: AIDR_PASSPHRASE=... node watcher.js\n');
        }
      } else {
        console.log('  No passphrase entered - leaving config in plaintext.\n');
      }
    }
  }

  // Initialize state.json if not present
  if (!fs.existsSync(STATE_PATH)) {
    // The state may live in a directory the config did not (AIDR_STATE_PATH elsewhere).
    // Only a directory that is missing is created (owner-only); one that exists is not ours to chmod.
    if (!fs.existsSync(path.dirname(STATE_PATH))) mkdirPrivate(path.dirname(STATE_PATH));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ optOuts: {}, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log('✅ state.json initialized (tracks opt-out history).\n');
  }

  // ── Cross-platform scheduling ─────────────────────────────────────────────
  const schedule = await runScheduleStep({ confirm });

  close();

  console.log('─'.repeat(54));
  if (schedule.failed) {
    // Exit non-zero too: a script running setup must not read this as a clean finish.
    process.exitCode = 1;
    console.log('⚠️  Setup finished, but the monthly schedule is NOT installed (see above).');
    console.log('   Fix that, then run: aidr schedule install\n');
  } else {
    console.log('✅ Setup complete!\n');
  }
  console.log('  Run now:      node watcher.js');
  console.log('  Manual run:   ./run.sh');
  console.log('  Check state:  cat state.json\n');
  console.log('Your personal info lives only in config.json (gitignored).');
  console.log('─'.repeat(54) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Setup error:', err.message);
    process.exit(1);
  });
}
