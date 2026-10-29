'use strict';

/**
 * lib/args.js
 *
 * Strict command-line parsing for watcher.js (CORE-6).
 *
 * watcher.js used to read each flag with `process.argv.includes('--x')`, so a
 * typo such as `--dryrun` was silently ignored and started a REAL submission
 * run that sends the user's name, address and phone to ~540 sites. This parser
 * knows every flag watcher.js reads and treats an unknown flag, a missing
 * value, a switch given a value or a stray positional as an error, naming the
 * closest known flag.
 *
 * It is built on util.parseArgs when the running Node has it (>= 18.3). Node
 * 18.0-18.2 do not, and the repo supports >= 18.0, so a small hand-written
 * tokenizer produces the same raw result there. Both feed one normaliser, so
 * the rules below hold on every supported Node.
 *
 * Exports:
 *   parseWatcherArgs(argv, opts)       - argv WITHOUT node/script, returns the flag object (throws ArgError)
 *   parseWatcherArgsOrExit(argv, io)   - same, but prints and exits for --help and for a bad command line
 *   buildWatcherUsage()                - the --help text
 *   suggestFlag(input, candidates)     - closest known flag or null
 *   ArgError, KNOWN_FLAGS, FLAG_SPECS
 */

const util = require('util');

// Single source of truth: one row per flag. kind 'boolean' is a switch,
// 'string' takes a value, 'number' takes a whole-number value.
const FLAG_SPECS = [
  // Run modifiers
  { flag: '--dry-run',           key: 'dryRun',           kind: 'boolean', desc: 'Fill forms but submit nothing and save no state' },
  { flag: '--preview',           key: 'preview',          kind: 'boolean', desc: 'Like --dry-run, and print every field value and target URL before each submit' },
  { flag: '--only',              key: 'only',             kind: 'string',  desc: 'Run only these brokers (comma-separated names)', arg: '<names>' },
  { flag: '--skip',              key: 'skip',             kind: 'string',  desc: 'Run everything except these brokers (comma-separated names)', arg: '<names>' },
  { flag: '--retry-failed',      key: 'retryFailed',      kind: 'boolean', desc: 'Re-run only brokers that errored, hit a CAPTCHA or await confirmation last run' },
  { flag: '--resume',            key: 'resume',           kind: 'boolean', desc: 'Resume an interrupted run from its checkpoint' },
  { flag: '--snapshot',          key: 'snapshot',         kind: 'boolean', desc: 'Save a screenshot of each broker listing' },
  { flag: '--no-capsolver',      key: 'noCapsolver',      kind: 'boolean', desc: 'Never call the paid CAPTCHA solver' },
  { flag: '--pollute',           key: 'pollute',          kind: 'number',  desc: 'Submit N bogus noise records to brokers that accept them', arg: '<n>' },
  // Modes
  { flag: '--verify',            key: 'verify',           kind: 'boolean', desc: 'Re-search brokers and report whether you still appear' },
  { flag: '--list',              key: 'list',             kind: 'boolean', desc: 'List configured brokers and their last-known status' },
  { flag: '--score',             key: 'score',            kind: 'boolean', desc: 'Print your exposure score and its trend' },
  { flag: '--pending',           key: 'pending',          kind: 'boolean', desc: 'List brokers awaiting an email-confirmation click' },
  { flag: '--report',            key: 'report',           kind: 'boolean', desc: 'Generate the monthly PDF and email report' },
  { flag: '--doctor',            key: 'doctor',           kind: 'boolean', desc: 'Self-diagnose environment and configuration' },
  { flag: '--update-brokers',    key: 'updateBrokers',    kind: 'boolean', desc: 'Refresh the broker list from the CA and Vermont registries' },
  { flag: '--breach-check',      key: 'breachCheck',      kind: 'boolean', desc: 'Check Have I Been Pwned for breaches' },
  { flag: '--serp-scan',         key: 'serpScan',         kind: 'boolean', desc: 'Scan search engines for where your name still ranks' },
  { flag: '--serp-watch',        key: 'serpWatch',        kind: 'boolean', desc: 'Scan and alert when your name appears on a NEW domain' },
  { flag: '--know',              key: 'know',             kind: 'boolean', desc: 'Send CCPA/GDPR right-to-know requests' },
  { flag: '--know-status',       key: 'knowStatus',       kind: 'boolean', desc: 'Show the status of right-to-know requests' },
  { flag: '--complaints',        key: 'complaints',       kind: 'boolean', desc: 'Generate regulator complaints for brokers past the legal deadline' },
  { flag: '--confirm-emails',    key: 'confirmEmails',    kind: 'boolean', desc: 'Click confirmation links in saved .eml files (optional directory argument)', arg: '[dir]' },
  { flag: '--install-scheduler', key: 'installScheduler', kind: 'boolean', desc: 'Register the monthly job with the OS scheduler' },
  // Credit freezes
  { flag: '--freeze',            key: 'freeze',           kind: 'boolean', desc: 'Show the credit/identity freeze checklist' },
  { flag: '--freeze-done',       key: 'freezeDone',       kind: 'string',  desc: 'Mark a freeze target done', arg: '<key>' },
  { flag: '--freeze-clear',      key: 'freezeClear',      kind: 'string',  desc: 'Undo a freeze mark', arg: '<key>' },
  // Allowlist
  { flag: '--allow',             key: 'allow',            kind: 'string',  desc: 'Keep this broker listed: never opt out of it', arg: '<name>' },
  { flag: '--unallow',           key: 'unallow',          kind: 'string',  desc: 'Remove a broker from the allowlist', arg: '<name>' },
  // Config encryption
  { flag: '--encrypt-config',    key: 'encryptConfig',    kind: 'boolean', desc: 'Encrypt config.json with AIDR_PASSPHRASE' },
  { flag: '--decrypt-config',    key: 'decryptConfig',    kind: 'boolean', desc: 'Decrypt config.json.enc back to plaintext' },
  { flag: '--keep-plaintext',    key: 'keepPlaintext',    kind: 'boolean', desc: 'With --encrypt-config: keep the plaintext config.json' },
  // Help
  { flag: '--help',              key: 'help',             kind: 'boolean', desc: 'Show this help (also -h)', short: '-h' },
];

