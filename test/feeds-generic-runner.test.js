/**
 * test/feeds-generic-runner.test.js
 *
 * loadGenericBrokers must pick up data/feeds-brokers.json (the live registry
 * feed file written by watcher.js --update-brokers) as a third source, deduped
 * against the explicit broker hosts and the Markup/BADBOOL hosts.
 *
 * Strategy: intercept fs.existsSync / fs.readFileSync via Module._load so the
 * three data files (markup, badbool, feeds) return controlled fixtures and no
 * real data/ files are read.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Module   = require('module');
const path     = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP_PATH  = path.join(ROOT, 'data', 'markup-parsed.json');
const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
const FEEDS_PATH   = path.join(ROOT, 'data', 'feeds-brokers.json');

// Fixture contents keyed by absolute path.
function makeFsMock(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p, enc) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      // config.json is loaded lazily and not needed by loadGenericBrokers; throw
      // so any unexpected read is loud rather than silently passing real data.
      const err = new Error(`ENOENT mock: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function freshGenericRunnerWith(fsMock) {
  const originalLoad = Module._load.bind(Module);
  function patchedLoad(request, parent, isMain) {
    if (!parent || !parent.filename || !parent.filename.includes('generic-runner')) {
      return originalLoad(request, parent, isMain);
    }
    if (request === 'fs') return fsMock;
    return originalLoad(request, parent, isMain);
  }
  Module._load = patchedLoad;
  const grPath = require.resolve('../generic-runner');
  delete require.cache[grPath];
  let gr;
  try {
    gr = require('../generic-runner');
  } finally {
    Module._load = originalLoad;
  }
  // Bust cache again so later requires get the real fs-backed module.
  delete require.cache[grPath];
  return gr;
}

test('loadGenericBrokers includes feeds-brokers.json entries as source=ca/vt', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Markup Co', urlFinal: 'https://markup.example.com/optout' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Acme Data Co', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
      { name: 'Gamma Insights', optOutUrl: 'https://gamma.example.com/do-not-sell', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const byName = Object.fromEntries(brokers.map(b => [b.name, b]));
  assert.ok(byName['Acme Data Co'], 'feed broker present');
  assert.equal(byName['Acme Data Co'].url, 'https://acme.example.com/opt-out');
  assert.equal(byName['Acme Data Co'].source, 'ca');
  assert.equal(byName['Gamma Insights'].source, 'vt');
  assert.ok(byName['Markup Co'], 'markup fallback still loaded');
});

test('loadGenericBrokers dedups feed entries against explicit broker hosts', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Spokeo Feed', optOutUrl: 'https://www.spokeo.com/opt_out', method: 'direct-form', source: 'ca' },
      { name: 'Acme Data Co', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set(['spokeo.com']));
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Spokeo Feed'), false, 'explicit-host collision dropped');
  assert.equal(names.includes('Acme Data Co'), true, 'non-colliding feed kept');
});

test('loadGenericBrokers dedups feed entries against Markup hosts loaded first', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Dupe Co', urlFinal: 'https://dupe.example.com/privacy' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Dupe Feed', optOutUrl: 'https://dupe.example.com/opt-out', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Dupe Co'), true, 'markup entry kept (loaded first)');
  assert.equal(names.includes('Dupe Feed'), false, 'feed dup of markup host dropped');
});

test('loadGenericBrokers skips feed entries with no usable http url', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Nameonly Broker', optOutUrl: '', method: 'manual', source: 'vt' },
      { name: 'Good Broker', optOutUrl: 'https://good.example.com/optout', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Nameonly Broker'), false, 'url-less feed entry skipped');
  assert.equal(names.includes('Good Broker'), true);
});

test('loadGenericBrokers works when feeds-brokers.json is absent (markup-only fallback)', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Markup Co', urlFinal: 'https://markup.example.com/optout' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    // FEEDS_PATH intentionally omitted -> existsSync false
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].name, 'Markup Co');
  assert.equal(brokers[0].source, 'markup');
});

test('loadGenericBrokers reads the object-shaped feeds file ({ brokers, registryHosts })', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify({
      brokers: [
        { name: 'Acme Data Co', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca', registries: ['CA'] },
      ],
      registryHosts: { 'acme.example.com': ['CA'] },
    }),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  assert.ok(brokers.some(b => b.name === 'Acme Data Co' && b.url === 'https://acme.example.com/opt-out'));
});
