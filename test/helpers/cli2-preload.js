/**
 * test/helpers/cli2-preload.js - extra fault injection for the run-loop tests.
 *
 * Preloaded AFTER fake-playwright.js (NODE_OPTIONS="... --require fake-playwright.js
 * --require this file"), so it wraps the fakes rather than replacing them. Each
 * behaviour is switched on by an environment variable and appends what it did, one
 * JSON object per line, to AIDR_TEST_LOG:
 *
 *   AIDR_TEST_CLOSE_AFTER=<n>      a browser context dies on its (n+1)th newPage():
 *                                  it reports 'close' to whoever listens (as Playwright
 *                                  does when Chromium is killed or its window closed) and
 *                                  that newPage() rejects, as does every later one. A
 *                                  relaunch gets a fresh context with a fresh count.
 *   AIDR_TEST_RELAUNCH_FAILS=1     with AIDR_TEST_CLOSE_AFTER: every launch after the first one
 *                                  throws (Chromium will not start again), recorded as
 *                                  `launch-failed`.
 *   AIDR_TEST_JOURNAL_THROWS=1     openJournal() throws: a crash in the middle of a real
 *                                  run, which lands in the Fatal handler.
 *   AIDR_TEST_GENERIC_THROWS=1     runGenericBrokers() throws: a crash that a dry run reaches too.
 *   AIDR_TEST_STATE_ON_LOCK=<file> just before lock.acquire() runs, the content of <file> is written to
 *                                  AIDR_STATE_PATH: another run that finished after this one had already
 *                                  loaded state.json at start-up.
 *   AIDR_TEST_SPY=1                records, as `configure` and `generic-opts`, what the watcher hands the
 *                                  explicit runner (the `partial` option) and the generic runner (whether
 *                                  it was given saveCheckpoint / getContext).
 *   AIDR_TEST_FETCH_BODY=1         every fetch records its URL (query stripped) and body
 *                                  as `fetch-body`, then still fails as the fake network does.
 *
 * Not a test file (no .test.js suffix).
 */

'use strict';

const fs = require('fs');
const Module = require('module');

function record(event, detail) {
  const file = process.env.AIDR_TEST_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ event, ...detail }) + '\n');
  } catch (_) { /* a log that cannot be written must not change the run */ }
}

if (process.env.AIDR_TEST_FETCH_BODY) {
  const underlying = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    record('fetch-body', { url: String(url).replace(/[?#].*$/, ''), body: options && options.body, hasSignal: Boolean(options && options.signal) });
    return underlying(url, options);
  };
}

const closingWrapped = new WeakSet();

function killAfter(chromium, limit) {
  if (closingWrapped.has(chromium)) return;
  closingWrapped.add(chromium);
  const launch = chromium.launchPersistentContext.bind(chromium);
  let generation = 0;
  let attempts = 0;
  chromium.launchPersistentContext = async (dir, options) => {
    attempts++;
    if (attempts > 1 && process.env.AIDR_TEST_RELAUNCH_FAILS) {
      record('launch-failed', { attempt: attempts });
      throw new Error('Failed to launch chromium (injected by the test)');
    }
    const context = await launch(dir, options);
    const id = ++generation;
    const closeHandlers = [];
    let created = 0;
    let dead = false;
    context.on = (event, handler) => { if (event === 'close') closeHandlers.push(handler); };
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      if (!dead && created >= limit) {
        dead = true;
        record('context-died', { generation: id, pages: created });
        for (const handler of closeHandlers) handler();
      }
      if (dead) throw new Error('Target page, context or browser has been closed');
      created++;
      return newPage();
    };
    return context;
  };
}

const spied = new WeakSet();

function spyOnBrokerRunner(runner) {
  if (spied.has(runner)) return;
  spied.add(runner);
  const configure = runner.configure;
  runner.configure = function spiedConfigure(o) {
    if (o && 'partial' in o) record('configure', { partial: o.partial });
    return configure.apply(this, arguments);
  };
}

function spyOnGeneric(generic) {
  const real = generic.runGenericBrokers;
  return {
    ...generic,
    async runGenericBrokers(context, hosts, state, log, success, opts = {}) {
      record('generic-opts', {
        hasSaveCheckpoint: typeof opts.saveCheckpoint === 'function',
        hasGetContext: typeof opts.getContext === 'function',
      });
      return real.apply(this, arguments);
    },
  };
}

function stateOnLock(lock) {
  if (spied.has(lock)) return;
  spied.add(lock);
  const acquire = lock.acquire;
  lock.acquire = function acquireAfterAnotherRun() {
    fs.writeFileSync(process.env.AIDR_STATE_PATH, fs.readFileSync(process.env.AIDR_TEST_STATE_ON_LOCK));
    record('state-replaced', {});
    return acquire.apply(this, arguments);
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  const result = originalLoad.apply(this, arguments);
  if (process.env.AIDR_TEST_STATE_ON_LOCK && request === './lib/lock') stateOnLock(result);
  if (process.env.AIDR_TEST_SPY && request === './lib/broker-runner') spyOnBrokerRunner(result);
  if (process.env.AIDR_TEST_SPY && request === './generic-runner' && !process.env.AIDR_TEST_GENERIC_THROWS) return spyOnGeneric(result);
  if (request === 'playwright' && Number(process.env.AIDR_TEST_CLOSE_AFTER) >= 0 && process.env.AIDR_TEST_CLOSE_AFTER !== undefined && process.env.AIDR_TEST_CLOSE_AFTER !== '') {
    killAfter(result.chromium, Number(process.env.AIDR_TEST_CLOSE_AFTER));
  }
  if (request === './generic-runner' && process.env.AIDR_TEST_GENERIC_THROWS) {
    return { ...result, async runGenericBrokers() { throw new Error('generic pass exploded (injected by the test)'); } };
  }
  if (request === './lib/journal' && process.env.AIDR_TEST_JOURNAL_THROWS) {
    return { ...result, openJournal() { throw new Error('journal disk full (injected by the test)'); } };
  }
  return result;
};
