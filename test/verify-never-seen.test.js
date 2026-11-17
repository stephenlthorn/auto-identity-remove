/**
 * Evidence-backed removal. An empty search page after a submission means "removed"
 * only when a listing was seen at some earlier point. With no sighting it is
 * "never seen": nothing was proved removed, because nothing was proved there.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runVerify } = require('../lib/verify-loop');
const { searchHash } = require('../lib/identity');

const JANE = { firstName: 'Jane', lastName: 'Sample' };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const context = { newPage: async () => ({ close: async () => {} }) };

const searchBroker = (name, extra = {}) => ({
  name, method: 'search-form', searchUrl: `https://${name.toLowerCase()}.example/search`, listingPattern: /listing/i, ...extra,
});

// A scan counts as a sighting for the search it was made with (S1): this is Alpha's.
const ALPHA_SEARCH = searchHash('https://alpha.example/search');

// A direct-form broker that merely HAS a search step: its submission never depended on a listing,
// so nothing but a scan or a verify can say one was there (S3). A search-form broker's run searches first.
const directWithSearch = (name) => searchBroker(name, { method: 'direct-form', optOutUrl: `https://${name.toLowerCase()}.example/optout` });

const verify = (state, brokers, findUrl) => runVerify(context, brokers, [JANE], { state, findUrl });

test('no listing now and none ever seen: never_seen, in its own list, under its own field', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [directWithSearch('Alpha')], async () => null);

  assert.deepEqual(result.never_seen.map(e => e.broker), ['Alpha']);
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.still_listed.length, 0);
  const entry = state.optOuts.Alpha;
  assert.ok(entry.verifiedAbsentAt, 'recorded under verifiedAbsentAt');
  assert.equal(entry.verifiedDeletedAt, undefined, 'never under verifiedDeletedAt: it is not a removal');
  assert.equal(entry.verifyHistory.at(-1).outcome, 'never_seen');
});

test('S3: a search-form broker submitted before scans existed was seen when it was submitted: an empty search is a removal', async () => {
  // Spokeo's run searches first and returns "Not listed - nothing to remove" without a listing, so
  // its lastSuccess is itself a sighting. Upgrading users have no scan record at all.
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [searchBroker('Alpha')], async () => null);
  assert.deepEqual(result.verified_clear.map(e => e.broker), ['Alpha']);
  assert.equal(result.never_seen.length, 0);
  assert.ok(state.optOuts.Alpha.verifiedDeletedAt);
});

test('S3: the same state on a direct-form broker with a search step is still never_seen', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [directWithSearch('Alpha')], async () => null);
  assert.equal(result.verified_clear.length, 0);
  assert.deepEqual(result.never_seen.map(e => e.broker), ['Alpha']);
});

test('no listing now but a scan saw one earlier: verified_clear, a real removal', async () => {
  const state = {
    optOuts: { Alpha: { lastSuccess: daysAgo(10) } },
    scans: { Alpha: { at: daysAgo(20), outcome: 'found', lastFoundAt: daysAgo(20), listingUrl: 'https://alpha.example/listing/1', sh: ALPHA_SEARCH } },
  };
  const result = await verify(state, [searchBroker('Alpha')], async () => null);
  assert.deepEqual(result.verified_clear.map(e => e.broker), ['Alpha']);
  assert.equal(result.never_seen.length, 0);
  assert.ok(state.optOuts.Alpha.verifiedDeletedAt);
  assert.equal(state.optOuts.Alpha.verifiedAbsentAt, undefined);
  assert.equal(state.optOuts.Alpha.verifyHistory.at(-1).outcome, 'verified_clear');
});

test('a sighting made by a different search (or by older code, with no hash) is not evidence about this one', async () => {
  for (const sh of ['0123456789abcdef', undefined]) {
    const state = {
      optOuts: { Alpha: { lastSuccess: daysAgo(10) } },
      scans: { Alpha: { at: daysAgo(20), outcome: 'found', lastFoundAt: daysAgo(20), ...(sh ? { sh } : {}) } },
    };
    const result = await verify(state, [directWithSearch('Alpha')], async () => null);
    assert.equal(result.verified_clear.length, 0, String(sh));
    assert.equal(result.never_seen.length, 1, String(sh));
  }
});

test('a sighting by an earlier verify (verifiedStillListedAt) also makes a later clear a removal', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10), verifiedStillListedAt: daysAgo(30) } } };
  const result = await verify(state, [searchBroker('Alpha')], async () => null);
  assert.equal(result.verified_clear.length, 1);
});

test('the scan that saw the listing is later than the last scan: the sighting is not forgotten', async () => {
  const state = {
    optOuts: { Alpha: { lastSuccess: daysAgo(10) } },
    scans: { Alpha: { at: daysAgo(2), outcome: 'not_found', lastFoundAt: daysAgo(40), sh: ALPHA_SEARCH } },
  };
  const result = await verify(state, [searchBroker('Alpha')], async () => null);
  assert.equal(result.verified_clear.length, 1);
});

test('still listed is unchanged, and counts as a sighting for next time', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [searchBroker('Alpha')], async () => 'https://alpha.example/listing/1');
  assert.equal(result.still_listed.length, 1);
  assert.ok(state.optOuts.Alpha.verifiedStillListedAt);
  const later = await verify(state, [searchBroker('Alpha')], async () => null);
  assert.equal(later.verified_clear.length, 1, 'seen once, gone now: removed');
});

test('a search that could not tell is neither never_seen nor verified_clear', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [searchBroker('Alpha')], async () => { throw Object.assign(new Error('bot wall'), { code: 'UNVERIFIABLE' }); });
  assert.equal(result.unverifiable.length, 1);
  assert.equal(result.never_seen.length, 0);
  assert.equal(result.verified_clear.length, 0);
  assert.equal(state.optOuts.Alpha.verifiedAbsentAt, undefined);
});

test('Gate 3: an entry already found absent since the last submission is not searched again', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(20), verifiedAbsentAt: daysAgo(5) } } };
  let searched = 0;
  const result = await verify(state, [searchBroker('Alpha')], async () => { searched += 1; return null; });
  assert.equal(searched, 0);
  assert.match(result.skipped[0].reason, /already found absent/);
});

test('Gate 3: a new submission after the absent check is searched again', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(10), verifiedAbsentAt: daysAgo(40) } } };
  let searched = 0;
  await verify(state, [searchBroker('Alpha')], async () => { searched += 1; return null; });
  assert.equal(searched, 1);
});

test('Gate 4: a direct-form broker with a search step is verified', async () => {
  const state = { optOuts: { Delta: { lastSuccess: daysAgo(10) } } };
  const broker = searchBroker('Delta', { method: 'direct-form', optOutUrl: 'https://delta.example/optout' });
  const result = await verify(state, [broker], async () => 'https://delta.example/listing/1');
  assert.equal(result.still_listed.length, 1);
  assert.equal(result.unverifiable.length, 0);
});

test('Gate 4: a broker with no search step stays unverifiable', async () => {
  const state = { optOuts: { Plain: { lastSuccess: daysAgo(10) } } };
  const result = await verify(state, [{ name: 'Plain', method: 'direct-form', optOutUrl: 'https://plain.example/o' }], async () => null);
  assert.equal(result.unverifiable.length, 1);
});

test('state from an older version: a verifiedDeletedAt after the last submission is still a verified removal', async () => {
  const state = { optOuts: { Alpha: { lastSuccess: daysAgo(20), verifiedDeletedAt: daysAgo(5) } } };
  let searched = 0;
  const result = await verify(state, [searchBroker('Alpha')], async () => { searched += 1; return null; });
  assert.equal(searched, 0);
  assert.match(result.skipped[0].reason, /already verified clear/);
  assert.ok(state.optOuts.Alpha.verifiedDeletedAt, 'left exactly as older versions wrote it');
});
