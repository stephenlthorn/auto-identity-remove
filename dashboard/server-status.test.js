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