const SPEC_BY_FLAG = new Map(FLAG_SPECS.map(s => [s.flag, s]));
const KNOWN_FLAGS = new Set([...FLAG_SPECS.map(s => s.flag), '-h']);
const DEFAULT_CONFIRM_DIR = './inbox/confirms';

class ArgError extends Error {
  /**
   * @param {string} message
   * @param {{ flag?: string, suggestion?: string|null }} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ArgError';
    this.code = 'AIDR_ARGS';
    this.flag = detail.flag;
    this.suggestion = detail.suggestion || null;
  }
}

// ─── did-you-mean ─────────────────────────────────────────────────────────────

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/**
 * Closest known flag to a mistyped one, or null when nothing is plausibly meant.
 * A prefix (`--dry` for `--dry-run`) counts, as does a small edit distance.
 *
 * @param {string} input
 * @param {Iterable<string>} candidates
 * @returns {string|null}
 */
function suggestFlag(input, candidates) {
  const bare = String(input).toLowerCase().replace(/^-+/, '');
  if (!bare) return null;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === '-h') continue;
    const target = candidate.replace(/^-+/, '');
    let score = editDistance(bare, target);
    if (bare.length >= 3 && target.startsWith(bare)) score = Math.min(score, 1);
    const limit = Math.max(2, Math.floor(target.length / 4));
    if (score <= limit && score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function unknownFlagError(token) {
  const name = token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  const suggestion = suggestFlag(name, KNOWN_FLAGS);
  return new ArgError(
    `unknown option "${name}"${suggestion ? ` - did you mean "${suggestion}"?` : ''}`,
    { flag: name, suggestion },
  );
}

function missingValueError(flag, got) {
  const spec = SPEC_BY_FLAG.get(flag);
  const hint = spec && spec.arg ? ` ${spec.arg}` : ' <value>';
  const found = got ? ` (got "${got}")` : '';
  return new ArgError(`${flag} needs a value: ${flag}${hint}${found}`, { flag });
}

function switchWithValueError(flag) {
  return new ArgError(`${flag} is a switch and does not take a value`, { flag });
}

// ─── raw tokenizers (identical result shape) ──────────────────────────────────
//
// Both return { switches: Set<longFlag>, values: { longFlag: string[] }, positionals: string[] }.

const BOOLEAN_FLAGS = new Set(FLAG_SPECS.filter(s => s.kind === 'boolean').map(s => s.flag));
const VALUE_FLAGS = new Set(FLAG_SPECS.filter(s => s.kind !== 'boolean').map(s => s.flag));

function rawByHand(argv) {
  const switches = new Set();
  const values = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);

    if (token === '--') {
      positionals.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (token === '-h') {
      switches.add('--help');
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) throw unknownFlagError(token);

    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw switchWithValueError(name);
      switches.add(name);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) {
        if (i + 1 >= argv.length) throw missingValueError(name);
        value = String(argv[++i]);
      }
      (values[name] = values[name] || []).push(value);
      continue;
    }
    throw unknownFlagError(token);
  }

  return { switches, values, positionals };
}

