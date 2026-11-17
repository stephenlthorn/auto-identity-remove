'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScan, readScan } = require('../lib/scan');

const JANE = { firstName: 'Jane', lastName: 'Sample', zip: '78701', email: 'jane@example.org' };
const SAM = { firstName: 'Sam', lastName: 'Sample', zip: '78701', email: 'sam@example.org' };

const searchBroker = (name, extra = {}) => ({
  name,
  method: 'search-form',
  searchUrl: `https://${name.toLowerCase()}.example/search`,
  listingPattern: /listing/i,
  // These tests are about how a scan works; whether an empty answer may drive a skip
  // (searchCheckedAt) is covered in scan-unvalidated.test.js.
  searchCheckedAt: '2026-11-17',
  ...extra,
});
const directWithSearch = (name) => ({ ...searchBroker(name), method: 'direct-form', optOutUrl: `https://${name.toLowerCase()}.example/optout` });
const directNoSearch = (name) => ({ name, method: 'direct-form', optOutUrl: `https://${name.toLowerCase()}.example/optout` });
const emailBroker = (name) => ({ name, method: 'email', optOutEmail: `privacy@${name.toLowerCase()}.example` });

/** A context whose pages record every call, and fail loudly on anything that submits. */
function makeContext(log = []) {
  return {
    newPage: async () => ({
      close: async () => { log.push('close'); },
      goto: async () => {},
      click: () => { throw new Error('a scan must never click'); },
      fill: () => { throw new Error('a scan must never fill'); },
      _isPage: true,
    }),
  };
}

const unverifiable = (message) => Object.assign(new Error(message), { code: 'UNVERIFIABLE' });

// Shaped like a real people-search listing, which carries the person's name and city in its path.
const REAL_SHAPED = 'https://alpha.example/Jane-Sample/Austin-TX/Jane-Sample-p123456789';

test('found: the listing url and a screenshot are recorded, and nothing is submitted or printed', async () => {
  const state = { optOuts: {} };
  const shots = [];
  const printed = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(originals)) console[k] = (...args) => printed.push(args.join(' '));
  let result;
  try {
    result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], {
      state,
      findUrl: async () => REAL_SHAPED,
      snapshot: async (page, name) => { shots.push(name); return '/tmp/private/alpha.png'; },
    });
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(result.found.map(e => [e.broker, e.listingUrl]), [['Alpha', REAL_SHAPED]]);
  assert.equal(state.scans.Alpha.outcome, 'found');
  assert.equal(state.scans.Alpha.listingUrl, REAL_SHAPED, 'the full address is kept in state, where a later run needs it');
  assert.equal(printed.filter(l => /Jane-Sample|Austin-TX/.test(l)).length, 0, 'runScan itself prints no listing path');
  assert.equal(state.scans.Alpha.screenshot, '/tmp/private/alpha.png');
  assert.equal(shots.length, 1);
  assert.deepEqual(state.optOuts, {}, 'the opt-out history is untouched');
});

test('found without a screenshot (the helper returned null) is still found', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], {
    state, findUrl: async () => 'https://alpha.example/listing/1', snapshot: async () => null,
  });
  assert.equal(result.found.length, 1);
  assert.equal(state.scans.Alpha.screenshot, undefined);
});

test('not_found: the search page loaded and showed no listing', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], { state, findUrl: async () => null });
  assert.deepEqual(result.not_found.map(e => e.broker), ['Alpha']);
  assert.equal(state.scans.Alpha.outcome, 'not_found');
  assert.equal(result.unknown.length, 0);
});

test('a bot wall, a failed navigation or any thrown error is "could not tell", never not_found', async () => {
  const errors = [
    unverifiable('alpha.example served a bot wall or challenge instead of results (captcha)'),
    unverifiable('navigation to alpha.example failed (timeout)'),
    unverifiable('alpha.example answered HTTP 403 to the search page'),
    new Error('something else broke'),
  ];
  for (const err of errors) {
    const state = { optOuts: {} };
    const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], {
      state, findUrl: async () => { throw err; },
    });
    assert.equal(result.not_found.length, 0, err.message);
    assert.equal(result.found.length, 0, err.message);
    assert.equal(result.unknown.length, 1, err.message);
    assert.match(result.unknown[0].reason, /search failed/);
    assert.equal(state.scans.Alpha.outcome, 'unknown');
    assert.ok(state.scans.Alpha.reason.length > 0);
  }
});

