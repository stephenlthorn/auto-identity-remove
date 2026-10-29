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
 * AIDR_FAKE_HANG=init makes addInitScript never resolve: the run stalls right
 * after the browser "launches", which is where a signal test sends SIGTERM.
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
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
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
    async waitForTimeout() {},
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
      record('launch', { headless: !!(options && options.headless) });
      return makeContext();
    },
  },
};

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
      });
      return real.runGenericBrokers(context, explicitHosts, state, logResult, recordSuccess, opts);
    },
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent) {
  if (request === 'playwright') return fakePlaywright;
  const result = originalLoad.apply(this, arguments);
  if (request === './generic-runner' && parent && /[\\/]watcher\.js$/.test(parent.filename)) {
    return spyOnGenericRunner(result);
  }
  return result;
};
