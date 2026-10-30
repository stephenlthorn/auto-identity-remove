/**
 * dashboard/server-status.test.js
 *
 * DASH-5: multi-person installs key state "Broker|First Last"; the summary and
 * the broker table looked up only the bare broker name and read "0 opted out".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./support/harness');

async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const BROKERS = [
  { name: 'Spokeo', method: 'search-form', priority: 1 },
  { name: 'MyLife', method: 'direct-form', priority: 2 },
  { name: 'Whitepages', method: 'email', priority: 2 },
  { name: 'Intelius', method: 'manual', priority: 3 },
];

test('DASH-5: composite per-person success keys count in /api/summary', async () => {
  const stateContent = { optOuts: { 'Spokeo|A B': { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  await withServer({ stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.optedOut, 1);
    assert.equal(s.manual, 1);
    assert.equal(s.brokers, 4);
  });
});

test('DASH-5: single-person bare keys still count', async () => {
  const stateContent = { optOuts: { Spokeo: { history: ['success'] }, MyLife: { history: ['pending_confirm'] } } };
  await withServer({ stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.optedOut, 1);
    assert.equal(s.pending, 1);
  });
});

test('DASH-5: a broker counts once however many people it has entries for', async () => {
  const stateContent = {
    optOuts: {
      'Spokeo|A B': { history: ['success'] },
      'Spokeo|C D': { history: ['success'] },
      'MyLife|A B': { history: ['success'] },
      'MyLife|C D': { history: ['pending_confirm'] },
    },
  };
  await withServer({ stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.optedOut, 1, 'Spokeo only; MyLife has a person still pending');
    assert.equal(s.pending, 1);
  });
});

test('DASH-5: /api/brokers carries the aggregated status with per-person detail', async () => {
  const stateContent = {
    optOuts: {
      'Spokeo|A B': { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' },
      'Spokeo|C D': { history: ['error'], lastAttempt: '2026-02-01T00:00:00.000Z' },
    },
  };
  await withServer({ stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    const list = (await request({ pathname: '/api/brokers' })).json;
    const spokeo = list.find(b => b.name === 'Spokeo');
    assert.equal(spokeo.status.key, 'error');
    assert.equal(spokeo.status.count, 2);
    assert.deepEqual(spokeo.status.people.map(p => p.person).sort(), ['A B', 'C D']);
    assert.equal(list.find(b => b.name === 'MyLife').status.key, 'none');
    assert.equal(list.find(b => b.name === 'Intelius').status.key, 'manual');
  });
});

test('DASH-5: no state file at all gives none for every broker and zero counts', async () => {
  await withServer({ options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.optedOut, 0);
    assert.equal(s.stateExists, false);
    assert.ok((await request({ pathname: '/api/brokers' })).json.filter(b => b.method !== 'manual').every(b => b.status.key === 'none'));
  });
});

// CFG2-7: an entry stamped for another identity counts as "never run" everywhere
// else (readEntry, complaints, config check). The status table and the summary
// read the raw state, so they kept showing OK for a submission made with a zip or
// email the person no longer has.

const { personFingerprint } = require('../lib/config');

const ANN = { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' };
const ANN_OLD_ZIP = { ...ANN, zip: '99999' };

test('CFG2-7: an entry stamped for a previous identity is not shown as opted out', async () => {
  const stateContent = {
    optOuts: {
      Spokeo: { history: ['success'], fp: personFingerprint(ANN_OLD_ZIP) },
      MyLife: { history: ['success'], fp: personFingerprint(ANN) },
      Whitepages: { history: ['success'] },
    },
  };
  await withServer({ cfgContent: { person: ANN }, stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.optedOut, 2, 'MyLife (current identity) and Whitepages (unstamped); not Spokeo');
    const list = (await request({ pathname: '/api/brokers' })).json;
    const status = (name) => list.find(b => b.name === name).status.key;
    assert.equal(status('Spokeo'), 'none');
    assert.equal(status('MyLife'), 'ok');
    assert.equal(status('Whitepages'), 'ok');
  });
});

test('CFG2-7: with the config locked or unreadable nothing is filtered', async () => {
  const stateContent = { optOuts: { Spokeo: { history: ['success'], fp: personFingerprint(ANN_OLD_ZIP) } } };
  await withServer({ stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/summary' })).json.optedOut, 1, 'no config to compare against');
  });
});

test('CFG2-7: an entry stamped with the first-generation (phone) fingerprint still counts', async () => {
  const crypto = require('node:crypto');
  const legacy = crypto.createHash('sha256').update(['ann', 'probe', '12345', 'ann@example.test', '5125550000'].join('\n')).digest('hex').slice(0, 16);
  const stateContent = { optOuts: { Spokeo: { history: ['success'], fp: legacy } } };
  await withServer({ cfgContent: { person: { ...ANN, phone: '5125550000' } }, stateContent, options: { brokers: BROKERS } }, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/summary' })).json.optedOut, 1);
  });
});
