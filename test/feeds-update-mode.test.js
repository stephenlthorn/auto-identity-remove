/**
 * test/feeds-update-mode.test.js
 *
 * Tests runUpdateBrokers - the orchestration behind `watcher.js --update-brokers`.
 * All deps are injected (buildFn, writeFn, logFn), so there is no network and
 * no real file write.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { runUpdateBrokers } = require('../lib/feeds');

const EXPLICIT_BROKERS = [
  { name: 'Spokeo', searchUrl: 'https://www.spokeo.com/' },
  { name: 'BeenVerified', optOutUrl: 'https://www.beenverified.com/app/optout/search' },
  { name: 'EmailOnly', method: 'email', emailTo: 'privacy@x.example.com' }, // no host
];

test('runUpdateBrokers derives explicit hosts and passes them to buildFn', async () => {
  let capturedHosts = null;
  const buildFn = async ({ explicitHosts }) => {
    capturedHosts = explicitHosts;
    return { brokers: [], stats: { ca: 0, vt: 0, total: 0 } };
  };
  const writeFn = () => {};
  await runUpdateBrokers({ buildFn, writeFn, brokers: EXPLICIT_BROKERS, logFn: () => {} });
  assert.ok(capturedHosts instanceof Set);
  assert.equal(capturedHosts.has('spokeo.com'), true);
  assert.equal(capturedHosts.has('beenverified.com'), true);
  // EmailOnly contributes no host
  assert.equal(capturedHosts.size, 2);
});

test('runUpdateBrokers writes the normalized broker array via writeFn', async () => {
  const brokerList = [
    { name: 'Acme', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
  ];
  const buildFn = async () => ({ brokers: brokerList, stats: { ca: 1, vt: 0, total: 1 } });
  let written = null;
  const writeFn = (payload) => { written = payload; };
  const result = await runUpdateBrokers({ buildFn, writeFn, brokers: [], logFn: () => {} });
  assert.deepEqual(written, brokerList);
  assert.equal(result.stats.total, 1);
});

test('runUpdateBrokers returns the stats from buildFn for the caller to print', async () => {
  const buildFn = async () => ({ brokers: [], stats: { ca: 3, vt: 4, total: 5 } });
  const result = await runUpdateBrokers({ buildFn, writeFn: () => {}, brokers: [], logFn: () => {} });
  assert.deepEqual(result.stats, { ca: 3, vt: 4, total: 5 });
});

test('runUpdateBrokers logs a human summary line', async () => {
  const logs = [];
  const buildFn = async () => ({ brokers: [], stats: { ca: 2, vt: 1, total: 3 } });
  await runUpdateBrokers({ buildFn, writeFn: () => {}, brokers: [], logFn: (m) => logs.push(m) });
  const joined = logs.join('\n');
  assert.match(joined, /3/);   // total appears in summary
});
