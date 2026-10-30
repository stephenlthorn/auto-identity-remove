/**
 * test/helpers/fake-playwright.js - a stand-in for the `playwright` package.
 *
 * Preloaded into a spawned watcher.js with NODE_OPTIONS="--require <this file>".
 * Any `require('playwright')` then resolves to a fake `chromium`, so a test can
 * drive the real orchestration end to end without a browser ever starting, and a
 * regression that reaches the browser by mistake finds a fake that refuses to
 * navigate anywhere.
 *
 * Everything the fake is asked to do is appended, one JSON object per line, to
 * the file named by AIDR_FAKE_LOG so the test can assert on it:
 *   launch, newPage, goto, addInitScript, close, dns and fetch (both refused), and `generic` (the options the
 *   watcher passes to runGenericBrokers, see spyOnGenericRunner).
 *
 * AIDR_FAKE_DNS_CODE=<code> is the error code every refused lookup carries (default
 * ENOTFOUND, "no such host": the generic pass reports that row as dead, not as an
 * error). A test that needs the whole pass to FAIL, as it does on a machine with no
 * resolver, sets EAI_AGAIN: the address is unknown, so the row is refused and errors.
 *
 * AIDR_FAKE_SLOW_MS=<n> makes page.waitForTimeout really wait n ms.
 *
 * AIDR_FAKE_HANG=init makes addInitScript never resolve: the run stalls right
 * after the browser "launches", which is where a signal test sends SIGTERM.
 *
 * The OS scheduler is fenced off too. lib/scheduler.js is handed a fake command
 * runner the moment it loads: `aidr schedule status|uninstall` in a child process
 * can never reach the real crontab, launchctl, systemctl or schtasks. Every call
 * is recorded (`scheduler`), and AIDR_FAKE_SCHEDULER names a JSON file mapping
 * "cmd arg arg" to { status, stdout, stderr } for the answers a test wants; any
 * command it does not list answers 127 (not installed). The synchronous
 * child_process calls the INSTALL paths make are refused outright (`scheduler-blocked`).
 *
 * Not a test file (no .test.js suffix).
 */

'use strict';

const fs = require('fs');
const Module = require('module');

function record(event, detail) {
  const file = process.env.AIDR_FAKE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ event, ...detail }) + '\n');
  } catch (_) { /* a log that cannot be written must not change the run */ }
}

