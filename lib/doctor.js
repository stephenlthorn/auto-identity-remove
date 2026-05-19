'use strict';
/**
 * lib/doctor.js
 *
 * Self-diagnose command. Called via `node watcher.js doctor` or `--doctor`.
 *
 * Each check is an async function returning `{ ok, hint }`.
 * Skipped checks use `ok: true` with a hint that says "skipped — not configured".
 *
 * `runDoctor(opts)` accepts optional dependency-injection overrides so the
 * module is fully testable without real filesystem/network I/O.
 */

const path = require('path');
const fs   = require('fs');
const net  = require('net');
const https = require('https');

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
 * Check 1: config.json exists, parses, and has the four required person fields.
 *
 * @param {string} rootDir  Project root (injectable for tests).
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkConfig(rootDir) {
  const cfgPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, hint: 'config.json not found — run `node setup.js`' };
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return { ok: false, hint: `config.json failed to parse: ${e.message}` };
  }

  if (!cfg.person || typeof cfg.person !== 'object') {
    return { ok: false, hint: 'config.json missing person section' };
  }

  const required = ['firstName', 'lastName', 'email', 'zip'];
  for (const field of required) {
    if (!cfg.person[field]) {
      return { ok: false, hint: `config.json missing person.${field}` };
    }
  }

  return { ok: true, hint: 'config.json valid, person fields present' };
}

/**
 * Check 2: Playwright can be required and the Chromium binary exists.
 *
 * Accepts an opts object for dependency injection in tests:
 *   opts.requirePlaywright — function that returns the playwright module
 *   opts.fsExists          — function(path) => boolean
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
    return { ok: false, hint: `playwright not installed — run \`npx playwright install chromium\`: ${e.message}` };
  }

  let binPath;
  try {
    binPath = pw.chromium.executablePath();
  } catch (e) {
    return { ok: false, hint: `Could not resolve chromium path: ${e.message}` };
  }

  if (!fsExists(binPath)) {
    return { ok: false, hint: `chromium binary not found — run \`npx playwright install chromium\` (expected: ${binPath})` };
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
    return { ok: true, hint: 'skipped — not configured' };
  }

  const tcpProbe = opts.tcpProbe || defaultTcpProbe;

  try {
    await tcpProbe(host, port);
    return { ok: true, hint: `${host}:${port} reachable` };
  } catch (e) {
    return { ok: false, hint: `${host}:${port} unreachable — ${e.message}` };
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
    return { ok: true, hint: 'skipped — not configured' };
  }

  if (apiKey === 'CAP-YOUR_KEY_HERE') {
    return { ok: true, hint: 'skipped — placeholder key detected; set your real key at capsolver.com' };
  }

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest('https://api.capsolver.com/');
    return { ok: true, hint: 'api.capsolver.com reachable' };
  } catch (e) {
    return { ok: false, hint: `api.capsolver.com unreachable — ${e.message}` };
  }
}

/**
 * Check 5: state.json is absent or parses as valid JSON with an optOuts object.
 *
 * @param {string} rootDir
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkState(rootDir) {
  const statePath = path.join(rootDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    return { ok: true, hint: 'state.json absent (fresh install)' };
  }

  let st;
  try {
    st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { ok: false, hint: `state.json failed to parse: ${e.message}` };
  }

  if (!st.optOuts || typeof st.optOuts !== 'object' || Array.isArray(st.optOuts)) {
    return { ok: false, hint: 'state.json missing or invalid optOuts field' };
  }

  const count = Object.keys(st.optOuts).length;
  return { ok: true, hint: `state.json parseable (${count} ${count === 1 ? 'entry' : 'entries'})` };
}

/**
 * Check 6: Webhook URL responds (if configured).
 *
 * @param {object} cfg
 * @param {{ headRequest?: (url: string) => Promise<number> }} [opts]
 * @returns {{ ok: boolean, hint: string }}
 */
async function checkWebhook(cfg, opts = {}) {
  const url = cfg?.notify?.webhook;

  if (!url) {
    return { ok: true, hint: 'skipped — not configured' };
  }

  const headRequest = opts.headRequest || defaultHeadRequest;

  try {
    await headRequest(url);
    return { ok: true, hint: `webhook ${url} reachable` };
  } catch (e) {
    return { ok: false, hint: `webhook ${url} unreachable — ${e.message}` };
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
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
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
 * @param {string}  [opts.rootDir]           Project root (default: cwd/../ from this file)
 * @param {boolean} [opts.printOutput]       Set false to suppress console output (for tests)
 * @param {Function} [opts.requirePlaywright]  DI override
 * @param {Function} [opts.fsExists]           DI override
 * @param {Function} [opts.tcpProbe]           DI override
 * @param {Function} [opts.headRequest]        DI override
 *
 * @returns {Promise<Array<{name: string, ok: boolean, hint: string}> & { exitCode: number, summary: object }>}
 */
async function runDoctor(opts = {}) {
  const rootDir = opts.rootDir || path.join(__dirname, '..');
  const print   = opts.printOutput !== false;

  if (print) {
    console.log(`\n${c.bold('🩺 doctor')} — running 6 checks…`);
  }

  // Load config for checks that need it (best-effort; checkConfig handles missing)
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  } catch (_) { /* handled by checkConfig */ }

  const pwOpts = {
    requirePlaywright: opts.requirePlaywright,
    fsExists:          opts.fsExists,
  };
  const netOpts = {
    tcpProbe:    opts.tcpProbe,
    headRequest: opts.headRequest,
  };

  const checks = [
    { name: 'config',     run: () => checkConfig(rootDir) },
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
