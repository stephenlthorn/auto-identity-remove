'use strict';
/**
 * lib/doctor.js
 *
 * Self-diagnose command. Called via `node watcher.js doctor` or `--doctor`.
 *
 * Each check is an async function returning `{ ok, hint }`.
 * Skipped checks use `ok: true` with a hint that says "skipped - not configured".
 *
 * `runDoctor(opts)` accepts optional dependency-injection overrides so the
 * module is fully testable without real filesystem/network I/O.
 */

const path = require('path');
const fs   = require('fs');
const net  = require('net');
const http = require('http');
const https = require('https');
const { isPlaceholderKey } = require('./captcha');
const {
  loadConfig, isConfigEncrypted, validateRunnableConfig, getStatePath,
  CONFIG_PATH, CONFIG_ENC_PATH,
} = require('./config');

// ── ANSI colour helpers (stripped when not a TTY) ────────────────────────────

const isTTY = process.stdout.isTTY;
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
};

// ── Individual check functions ───────────────────────────────────────────────

/**
 * Where doctor looks for the config. An explicit rootDir (tests, or a caller that
 * knows better) means <rootDir>/config.json[.enc]; with none, the same paths the
 * watcher uses, including the AIDR_CONFIG_PATH / AIDR_CONFIG_ENC_PATH overrides.
 */
function resolveConfigPaths(rootDir, opts = {}) {
  return {
    configPath: opts.configPath || (rootDir ? path.join(rootDir, 'config.json') : CONFIG_PATH),
    encPath:    opts.encPath    || (rootDir ? path.join(rootDir, 'config.json.enc') : CONFIG_ENC_PATH),
  };
}

/**
 * Load the config the way the watcher does (plaintext, config.json.enc, or an
 * in-place envelope; passphrase from opts, AIDR_PASSPHRASE or
 * AIDR_PASSPHRASE_FILE) without ever calling process.exit.
 *
 * @returns {{ status: 'absent'|'ok'|'error', cfg?: object, encrypted?: boolean, hint?: string }}
 */
function loadDoctorConfig(rootDir, opts = {}) {
  const paths = resolveConfigPaths(rootDir, opts);
  if (!fs.existsSync(paths.encPath) && !fs.existsSync(paths.configPath)) {
    return { status: 'absent', hint: 'config.json not found - run `node setup.js`' };
  }
  try {
    const cfg = loadConfig({ ...paths, passphrase: opts.passphrase, _warn: () => {} });
    return { status: 'ok', cfg, encrypted: isConfigEncrypted(paths) };
  } catch (e) {
    const hint = e instanceof SyntaxError
      ? `config.json failed to parse: ${e.message}`
      : `config could not be loaded: ${e.message}`;
    return { status: 'error', hint };
  }
}