test('an unexpected return from the search is "could not tell"', async () => {
  for (const odd of [undefined, 0, '', 42, {}]) {
    const state = { optOuts: {} };
    const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], { state, findUrl: async () => odd });
    assert.equal(result.unknown.length, 1, String(odd));
    assert.equal(result.not_found.length, 0, String(odd));
    assert.equal(state.scans.Alpha.outcome, 'unknown');
  }
});

test('a reason never carries a URL (it holds the person\'s name and city), only the host', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], {
    state,
    findUrl: async () => { throw new Error('net::ERR_FAILED at https://alpha.example/Jane-Sample/Austin-TX?x=1'); },
  });
  assert.doesNotMatch(result.unknown[0].reason, /Jane-Sample|Austin/);
  assert.match(result.unknown[0].reason, /alpha\.example/);
  assert.doesNotMatch(JSON.stringify(state), /Jane-Sample/);
});

test('a browser that would not start is "could not tell" for that person, tried once', async () => {
  const state = { optOuts: {} };
  let launches = 0;
  const result = await runScan(null, [searchBroker('Alpha'), searchBroker('Beta')], [JANE], {
    state,
    findUrl: async () => { throw new Error('must not search without a browser'); },
    contextFor: async () => { launches += 1; throw new Error('Executable does not exist'); },
  });
  assert.equal(launches, 1, 'a broken Chromium is not relaunched per broker');
  assert.deepEqual(result.unknown.map(e => e.broker), ['Alpha', 'Beta']);
  assert.match(result.unknown[0].reason, /browser unavailable/);
  assert.equal(state.scans.Alpha.outcome, 'unknown');
});

test('a page that cannot be opened (the browser died) is "could not tell"', async () => {
  const state = { optOuts: {} };
  const context = { newPage: async () => { throw new Error('Target closed'); } };
  const result = await runScan(context, [searchBroker('Alpha')], [JANE], { state, findUrl: async () => null });
  assert.equal(result.unknown.length, 1);
  assert.equal(result.not_found.length, 0);
});

test('every page is closed, whatever the search did', async () => {
  const log = [];
  await runScan(makeContext(log), [searchBroker('A'), searchBroker('B'), searchBroker('C')], [JANE], {
    state: { optOuts: {} },
    findUrl: async (page, broker) => {
      if (broker.name === 'B') throw new Error('boom');
      return broker.name === 'A' ? 'https://a.example/listing/1' : null;
    },
    snapshot: async () => null,
  });
  assert.deepEqual(log, ['close', 'close', 'close']);
});

test('brokers that cannot be searched are listed, not recorded, and never opened', async () => {
  const state = { optOuts: {} };
  let opened = 0;
  const context = { newPage: async () => { opened += 1; return { close: async () => {} }; } };
  const result = await runScan(context, [directNoSearch('Direct'), emailBroker('Mail'), { name: 'Hand', method: 'manual' }], [JANE], {
    state, findUrl: async () => { throw new Error('must not search'); },
  });
  assert.deepEqual(result.unsearchable.map(e => e.broker), ['Direct', 'Mail', 'Hand']);
  assert.equal(opened, 0);
  assert.equal(state.scans, undefined);
});

test('a direct-form broker with a search step is scanned', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [directWithSearch('Delta')], [JANE], {
    state, findUrl: async () => 'https://delta.example/listing/9', snapshot: async () => null,
  });
  assert.equal(result.found.length, 1);
  assert.equal(result.unsearchable.length, 0);
  assert.equal(state.scans.Delta.outcome, 'found');
});

