'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runGenericBrokers } = require('../generic-runner.js');

// Regression test for the generic-runner browser-process leak.
//
// Broker sites routinely open popups / _blank tabs / consent / OAuth windows
// while runGenericBrokers clicks "Do Not Sell" links. Those open as extra pages
// in the persistent context. Previously they were never closed, so renderer
// processes accumulated across the ~500-site list (observed ~1200 stray Chromium
// processes, exhausting the host). runGenericBrokers must prune any page it did
// not create as the working page, and close the working page when done.

// Minimal Playwright-like context that tracks its open pages.
function makeTrackingContext() {
  const pages = [];
  const makePage = () => {
    const p = {
      _closed: false,
      isClosed() { return p._closed; },
      async close() { p._closed = true; const i = pages.indexOf(p); if (i >= 0) pages.splice(i, 1); },
      async waitForTimeout() {},
      async goto() {},
    };
    pages.push(p);
    return p;
  };
  return {
    pages: () => pages.slice(),
    newPage: async () => makePage(),
    openPageCount: () => pages.length,
  };
}

test('runGenericBrokers prunes broker-opened popups and leaves no pages open', async () => {
  const context = makeTrackingContext();
  const N = 10;
  const brokers = Array.from({ length: N }, (_, i) => ({ name: 'Broker' + i, url: 'about:blank' }));

  // Each broker opens a popup it never closes — mimics a _blank/consent window.
  const leakyProcessFn = async () => {
    await context.newPage();
    return { status: 'success', detail: 'simulated popup' };
  };

  const res = await runGenericBrokers(context, [], { optOuts: {} }, () => {}, () => {}, {
    injectedBrokers: brokers,
    injectedProcessFn: leakyProcessFn,
  });

  assert.strictEqual(res.genericStats.attempted, N, 'every broker should be processed');
  assert.strictEqual(context.openPageCount(), 0,
    `expected all pages closed after the run, found ${context.openPageCount()} still open (leak)`);
});

test('runGenericBrokers keeps running after a broker throws (and still cleans up)', async () => {
  const context = makeTrackingContext();
  const brokers = [{ name: 'ok1', url: 'x' }, { name: 'boom', url: 'x' }, { name: 'ok2', url: 'x' }];

  const processFn = async (_page, broker) => {
    if (broker.name === 'boom') throw new Error('Timeout');
    return { status: 'success', detail: 'ok' };
  };

  const res = await runGenericBrokers(context, [], { optOuts: {} }, () => {}, () => {}, {
    injectedBrokers: brokers,
    injectedProcessFn: processFn,
  });

  // All three attempted (the throw is caught, recorded as error, run continues).
  assert.strictEqual(res.genericStats.attempted, 3, 'a single broker throwing must not abort the run');
  assert.strictEqual(context.openPageCount(), 0, 'pages must be cleaned up even when a broker throws');
});
