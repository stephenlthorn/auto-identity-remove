/**
 * test/drop-loader.test.js
 *
 * What the generic loader (loadGenericBrokers) does with the registry feed rows that
 * DROP coverage depends on: each row keeps its `registries` field (D1), and rows that
 * share a form platform host stay separate rows (D5). The three data files are
 * replaced by fixtures through a patched fs, like test/feeds-generic-runner.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP_PATH = path.join(ROOT, 'data', 'markup-parsed.json');
const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
const FEEDS_PATH = path.join(ROOT, 'data', 'feeds-brokers.json');

function freshGenericRunnerWith(files) {
  const fsMock = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT mock: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
  const originalLoad = Module._load.bind(Module);
  Module._load = (request, parent, isMain) => {
    if (parent && parent.filename && parent.filename.includes('generic-runner') && request === 'fs') return fsMock;
    return originalLoad(request, parent, isMain);
  };
  const grPath = require.resolve('../generic-runner');
  delete require.cache[grPath];
  try {
    return require('../generic-runner');
  } finally {
    Module._load = originalLoad;
    delete require.cache[grPath];
  }
}

const load = ({ markup = [], badbool = [], feeds }, explicitHosts = []) => {
  const gr = freshGenericRunnerWith({
    [MARKUP_PATH]: JSON.stringify(markup),
    [BADBOOL_PATH]: JSON.stringify(badbool),
    [FEEDS_PATH]: JSON.stringify({ brokers: feeds, registryHosts: {}, registries: {} }),
  });
  return gr.loadGenericBrokers(explicitHosts, { explicitBrokers: [] });
};

test('a feed row keeps its registries field, so coverage can read it (D1)', () => {
  const rows = load({
    feeds: [{ name: 'Acme Data Co', optOutUrl: 'https://privacyportal.onetrust.com/webform/a/1', method: 'direct-form', source: 'ca', registries: ['CA', 'VT'] }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].registries, ['CA', 'VT']);
});

// ── D5: three registry brokers whose rights pages share one form platform ────

const PORTAL = 'https://privacyportal.onetrust.com/webform';
const THREE = [
  { name: 'Alpha Data', optOutUrl: `${PORTAL}/aaa/111`, method: 'direct-form', source: 'ca', registries: ['CA'] },
  { name: 'Beta Data', optOutUrl: `${PORTAL}/bbb/222`, method: 'direct-form', source: 'ca', registries: ['CA'] },
  { name: 'Gamma Data', optOutUrl: `${PORTAL}/ccc/333`, method: 'direct-form', source: 'ca', registries: ['CA'] },
];

test('three feed rows on one form platform all survive the loader (D5)', () => {
  const rows = load({ feeds: THREE });
  assert.deepEqual(rows.map(r => r.name).sort(), ['Alpha Data', 'Beta Data', 'Gamma Data']);
});

test('a bundled row already on that platform host does not swallow the feed rows (D5)', () => {
  const rows = load({
    markup: [{ name: 'Delta Data', urlFinal: `${PORTAL}/ddd/444`, hostname: 'delta-data.example' }],
    feeds: THREE,
  });
  assert.deepEqual(rows.map(r => r.name).sort(), ['Alpha Data', 'Beta Data', 'Delta Data', 'Gamma Data']);
});

test('two rows on a shared platform are one row only when host and path are the same', () => {
  const rows = load({
    feeds: [
      THREE[0],
      { ...THREE[0], name: 'Alpha Data again', optOutUrl: `${PORTAL}/aaa/111/` },
      { ...THREE[1], name: 'Alpha Data other path', optOutUrl: `${PORTAL}/aaa/999` },
    ],
  });
  assert.deepEqual(rows.map(r => r.name), ['Alpha Data', 'Alpha Data other path']);
});

test('on an ordinary host two rows are still one row (host only)', () => {
  const rows = load({
    feeds: [
      { name: 'Acme', optOutUrl: 'https://acme-data.example/a', source: 'ca', registries: ['CA'] },
      { name: 'Acme two', optOutUrl: 'https://www.acme-data.example/b', source: 'ca', registries: ['CA'] },
    ],
  });
  assert.equal(rows.length, 1);
});