// No network at all: a lookup or a fetch that slips past the fake browser (the
// generic pass resolves every host before navigating, the relay and HIBP use
// fetch) is recorded and refused, so a regression cannot reach a real server.
function refuseNetwork() {
  const dns = require('dns');
  const offline = (host) => {
    record('dns', { host: String(host) });
    const code = process.env.AIDR_FAKE_DNS_CODE || 'ENOTFOUND';
    return Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
  };
  dns.promises.lookup = async (host) => { throw offline(host); };
  dns.lookup = (host, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    done(offline(host));
  };
  globalThis.fetch = async (url) => {
    record('fetch', { url: String(url).replace(/[?#].*$/, '') });
    throw new Error('fake network: not available in tests');
  };
}
refuseNetwork();

function makePage() {
  let closed = false;
  return {
    on() {},
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    // AIDR_FAKE_SLOW_MS slows every polite delay (the generic pass waits after each
    // row), so a signal test can land in the middle of a pass that would otherwise
    // be over in milliseconds.
    async waitForTimeout() {
      const slow = Number(process.env.AIDR_FAKE_SLOW_MS);
      if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
    },
    // Navigating anywhere is a bug in a test: the run must stay offline.
    async goto(url) {
      record('goto', { url: String(url).replace(/[?#].*$/, '') });
      throw new Error('fake browser: navigation is not allowed in tests');
    },
    async content() { return ''; },
    // The report and complaint PDFs render local HTML: setContent + pdf are all they need.
    async setContent() {},
    async pdf(options) {
      if (options && options.path) fs.writeFileSync(options.path, '%PDF-1.4 fake');
    },
    async evaluate() { return ''; },
    url() { return 'about:blank'; },
    isClosed() { return closed; },
    async close() { closed = true; },
  };
}

function makeContext() {
  const pages = [];
  return {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async addInitScript() {
      record('addInitScript', {});
      if (process.env.AIDR_FAKE_HANG === 'init') {
        // Tells the test the run is parked here, so a signal cannot arrive early.
        process.stderr.write('FAKE_BROWSER_HANGING\n');
        // A pending promise alone does not keep node alive (a real browser holds
        // sockets open); without a timer the process would just exit 0.
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    },
    async newPage() {
      record('newPage', {});
      const page = makePage();
      pages.push(page);
      return page;
    },
    pages() { return pages.filter(p => !p.isClosed()); },
    async close() { record('close', {}); },
  };
}

const fakePlaywright = {
  chromium: {
    async launchPersistentContext(profileDir, options) {
      // The directory NAME only (person-0-<hash>, utility): paths differ per sandbox.
      // The proxy is recorded as its server alone, never its credentials.
      record('launch', {
        headless: !!(options && options.headless),
        profile: require('path').basename(String(profileDir)),
        userAgent: options && options.userAgent,
        proxy: options && options.proxy ? options.proxy.server : undefined,
      });
      return makeContext();
    },
  },
};

// ── The OS scheduler is never reachable ──────────────────────────────────────

const SCHEDULER_COMMANDS = new Set(['crontab', 'launchctl', 'systemctl', 'schtasks']);

function fakeSchedulerRunner() {
  let answers = {};
  try {
    if (process.env.AIDR_FAKE_SCHEDULER) answers = JSON.parse(fs.readFileSync(process.env.AIDR_FAKE_SCHEDULER, 'utf8'));
  } catch (_) { /* no fixture: every command is "not installed" */ }
  return (cmd, args, input) => {
    const argv = Array.isArray(args) ? args : [];
    record('scheduler', { cmd, args: argv, stdin: typeof input === 'string' && input.length > 0 });
    const hit = answers[[cmd, ...argv].join(' ')];
    if (!hit) return { status: 127, stdout: '', stderr: 'command not found (fake)' };
    return { status: hit.status === undefined ? 0 : hit.status, stdout: hit.stdout || '', stderr: hit.stderr || '' };
  };
}

function fenceScheduler(scheduler) {
  scheduler._setRunner(fakeSchedulerRunner());
  scheduler._setStdinRunner((cmd, args) => {
    record('scheduler-blocked', { cmd, via: 'stdin' });
    return { status: 1, stderr: 'blocked by the test harness' };
  });
}

(function blockSchedulerChildProcesses() {
  const cp = require('child_process');
  const blocked = (cmd) => SCHEDULER_COMMANDS.has(require('path').basename(String(cmd).split(/\s+/)[0]));
  for (const name of ['execFileSync', 'spawnSync', 'execSync']) {
    const original = cp[name];
    cp[name] = function guarded(cmd, ...rest) {
      if (blocked(cmd)) {
        record('scheduler-blocked', { cmd: String(cmd).split(/\s+/)[0], via: name });
        throw new Error(`the test harness refuses to run ${String(cmd).split(/\s+/)[0]}`);
      }
      return original.call(this, cmd, ...rest);
    };
  }
})();

const fenced = new WeakSet();

// lib/browser.js reads the pinned Chromium version from playwright-core's
// browsers.json to write a regular Chrome user agent for a headless launch. A
// sandbox has no node_modules, so without this the version is unknown and the
// launch keeps Playwright's own (HeadlessChrome) agent: the one thing a test of
// the user agent must be able to see go away. This stands up a minimal stand-in.
(function fakePlaywrightCore() {
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-fake-core-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"playwright-core","version":"0.0.0"}');
  fs.writeFileSync(path.join(dir, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', browserVersion: '148.0.7778.96' }] }));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, ...rest) {
    if (request === 'playwright-core/package.json') return path.join(dir, 'package.json');
    return resolveFilename.call(this, request, ...rest);
  };
})();

// A spy on the one boundary a black-box run cannot otherwise observe: what the
// watcher hands the generic pass. Its queue is empty under `--only <nothing>`, so
// the options are the only evidence that each person got their own relay alias,
// their own index and the run's shared include test.
function spyOnGenericRunner(real) {
  return {
    ...real,
    async runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, opts = {}) {
      record('generic', {
        person: opts.person ? `${opts.person.firstName} ${opts.person.lastName}` : null,
        personCount: opts.personCount,
        personIndex: opts.personIndex,
        submissionEmail: opts.submissionEmail,
        includeNamed: typeof opts.include === 'function' ? ['Spokeo', 'zzz-no-such-broker'].filter(n => opts.include(n)) : null,
        explicitBrokers: Array.isArray(opts.explicitBrokers) ? opts.explicitBrokers.length : null,
        checkpointDone: opts.checkpointDone === true,
        resumeFrom: opts.resumeFrom || null,
      });
      return real.runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, opts);
    },
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent) {
  if (request === 'playwright') return fakePlaywright;
  const result = originalLoad.apply(this, arguments);
  // Recognised by what it exports, so a require from any file reaches the same fence.
  if (result && typeof result._setRunner === 'function' && typeof result.getScheduleStatus === 'function' && !fenced.has(result)) {
    fenced.add(result);
    fenceScheduler(result);
  }
  if (request === './generic-runner' && parent && /[\\/]watcher\.js$/.test(parent.filename)) {
    return spyOnGenericRunner(result);
  }
  return result;
};