test('allowlisted brokers are skipped, once, and never searched', async () => {
  const state = { optOuts: {} };
  const searched = [];
  const result = await runScan(makeContext(), [searchBroker('Alpha'), searchBroker('Beta')], [JANE, SAM], {
    state,
    config: { allowlist: ['Alpha'] },
    brokersFor: () => [searchBroker('Alpha'), searchBroker('Beta')],
    findUrl: async (page, broker) => { searched.push(broker.name); return null; },
  });
  assert.deepEqual(searched, ['Beta', 'Beta']);
  assert.equal(result.skipped.filter(e => e.broker === 'Alpha').length, 1);
  assert.match(result.skipped[0].reason, /allowlist/);
  assert.equal(state.scans['Alpha|Jane Sample'], undefined);
});

test('a US-only broker is not searched for someone outside the US', async () => {
  const state = { optOuts: {} };
  const searched = [];
  const abroad = { ...JANE, country: 'GB' };
  const result = await runScan(makeContext(), [searchBroker('Alpha', { usOnly: true })], [abroad], {
    state, findUrl: async (page, broker) => { searched.push(broker.name); return null; },
  });
  assert.deepEqual(searched, []);
  assert.match(result.skipped[0].reason, /US-only/);
});

test('each person is searched with their own broker list and their own browser, one person at a time', async () => {
  const state = { optOuts: {} };
  const log = [];
  const makeFor = (label) => ({ newPage: async () => { log.push(`page:${label}`); return { close: async () => {} }; } });
  const ctx = { jane: makeFor('jane'), sam: makeFor('sam') };
  const seen = [];
  const requested = [];
  const result = await runScan(null, [searchBroker('Alpha'), searchBroker('Beta')], [JANE, SAM], {
    state,
    brokersFor: (person) => [searchBroker('Alpha', { searchUrl: `https://alpha.example/search?n=${person.firstName}` }), searchBroker('Beta')],
    contextFor: (person, index) => { requested.push(index); return index === 0 ? ctx.jane : ctx.sam; },
    findUrl: async (page, broker, person) => {
      seen.push(`${person.firstName}:${broker.searchUrl}`);
      return person === JANE && broker.name === 'Alpha' ? 'https://alpha.example/listing/1' : null;
    },
    snapshot: async () => null,
  });
  assert.deepEqual(log, ['page:jane', 'page:jane', 'page:sam', 'page:sam']);
  assert.deepEqual(requested, [0, 1], "one browser request per person");
  assert.ok(seen.includes('Jane:https://alpha.example/search?n=Jane'));
  assert.ok(seen.includes('Sam:https://alpha.example/search?n=Sam'));
  assert.deepEqual(Object.keys(state.scans).sort(), ['Alpha|Jane Sample', 'Alpha|Sam Sample', 'Beta|Jane Sample', 'Beta|Sam Sample']);
  assert.equal(readScan(state, 'Alpha', JANE, 2, { persons: [JANE, SAM] }).outcome, 'found');
  assert.equal(readScan(state, 'Alpha', SAM, 2, { persons: [JANE, SAM] }).outcome, 'not_found');
  assert.equal(result.found.length, 1);
  assert.equal(result.not_found.length, 3);
});

test('a broker list that cannot be built for a person is "could not tell" for that person', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [searchBroker('Alpha')], [JANE], {
    state, brokersFor: () => { throw new Error('missing phone'); }, findUrl: async () => null,
  });
  assert.equal(result.unknown.length, 1);
  assert.match(result.unknown[0].reason, /could not build broker list/);
});

test('the latest result replaces the previous one and the history grows', async () => {
  const state = { optOuts: {} };
  const brokers = [searchBroker('Alpha')];
  await runScan(makeContext(), brokers, [JANE], { state, findUrl: async () => 'https://alpha.example/listing/1', snapshot: async () => null, now: new Date('2026-10-01T00:00:00Z') });
  await runScan(makeContext(), brokers, [JANE], { state, findUrl: async () => null, now: new Date('2026-11-01T00:00:00Z') });
  const entry = state.scans.Alpha;
  assert.equal(entry.outcome, 'not_found');
  assert.equal(entry.at, '2026-11-01T00:00:00.000Z');
  assert.equal(entry.lastFoundAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(entry.history.map(h => h.outcome), ['found', 'not_found']);
});

test('runScan needs a state object', async () => {
  await assert.rejects(() => runScan(makeContext(), [], [JANE], {}), /state/);
});