function translateUtilError(err) {
  const named = String(err && err.message).match(/'(--?[A-Za-z0-9-]+)/);
  const flag = named ? named[1] : '';
  if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return unknownFlagError(flag || String(err.message));
  if (err && err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    return /does not take an argument/i.test(err.message) ? switchWithValueError(flag) : missingValueError(flag);
  }
  return new ArgError(String(err && err.message));
}

function rawWithUtil(argv) {
  const options = {};
  for (const flag of BOOLEAN_FLAGS) options[flag.slice(2)] = { type: 'boolean' };
  for (const flag of VALUE_FLAGS) options[flag.slice(2)] = { type: 'string', multiple: true };
  options.help = { type: 'boolean', short: 'h' };

  let parsed;
  try {
    parsed = util.parseArgs({ args: argv.map(String), options, strict: true, allowPositionals: true });
  } catch (err) {
    throw translateUtilError(err);
  }

  const switches = new Set();
  const values = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    const flag = `--${name}`;
    if (VALUE_FLAGS.has(flag)) values[flag] = value;
    else if (value) switches.add(flag);
  }
  return { switches, values, positionals: parsed.positionals };
}

// ─── normaliser ───────────────────────────────────────────────────────────────

function emptyResult() {
  const result = {};
  for (const spec of FLAG_SPECS) {
    if (spec.kind === 'boolean') result[spec.key] = false;
    else if (spec.kind === 'number') result[spec.key] = 0;
    else result[spec.key] = null;
  }
  result.confirmEmailsDir = DEFAULT_CONFIRM_DIR;
  result.freezeMode = false;
  return result;
}

