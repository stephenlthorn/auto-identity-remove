// test/serp-watch-inconclusive.test.js
/**
 * NET-5: serp-watch must not say "No new broker domains" (or "gone") when the
 * scan it ran was blocked or unreadable. Deps are injected; no browser, no disk.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

const { runSerpWatch, describeWatchOutcome } = require('../lib/serp-watch');

const BLOCKED_SUMMARY = {
  total_brokers_appearing: 0,
  results: [],
  blocked: ['ddg', 'bing', 'google'],
  unparsed: [],
  engines: { ddg: 'blocked', bing: 'blocked', google: 'blocked' },
  enginesUsable: [],
  enginesAttempted: 3,
  inconclusive: true,
};

const CLEAN_SUMMARY = {
  total_brokers_appearing: 0,
  results: [],
  blocked: [],
  unparsed: [],
  engines: { ddg: 'parsed', bing: 'parsed', google: 'empty' },
  enginesUsable: ['ddg', 'bing', 'google'],
  enginesAttempted: 3,
  inconclusive: false,
};

const history = [{ hostname: 'spokeo.com' }, { hostname: 'radaris.com' }];

async function watch(summary, { alerts = [] } = {}) {
  return runSerpWatch({}, [{ firstName: 'Jane', lastName: 'Doe' }], [], {
    _readHistory: () => history,
    _runSerpScan: async () => summary,
    _dispatchNotify: async (text) => { alerts.push(text); },
    cfg: {},
  });
}

test('NET-5: a blocked scan is inconclusive and says so instead of "No new broker domains"', async () => {
  const result = await watch(BLOCKED_SUMMARY);
  assert.equal(result.inconclusive, true);
  assert.equal(result.alerted, false);

  const text = describeWatchOutcome(result).join('\n');
  assert.match(text, /INCONCLUSIVE/);
  assert.doesNotMatch(text, /No new broker domains/);
});

test('NET-5: a blocked scan cannot claim that previously seen domains are gone', async () => {
  const result = await watch(BLOCKED_SUMMARY);
  assert.deepEqual(result.diff.goneDomains, []);
});

test('NET-5: a conclusive scan with nothing new still says "No new broker domains"', async () => {
  const result = await watch(CLEAN_SUMMARY);
  assert.equal(result.inconclusive, false);
  assert.deepEqual(result.diff.goneDomains, ['radaris.com', 'spokeo.com'], 'gone is meaningful when the scan was usable');
  assert.match(describeWatchOutcome(result).join('\n'), /No new broker domains since the last scan\./);
});

test('NET-5: a partial scan says how many engines were behind "no new domains"', async () => {
  const result = await watch({
    ...CLEAN_SUMMARY,
    engines: { ddg: 'parsed', bing: 'blocked', google: 'blocked' },
    enginesUsable: ['ddg'],
    blocked: ['bing', 'google'],
  });
  const text = describeWatchOutcome(result).join('\n');
  assert.match(text, /No new broker domains/);
  assert.match(text, /1 of 3/);
});

test('NET-5: new domains found in an incomplete scan are still alerted, with a caveat', async () => {
  const alerts = [];
  const result = await watch({
    ...BLOCKED_SUMMARY,
    results: [{ broker: 'Whitepages', hostname: 'whitepages.com', ranks: { ddg: 2, bing: null, google: null } }],
    total_brokers_appearing: 1,
    engines: { ddg: 'parsed', bing: 'blocked', google: 'blocked' },
    enginesUsable: ['ddg'],
    inconclusive: false,
  }, { alerts });

  assert.equal(result.alerted, true);
  assert.equal(alerts.length, 1);
  const text = describeWatchOutcome(result).join('\n');
  assert.match(text, /NEW domains/);
  assert.match(text, /whitepages\.com/);
});

test('NET-5: a scan summary without the new fields behaves exactly as before', async () => {
  const result = await watch({ total_brokers_appearing: 0, results: [], blocked: [] });
  assert.equal(result.inconclusive, false);
  assert.match(describeWatchOutcome(result).join('\n'), /No new broker domains/);
});
