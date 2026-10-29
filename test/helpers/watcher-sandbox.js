/**
 * test/helpers/watcher-sandbox.js - run the real watcher.js as a child process
 * without it being able to touch anything of the developer's.
 *
 * A sandbox is a temp directory holding:
 *   repo/    a copy of watcher.js, generic-runner.js, brokers.js, lib/ and data/,
 *            so logs/, the audit files and data/*.json land in the temp dir
 *   home/    config.json and state.json (AIDR_CONFIG_PATH / AIDR_STATE_PATH)
 *   bin/     stubs for osascript, notify-send and powershell that only record
 *            their arguments, so a desktop notification or an iMessage can be
 *            asserted on instead of actually shown or sent
 *
 * Every child gets:
 *   - NODE_OPTIONS=--require fake-playwright.js : no real browser can start
 *   - PATH with the stubs first                 : no real notification can fire
 *   - AIDR_STATE_PATH / AIDR_CONFIG_PATH / AIDR_CONFIG_ENC_PATH pointing into the
 *     sandbox, and a HOME inside it
 * and is killed by PROCESS GROUP on timeout, so a stuck run cannot leave
 * orphans behind.
 *
 * Not a test file (no .test.js suffix).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const FAKE_PLAYWRIGHT = path.join(__dirname, 'fake-playwright.js');

const COPIED_FILES = ['watcher.js', 'generic-runner.js', 'brokers.js', 'config.example.json', 'package.json'];
const COPIED_DIRS = ['lib', 'data'];

const NOTIFIERS = ['osascript', 'notify-send', 'powershell'];

/** A config that passes validateRunnableConfig: nothing here is a placeholder. */
function runnableConfig(overrides = {}) {
  return {
    allowlist: [],
    persons: [
      { firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', city: 'Austin', state: 'TX', zip: '78701', country: 'US', email: 'ada@lovelace-test.example', phone: '5125550101', phoneFormatted: '(512) 555-0101' },
      { firstName: 'Alan', lastName: 'Turing', fullName: 'Alan Turing', city: 'Denver', state: 'CO', zip: '80201', country: 'US', email: 'alan@turing-test.example', phone: '3035550102', phoneFormatted: '(303) 555-0102' },
    ],
    notify: { textTo: '' },
    ...overrides,
  };
}

function stubNotifiers(binDir, logFile) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of NOTIFIERS) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${logFile}"\n`, { mode: 0o755 });
  }
}

/**
 * @param {{ config?: object|null, state?: object|null, copyRepo?: boolean }} [options]
 *   config null leaves no config file; copyRepo false runs the repo's own
 *   watcher.js (only for modes that write nothing next to it).
 */
function createSandbox(options = {}) {
  const { config = runnableConfig(), state = { optOuts: {} }, copyRepo = true } = options;

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-sandbox-')));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  let repo = REPO;
  if (copyRepo) {
    repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    for (const file of COPIED_FILES) fs.copyFileSync(path.join(REPO, file), path.join(repo, file));
    for (const sub of COPIED_DIRS) fs.cpSync(path.join(REPO, sub), path.join(repo, sub), { recursive: true });
  }

  // Runtime files a developer's checkout may carry: the sandbox starts without them.
  if (copyRepo) {
    for (const name of ['exposure-history.json', 'exposure-history.json.bak', 'serp-history.json', 'breach-result.json']) {
      fs.rmSync(path.join(repo, 'data', name), { force: true });
    }
  }

  const paths = {
    dir,
    repo,
    home,
    config: path.join(home, 'config.json'),
    configEnc: path.join(home, 'config.json.enc'),
    state: path.join(home, 'state.json'),
    lock: path.join(home, 'state.json.lock'),
    fakeLog: path.join(dir, 'fake-browser.log'),
    notifications: path.join(dir, 'notifications.log'),
    logs: path.join(repo, 'logs'),
  };
  stubNotifiers(bin, paths.notifications);

  if (config !== null) fs.writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (state !== null) fs.writeFileSync(paths.state, JSON.stringify(state, null, 2), { mode: 0o600 });

  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${FAKE_PLAYWRIGHT}`].filter(Boolean).join(' '),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    AIDR_CONFIG_PATH: paths.config,
    AIDR_CONFIG_ENC_PATH: paths.configEnc,
    AIDR_STATE_PATH: paths.state,
    AIDR_FAKE_LOG: paths.fakeLog,
    HEADLESS: '1',
    CI: '1',
    TURBO: '1',
    // Nothing a test runs may read a passphrase or a relay key from the developer's shell.
    AIDR_PASSPHRASE: '',
    AIDR_PASSPHRASE_FILE: '',
    // A fake that is bypassed would still find no browser here.
    PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'no-browsers'),
  };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;

  return {
    ...paths,
    env,
    readState: () => JSON.parse(fs.readFileSync(paths.state, 'utf8')),
    fakeEvents: () => readLines(paths.fakeLog).map(line => JSON.parse(line)),
    notificationCalls: () => readLines(paths.notifications),
    // Lookups, fetches and navigations the run attempted (all refused by the fake).
    networkAttempts: () => readLines(paths.fakeLog).map(line => JSON.parse(line)).filter(e => ['dns', 'fetch', 'goto'].includes(e.event)),
    runLogs: () => (fs.existsSync(paths.logs) ? fs.readdirSync(paths.logs).filter(f => /^run-.*\.json$/.test(f)) : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Run `node watcher.js ...args` in the sandbox.
 *
 * @param {ReturnType<typeof createSandbox>} sandbox
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: object, signalWhen?: { match: RegExp, signal: string } }} [opts]
 *   signalWhen sends `signal` to the child once its output matches.
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runWatcher(sandbox, args, opts = {}) {
  const { timeoutMs = 60000, env = {}, signalWhen } = opts;

  return new Promise((resolve, reject) => {
    // detached: the child leads its own process group, so one kill reaches
    // anything it spawned too.
    const child = spawn(process.execPath, [path.join(sandbox.repo, 'watcher.js'), ...args], {
      cwd: sandbox.repo,
      env: { ...sandbox.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let signalled = false;

    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch (_) { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutMs);

    const onOutput = (chunk) => {
      if (!signalWhen || signalled) return;
      if (signalWhen.match.test(stdout + stderr)) {
        signalled = true;
        // Signal the child itself, as `docker stop` or a scheduler does.
        try { process.kill(child.pid, signalWhen.signal); } catch (_) { /* already gone */ }
      }
    };

    child.stdout.on('data', (chunk) => { stdout += chunk; onOutput(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; onOutput(); });
    child.on('error', (err) => { clearTimeout(timer); killGroup('SIGKILL'); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      killGroup('SIGKILL'); // sweep anything that outlived the child
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

module.exports = { createSandbox, runWatcher, runnableConfig, REPO };