function normalise(raw, argv) {
  const result = emptyResult();

  for (const flag of raw.switches) result[SPEC_BY_FLAG.get(flag).key] = true;

  for (const [flag, list] of Object.entries(raw.values)) {
    const spec = SPEC_BY_FLAG.get(flag);
    if (list.length > 1) {
      throw new ArgError(`${flag} was given more than once; pass it once (use a comma-separated list for several names)`, { flag });
    }
    const value = list[0];
    // A value that is empty or starts with "-" is a forgotten argument, not a name:
    // `--only --skip X` must not run a broker called "--skip".
    if (value === '' || value.startsWith('-')) throw missingValueError(flag, value);
    if (spec.kind === 'number') {
      if (!/^\d+$/.test(value)) throw new ArgError(`${flag} expects a whole number, got "${value}"`, { flag });
      result[spec.key] = parseInt(value, 10);
    } else {
      result[spec.key] = value;
    }
  }

  const rest = [...raw.positionals];
  // `node watcher.js doctor` has always meant --doctor; only as the first token.
  if (String(argv[0]) === 'doctor' && rest[0] === 'doctor') {
    result.doctor = true;
    rest.shift();
  }
  if (result.confirmEmails && rest.length === 1) {
    result.confirmEmailsDir = rest.shift();
  }
  if (rest.length > 0) {
    throw new ArgError(`unexpected argument "${rest[0]}" - flags start with "--" (see --help)`, { flag: rest[0] });
  }

  result.dryRun = result.dryRun || result.preview;
  result.freezeMode = result.freeze || result.freezeDone !== null || result.freezeClear !== null;
  return result;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Parse watcher.js arguments strictly.
 *
 * @param {string[]} argv  arguments after the script name (process.argv.slice(2))
 * @param {{ parser?: 'auto'|'util'|'manual' }} [opts]  force a tokenizer (tests)
 * @returns {object} camelCase flag object: booleans default false, value flags
 *   default null, pollute defaults 0, confirmEmailsDir defaults './inbox/confirms';
 *   dryRun is true for --dry-run or --preview; freezeMode is true for any freeze flag.
 *   Key names match lib/mode-dispatch.resolveMode, so it can be passed straight in.
 * @throws {ArgError} (code 'AIDR_ARGS') on an unknown flag, missing value or stray argument
 */
function parseWatcherArgs(argv = [], opts = {}) {
  const list = Array.isArray(argv) ? argv : [];
  const wanted = opts.parser || 'auto';
  const useUtil = wanted === 'util' || (wanted === 'auto' && typeof util.parseArgs === 'function');
  if (wanted === 'util' && typeof util.parseArgs !== 'function') {
    throw new Error('util.parseArgs is not available on this Node');
  }
  return normalise(useUtil ? rawWithUtil(list) : rawByHand(list), list);
}

function buildWatcherUsage() {
  const lines = ['Usage: node watcher.js [options]', '', 'Options:'];
  const labels = FLAG_SPECS.map(s => `${s.flag}${s.arg ? ` ${s.arg}` : ''}${s.short ? `, ${s.short}` : ''}`);
  const width = Math.max(...labels.map(l => l.length));
  FLAG_SPECS.forEach((spec, i) => lines.push(`  ${labels[i].padEnd(width)}  ${spec.desc}`));
  lines.push('');
  lines.push('Unknown options are an error: nothing runs if a flag is misspelt.');
  return lines.join('\n') + '\n';
}

/**
 * parseWatcherArgs for an entry point: prints --help and exits 0, or prints the
 * error and exits 2 BEFORE anything runs. Returns null when it has exited (only
 * observable with an injected exit).
 *
 * @param {string[]} [argv]
 * @param {{ stdout?: {write: Function}, stderr?: {write: Function}, exit?: (code: number) => void }} [io]
 */
function parseWatcherArgsOrExit(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const exit = io.exit || (code => process.exit(code));

  let parsed;
  try {
    parsed = parseWatcherArgs(argv);
  } catch (err) {
    if (!(err instanceof ArgError)) throw err;
    stderr.write(`aidr: ${err.message}\nRun with --help to see the available options. Nothing was run.\n`);
    exit(2);
    return null;
  }

  if (parsed.help) {
    stdout.write(buildWatcherUsage());
    exit(0);
    return null;
  }
  return parsed;
}

module.exports = {
  parseWatcherArgs,
  parseWatcherArgsOrExit,
  buildWatcherUsage,
  suggestFlag,
  ArgError,
  KNOWN_FLAGS,
  FLAG_SPECS,
};