/**
 * Check 1: the config exists (plaintext or encrypted), loads, and has the four
 * required person fields, none of them still a config.example.json placeholder.
 *
 * @param {string} [rootDir]  Project root (injectable for tests); omit for the real paths.
 * @param {{ passphrase?: string, configPath?: string, encPath?: string }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkConfig(rootDir, opts = {}) {
  const loaded = loadDoctorConfig(rootDir, opts);
  if (loaded.status !== 'ok') return { ok: false, hint: loaded.hint };
  const cfg = loaded.cfg;

  // Accept either the single-person "person" key or the multi-person
  // "persons" array, matching the precedence in lib/config.js
  // getPersonsFromConfig() (persons wins when both are present).
  let persons;
  if (cfg.persons !== undefined) {
    if (!Array.isArray(cfg.persons) || cfg.persons.length === 0) {
      return { ok: false, hint: 'config.json: persons must be a non-empty array' };
    }
    persons = cfg.persons;
  } else if (cfg.person && typeof cfg.person === 'object') {
    persons = [cfg.person];
  } else {
    return { ok: false, hint: 'config.json missing person section' };
  }

  const required = ['firstName', 'lastName', 'email', 'zip'];
  for (let i = 0; i < persons.length; i++) {
    const label = persons.length > 1 ? `persons[${i}]` : 'person';
    if (!persons[i] || typeof persons[i] !== 'object') {
      return { ok: false, hint: `config.json: ${label} is not an object` };
    }
    for (const field of required) {
      if (!persons[i][field]) {
        return { ok: false, hint: `config.json missing ${label}.${field}` };
      }
    }
  }

  // Same gate the watcher applies before a run: a copied-but-unedited example
  // config parses fine and would run as "Jane Doe".
  const problems = validateRunnableConfig(cfg);
  if (problems.length > 0) {
    return { ok: false, hint: `config.json is not runnable: ${problems.join('; ')}` };
  }

  return { ok: true, hint: `config.json valid, person fields present${loaded.encrypted ? ' (encrypted)' : ''}` };
}

/**
 * Check 2: Playwright can be required and the Chromium binary exists.
 *
 * Accepts an opts object for dependency injection in tests:
 *   opts.requirePlaywright - function that returns the playwright module
 *   opts.fsExists          - function(path) => boolean
 *
 * @param {{ requirePlaywright?: () => any, fsExists?: (p: string) => boolean }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkPlaywright(opts = {}) {
  const requirePlaywright = opts.requirePlaywright || (() => require('playwright'));
  const fsExists          = opts.fsExists          || ((p) => fs.existsSync(p));

  let pw;
  try {
    pw = requirePlaywright();
  } catch (e) {
    return { ok: false, hint: `playwright not installed - run \`npx playwright install chromium\`: ${e.message}` };
  }

  let binPath;
  try {
    binPath = pw.chromium.executablePath();
  } catch (e) {
    return { ok: false, hint: `Could not resolve chromium path: ${e.message}` };
  }

  if (!fsExists(binPath)) {
    return { ok: false, hint: `chromium binary not found - run \`npx playwright install chromium\` (expected: ${binPath})` };
  }

  return { ok: true, hint: `chromium installed at ${binPath}` };
}

/**
 * Check 3: SMTP host is reachable via TCP (if configured).
 *
 * @param {object} cfg  Parsed config object.
 * @param {{ tcpProbe?: (host: string, port: number) => Promise<boolean> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkSMTP(cfg, opts = {}) {
  const host = cfg?.email?.smtp?.host;
  const port = cfg?.email?.smtp?.port || 587;

  if (!host) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  const tcpProbe = opts.tcpProbe || defaultTcpProbe;

  try {
    await tcpProbe(host, port);
    return { ok: true, hint: `${host}:${port} reachable` };
  } catch (e) {
    return { ok: false, hint: `${host}:${port} unreachable - ${e.message}` };
  }
}

/**
 * Check 4: CapSolver API key is set and the API endpoint is reachable.
 *
 * @param {object} cfg
 * @param {{ headRequest?: (url: string) => Promise<number> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkCapsolver(cfg, opts = {}) {
  const apiKey = cfg?.capsolver?.apiKey;

  if (!apiKey) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  if (isPlaceholderKey(apiKey)) {
    return { ok: true, hint: 'skipped - placeholder key detected; set your real key at capsolver.com' };
  }

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest('https://api.capsolver.com/');
    return { ok: true, hint: 'api.capsolver.com reachable' };
  } catch (e) {
    return { ok: false, hint: `api.capsolver.com unreachable - ${e.message}` };
  }
}

/**
 * Check 5: state.json is absent or parses as valid JSON with an optOuts object.
 * Looks at the real state path (AIDR_STATE_PATH included) unless a rootDir or an
 * explicit statePath says otherwise.
 *
 * @param {string} [rootDir]
 * @param {{ statePath?: string }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkState(rootDir, opts = {}) {
  const statePath = opts.statePath || (rootDir ? path.join(rootDir, 'state.json') : getStatePath());
  const name = path.basename(statePath);

  if (!fs.existsSync(statePath)) {
    return { ok: true, hint: `${name} absent (fresh install)` };
  }

  let st;
  try {
    st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { ok: false, hint: `${name} failed to parse: ${e.message} (${statePath})` };
  }

  if (!st || !st.optOuts || typeof st.optOuts !== 'object' || Array.isArray(st.optOuts)) {
    return { ok: false, hint: `${name} missing or invalid optOuts field (${statePath})` };
  }

  const count = Object.keys(st.optOuts).length;
  return { ok: true, hint: `${name} parseable (${count} ${count === 1 ? 'entry' : 'entries'})` };
}

/**
 * Check 6: Webhook URL responds (if configured).
 *
 * The URL is the credential for Slack and ntfy, so it is never printed: the
 * hint carries scheme and host only, and the URL is scrubbed from any error text.
 *
 * @param {object} cfg
 * @param {{ headRequest?: (url: string) => Promise<number> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkWebhook(cfg, opts = {}) {
  const url = cfg?.notify?.webhook;

  if (!url) {
    return { ok: true, hint: 'skipped - not configured' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, hint: 'webhook is not a valid URL (not shown: it is a secret)' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, hint: `webhook scheme ${parsed.protocol} is not supported (use http or https)` };
  }
  const where = `${parsed.protocol}//${parsed.host}`;

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest(url);
    return { ok: true, hint: `webhook ${where} reachable${parsed.protocol === 'http:' ? ' (plain http, not encrypted)' : ''}` };
  } catch (e) {
    const msg = String(e && e.message).split(url).join('<webhook>');
    return { ok: false, hint: `webhook ${where} unreachable - ${msg}` };
  }
}

// ── Default I/O helpers (not used in tests) ──────────────────────────────────

function defaultTcpProbe(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 5000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TCP connection timed out'));
    });
  });
}

function defaultHeadRequest(url) {
  return new Promise((resolve, reject) => {
    // https.request throws on an http: URL; ntfy on a LAN is commonly plain http.
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const req = transport.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

// ── runDoctor ────────────────────────────────────────────────────────────────

/**
 * Run all checks and print a coloured summary (unless printOutput === false).
 *
 * @param {object} [opts]
 * @param {string}  [opts.rootDir]           Project root. Omit to use the real config/state paths
 *                                           (AIDR_CONFIG_PATH, AIDR_CONFIG_ENC_PATH, AIDR_STATE_PATH included)
 * @param {string}  [opts.passphrase]        Passphrase override (default: AIDR_PASSPHRASE / AIDR_PASSPHRASE_FILE)
 * @param {boolean} [opts.printOutput]       Set false to suppress console output (for tests)
 * @param {Function} [opts.requirePlaywright]  DI override
 * @param {Function} [opts.fsExists]           DI override
 * @param {Function} [opts.tcpProbe]           DI override
 * @param {Function} [opts.headRequest]        DI override
 *
 * @returns {Promise<Array<{name: string, ok: boolean, hint: string}> & { exitCode: number, summary: object }>}
 */
