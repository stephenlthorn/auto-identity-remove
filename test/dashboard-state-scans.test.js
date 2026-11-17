/**
 * S6: GET /api/state reduces every scan record's listing URL (and any URL in its history) to the
 * host and drops the screenshot path. A listing URL carries the person's name in its path, and
 * a screenshot path is an absolute path on the machine.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HAS_EXPRESS = fs.existsSync(path.join(__dirname, '..', 'dashboard', 'node_modules', 'express'));
const skipNoExpress = HAS_EXPRESS ? false : 'dashboard dependencies are not installed (run: cd dashboard && npm ci)';
const harness = HAS_EXPRESS ? require('../dashboard/support/harness') : null;

async function withServer(opts, fn) {
  const h = await harness.startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const LISTING = 'https://www.spokeo.com/Jane-Sample/Austin-TX/Jane-Sample-p123456789?q=jane%40example.org';
const SHOT = '/Users/someone/aidr/snapshots/scan-Spokeo-2026-11-17.png';

const state = {
  optOuts: {},
  scans: {
    Spokeo: {
      at: '2026-11-17T10:00:00.000Z', outcome: 'found', listingUrl: LISTING, screenshot: SHOT,
      lastFoundAt: '2026-11-17T10:00:00.000Z', sh: '0123456789abcdef',
      history: [{ at: '2026-11-10T10:00:00.000Z', outcome: 'found', listingUrl: LISTING }, { at: '2026-11-17T10:00:00.000Z', outcome: 'found' }],
    },
    'Nuwber|Jane Sample': { at: '2026-11-17T10:00:00.000Z', outcome: 'unknown', reason: 'search failed: nuwber.com answered HTTP 403', history: [] },
  },
};

test('/api/state: a scan record keeps its outcome and dates but only the host of its listing URL', { skip: skipNoExpress }, async () => {
  await withServer({ stateContent: state }, async ({ request }) => {
    const r = await request({ pathname: '/api/state' });
    assert.equal(r.status, 200);
    const scan = r.json.scans.Spokeo;
    assert.equal(scan.outcome, 'found');
    assert.equal(scan.lastFoundAt, '2026-11-17T10:00:00.000Z');
    assert.equal(scan.listingUrl, 'www.spokeo.com');
    assert.equal(r.json.scans['Nuwber|Jane Sample'].outcome, 'unknown');
  });
});

test('/api/state: no screenshot path and no listing path or query leaves the machine', { skip: skipNoExpress }, async () => {
  await withServer({ stateContent: state }, async ({ request }) => {
    const r = await request({ pathname: '/api/state' });
    const body = JSON.stringify(r.json);
    assert.equal('screenshot' in r.json.scans.Spokeo, false);
    assert.doesNotMatch(body, /Jane-Sample|Austin-TX|p123456789|jane%40example|\/Users\/someone|snapshots/);
    for (const h of r.json.scans.Spokeo.history) {
      if (h.listingUrl !== undefined) assert.equal(h.listingUrl, 'www.spokeo.com');
    }
  });
});

test('/api/state: a state with no scans is unchanged', { skip: skipNoExpress }, async () => {
  await withServer({ stateContent: { optOuts: { A: { lastSuccess: '2026-11-01T00:00:00.000Z' } } } }, async ({ request }) => {
    const r = await request({ pathname: '/api/state' });
    assert.equal(r.json.scans, undefined);
    assert.equal(r.json.optOuts.A.lastSuccess, '2026-11-01T00:00:00.000Z');
  });
});