async function runDoctor(opts = {}) {
  const rootDir = opts.rootDir; // undefined -> the real paths, see resolveConfigPaths
  const print   = opts.printOutput !== false;

  if (print) {
    console.log(`\n${c.bold('🩺 doctor')} - running 6 checks…`);
  }

  // Load config for checks that need it (best-effort; checkConfig reports why
  // it could not be loaded).
  const loaded = loadDoctorConfig(rootDir, { passphrase: opts.passphrase });
  const cfg = loaded.status === 'ok' ? loaded.cfg : {};

  const pwOpts = {
    requirePlaywright: opts.requirePlaywright,
    fsExists:          opts.fsExists,
  };
  const netOpts = {
    tcpProbe:    opts.tcpProbe,
    headRequest: opts.headRequest,
  };

  const checks = [
    { name: 'config',     run: () => checkConfig(rootDir, { passphrase: opts.passphrase }) },
    { name: 'playwright', run: () => checkPlaywright(pwOpts) },
    { name: 'smtp',       run: () => checkSMTP(cfg, netOpts) },
    { name: 'capsolver',  run: () => checkCapsolver(cfg, netOpts) },
    { name: 'state',      run: () => checkState(rootDir) },
    { name: 'webhook',    run: () => checkWebhook(cfg, netOpts) },
  ];

  const results = [];

  for (const check of checks) {
    const result = await check.run();
    const item = { name: check.name, ok: result.ok, hint: result.hint };
    results.push(item);

    if (print) {
      const isSkip = result.ok && /skipped/i.test(result.hint);
      const icon   = isSkip ? '⚠️ ' : (result.ok ? '✅' : '❌');
      const label  = check.name.padEnd(11);
      console.log(`  ${icon} ${label} ${result.hint}`);
    }
  }

  // Tally
  const failed  = results.filter(r => !r.ok).length;
  const skipped = results.filter(r => r.ok && /skipped/i.test(r.hint)).length;
  const ok      = results.filter(r => r.ok && !/skipped/i.test(r.hint)).length;
  const summary = { ok, skipped, failed };

  if (print) {
    const parts = [];
    if (ok)      parts.push(c.green(`${ok} ok`));
    if (skipped) parts.push(c.yellow(`${skipped} skipped`));
    if (failed)  parts.push(c.red(`${failed} failed`));
    console.log(`\nResult: ${parts.join(', ')}\n`);
  }

  const exitCode = failed > 0 ? 1 : 0;

  // Attach summary and exitCode to the results array so callers can destructure
  results.exitCode = exitCode;
  results.summary  = summary;

  return results;
}

module.exports = {
  checkConfig,
  checkPlaywright,
  checkSMTP,
  checkCapsolver,
  checkState,
  checkWebhook,
  runDoctor,
};
