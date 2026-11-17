'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recordScan, readScan, hasSeenListing, hasAnyScan, decideFoundOnly, SCAN_HISTORY_MAX,
} = require('../lib/scan');
const { personFingerprint, searchHash } = require('../lib/identity');

// People as the config has them, with the full name and the state the search URLs are built from:
// fixtures without them are what hid S1 (the identity fingerprint covers neither).
const jane = { firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', state: 'TX', zip: '78701', email: 'jane@example.org' };
const sam = { firstName: 'Sam', lastName: 'Sample', fullName: 'Sam Sample', state: 'TX', zip: '78701', email: 'sam@example.org' };
const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

function ref(brokerName, person = jane, personCount = 1) {
  return { brokerName, person, personCount, persons: personCount === 1 ? [person] : [jane, sam] };
}

// ── recordScan / readScan ────────────────────────────────────────────────────

test('recordScan keeps the latest result under the per-person key the opt-outs use', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'found', at: daysBefore(1), listingUrl: 'https://spokeo.example/jane' });
  assert.equal(state.scans.Spokeo.outcome, 'found');
  assert.equal(state.scans.Spokeo.listingUrl, 'https://spokeo.example/jane');

  const two = { optOuts: {} };
  recordScan(two, ref('Spokeo', sam, 2), { outcome: 'not_found', at: daysBefore(1) });
  assert.deepEqual(Object.keys(two.scans), ['Spokeo|Sam Sample']);
});

test('recordScan stamps the identity fingerprint and a scan of someone else is not theirs', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'found', at: daysBefore(1), listingUrl: 'https://s.example/a' });
  assert.equal(state.scans.Spokeo.fp, personFingerprint(jane));
  assert.equal(readScan(state, 'Spokeo', jane, 1).outcome, 'found');
  // each identity field on its own makes it someone else's record
  for (const changed of [{ zip: '90210' }, { email: 'other@example.org' }, { firstName: 'Janet' }, { lastName: 'Simple' }]) {
    assert.equal(readScan(state, 'Spokeo', { ...jane, ...changed }, 1), undefined, JSON.stringify(changed));
  }
});

test('the identity fingerprint does not cover the state or the full name: that is the search hash\'s job (S1)', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'not_found', at: daysBefore(1), searchHash: searchHash('https://x.example/TX') });
  const moved = { ...jane, state: 'CA', fullName: 'Jane Q Sample' };
  assert.ok(readScan(state, 'Spokeo', moved, 1), 'the record is still "theirs" by fingerprint');
  const d = decideFoundOnly({
    scan: readScan(state, 'Spokeo', moved, 1), searchable: true, validated: true, config: {}, now: NOW,
    searchHash: searchHash('https://x.example/CA'),
  });
  assert.equal(d.basis, 'missing', 'but it was made for a different search, so it is not trusted');
});

test('recordScan keeps a short, bounded history and remembers the last time a listing was seen', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'found', at: daysBefore(40), listingUrl: 'https://s.example/a' });
  for (let i = 0; i < SCAN_HISTORY_MAX + 5; i++) {
    recordScan(state, ref('Spokeo'), { outcome: 'not_found', at: daysBefore(30 - i) });
  }
  const entry = state.scans.Spokeo;
  assert.equal(entry.history.length, SCAN_HISTORY_MAX);
  assert.equal(entry.outcome, 'not_found');
  assert.equal(entry.lastFoundAt, daysBefore(40), 'a later not_found must not erase the sighting');
  assert.equal(entry.listingUrl, undefined, 'a not_found result carries no listing url');
});

test('recordScan never stores an unknown as anything but unknown, with its reason', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'unknown', at: daysBefore(1), reason: 'search failed: bot wall' });
  assert.equal(state.scans.Spokeo.outcome, 'unknown');
  assert.equal(state.scans.Spokeo.reason, 'search failed: bot wall');
  assert.throws(() => recordScan(state, ref('Spokeo'), { outcome: 'clear', at: daysBefore(1) }), /outcome/);
});

test('readScan: persons[0] still finds a scan written under the bare key after a second person is added', () => {
  const state = { optOuts: {}, scans: { Spokeo: { at: daysBefore(2), outcome: 'found', listingUrl: 'https://s.example/a' } } };
  assert.equal(readScan(state, 'Spokeo', jane, 2, { persons: [jane, sam] }).outcome, 'found');
  assert.equal(readScan(state, 'Spokeo', sam, 2, { persons: [jane, sam] }), undefined);
});

test('readScan: the newer of the bare and composite entries wins when the person count drops to one', () => {
  const state = { optOuts: {}, scans: {
    Spokeo: { at: daysBefore(60), outcome: 'found' },
    'Spokeo|Jane Sample': { at: daysBefore(3), outcome: 'not_found' },
  } };
  assert.equal(readScan(state, 'Spokeo', jane, 1).outcome, 'not_found');
});

// ── evidence of a listing ────────────────────────────────────────────────────

test('hasSeenListing: a scan that found one, a verify that found one, or neither', () => {
  const scanned = { optOuts: {}, scans: { A: { at: daysBefore(3), outcome: 'not_found', lastFoundAt: daysBefore(50) } } };
  assert.equal(hasSeenListing(scanned, 'A', jane, 1), true);

  const verified = { optOuts: { B: { lastSuccess: daysBefore(20), verifiedStillListedAt: daysBefore(10) } } };
  assert.equal(hasSeenListing(verified, 'B', jane, 1), true);

  const nothing = { optOuts: { C: { lastSuccess: daysBefore(20) } }, scans: { C: { at: daysBefore(3), outcome: 'not_found' } } };
  assert.equal(hasSeenListing(nothing, 'C', jane, 1), false);
  assert.equal(hasSeenListing({ optOuts: {} }, 'D', jane, 1), false);
});

test('hasSeenListing: for a search-form broker a recorded submission is itself a sighting (S3)', () => {
  // The runner reaches recordSuccess for a search-form broker only after its own search found a
  // listing (lib/broker-runner.js returns "Not listed" before the opt-out page otherwise), so a
  // submission made before 2.2, which wrote no scan record, still proves a listing was there.
  const upgraded = { optOuts: { Spokeo: { lastSuccess: daysBefore(20) } } };
  assert.equal(hasSeenListing(upgraded, 'Spokeo', jane, 1, { method: 'search-form' }), true);
});

test('hasSeenListing: a direct-form broker that merely has a search step is not a sighting from lastSuccess (S3)', () => {
  const upgraded = { optOuts: { USPhonebook: { lastSuccess: daysBefore(20) } } };
  assert.equal(hasSeenListing(upgraded, 'USPhonebook', jane, 1, { method: 'direct-form' }), false);
  assert.equal(hasSeenListing(upgraded, 'USPhonebook', jane, 1), false, 'no method given: not assumed');
});

test('hasSeenListing: an old verifiedDeletedAt is not a sighting', () => {
  const legacy = { optOuts: { A: { lastSuccess: daysBefore(20), verifiedDeletedAt: daysBefore(10) } } };
  assert.equal(hasSeenListing(legacy, 'A', jane, 1), false);
});

// ── hasAnyScan ───────────────────────────────────────────────────────────────

test('hasAnyScan: false with no scans, and a sighting made by an ordinary run is not a scan', () => {
  assert.equal(hasAnyScan({ optOuts: {} }), false);
  assert.equal(hasAnyScan({ optOuts: {}, scans: {} }), false);
  assert.equal(hasAnyScan({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found', source: 'run' } } }), false);
  assert.equal(hasAnyScan({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'unknown' } } }), true);
});

test('hasAnyScan: a run\'s sighting written over a real scan does not make the scan disappear', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('A'), { outcome: 'not_found', at: daysBefore(5) });
  recordScan(state, ref('A'), { outcome: 'found', at: daysBefore(1), listingUrl: 'https://a.example/l', source: 'run' });
  assert.equal(state.scans.A.outcome, 'found');
  assert.equal(state.scans.A.lastScanAt, daysBefore(5));
  assert.equal(hasAnyScan(state), true);

  const runOnly = { optOuts: {} };
  recordScan(runOnly, ref('A'), { outcome: 'found', at: daysBefore(1), listingUrl: 'https://a.example/l', source: 'run' });
  recordScan(runOnly, ref('A'), { outcome: 'found', at: daysBefore(0), listingUrl: 'https://a.example/l', source: 'run' });
  assert.equal(hasAnyScan(runOnly), false);
});

// ── the --found-only decision ────────────────────────────────────────────────

// Scans are trusted only for the search they were made with (S1): the fixtures carry the hash of
// the one search the decision is asked about, unless a test sets its own.
const SEARCH = searchHash('https://decide.example/search');
const decide = (over = {}) => decideFoundOnly({
  searchable: true, config: {}, now: NOW, searchHash: SEARCH, validated: true, ...over,
  scan: over.scan ? { sh: SEARCH, ...over.scan } : undefined,
});

test('decideFoundOnly: found in a fresh scan is submitted', () => {
  const d = decide({ scan: { at: daysBefore(2), outcome: 'found', listingUrl: 'https://s.example/a' } });
  assert.equal(d.action, 'submit');
  assert.equal(d.basis, 'found');
});

test('decideFoundOnly: not_found in a fresh scan is skipped, saying so and giving the date of the scan', () => {
  const d = decide({ scan: { at: '2026-11-10T08:00:00.000Z', outcome: 'not_found' } });
  assert.equal(d.action, 'skip');
  assert.equal(d.basis, 'not_found');
  assert.equal(d.reason, 'not listed (scan of 2026-11-10)');
});

test('decideFoundOnly: not_found stays a skip whatever scan.unknown says', () => {
  const d = decide({ scan: { at: daysBefore(2), outcome: 'not_found' }, config: { scan: { unknown: 'submit' } } });
  assert.equal(d.action, 'skip');
});

test('decideFoundOnly: unknown follows scan.unknown (default submit)', () => {
  const scan = { at: daysBefore(2), outcome: 'unknown', reason: 'search failed: bot wall' };
  assert.equal(decide({ scan }).action, 'submit');
  assert.equal(decide({ scan, config: { scan: { unknown: 'submit' } } }).action, 'submit');
  const skipped = decide({ scan, config: { scan: { unknown: 'skip' } } });
  assert.equal(skipped.action, 'skip');
  assert.equal(skipped.basis, 'unknown');
  assert.match(skipped.reason, /could not tell/);
  assert.match(skipped.reason, /bot wall/);
});

test('decideFoundOnly: a missing scan follows scan.unknown', () => {
  assert.equal(decide({}).action, 'submit');
  const skipped = decide({ config: { scan: { unknown: 'skip' } } });
  assert.equal(skipped.action, 'skip');
  assert.equal(skipped.basis, 'missing');
  assert.match(skipped.reason, /never scanned/);
});

test('decideFoundOnly: a broker that cannot be searched follows scan.unknown', () => {
  assert.equal(decide({ searchable: false }).action, 'submit');
  const skipped = decide({ searchable: false, config: { scan: { unknown: 'skip' } } });
  assert.equal(skipped.action, 'skip');
  assert.equal(skipped.basis, 'unsearchable');
  assert.match(skipped.reason, /cannot be searched/);
});

test('decideFoundOnly: a scan older than scan.maxAgeDays (default 30) is stale, even a found or not_found one', () => {
  for (const outcome of ['found', 'not_found']) {
    const old = { at: daysBefore(31), outcome };
    assert.equal(decide({ scan: old }).basis, 'stale', outcome);
    assert.equal(decide({ scan: old }).action, 'submit', 'default policy submits');
    const skipped = decide({ scan: old, config: { scan: { unknown: 'skip' } } });
    assert.equal(skipped.action, 'skip');
    assert.match(skipped.reason, /31 days old/);
  }
});

test('decideFoundOnly: the age limit is the config value, and exactly the limit still counts', () => {
  const config = { scan: { maxAgeDays: 7, unknown: 'skip' } };
  assert.equal(decide({ scan: { at: daysBefore(7), outcome: 'found' }, config }).basis, 'found');
  assert.equal(decide({ scan: { at: daysBefore(8), outcome: 'found' }, config }).basis, 'stale');
  assert.equal(decide({ scan: { at: daysBefore(31), outcome: 'not_found' }, config: { scan: { maxAgeDays: 60 } } }).basis, 'not_found');
});

test('decideFoundOnly: a scan with no usable date is treated as stale, and an unknown outcome as unknown', () => {
  assert.equal(decide({ scan: { outcome: 'found' } }).basis, 'stale');
  assert.equal(decide({ scan: { at: 'not a date', outcome: 'not_found' } }).basis, 'stale');
  assert.equal(decide({ scan: { at: daysBefore(1), outcome: 'weird' } }).basis, 'unknown');
});

// ── applying the decision to a person's broker list ──────────────────────────

const { applyFoundOnly } = require('../lib/scan');

const searchable = (name, extra = {}) => ({ name, method: 'search-form', searchUrl: `https://${name}.example/s`, listingPattern: /x/, searchCheckedAt: '2026-11-17', ...extra });
const hashOf = (name) => searchHash(`https://${name}.example/s`);
const formOnly = (name) => ({ name, method: 'direct-form', optOutUrl: `https://${name}.example/o` });

test('applyFoundOnly: submits found, skips not_found with its reason, and sends the rest through scan.unknown', () => {
  const state = { optOuts: {}, scans: {
    Found: { at: daysBefore(2), outcome: 'found', sh: hashOf('Found') },
    Absent: { at: '2026-11-10T00:00:00.000Z', outcome: 'not_found', sh: hashOf('Absent') },
    Blocked: { at: daysBefore(2), outcome: 'unknown', reason: 'search failed: bot wall', sh: hashOf('Blocked') },
  } };
  const brokers = [searchable('Found'), searchable('Absent'), searchable('Blocked'), searchable('Fresh'), formOnly('Plain')];
  const base = { brokers, person: jane, personCount: 1, persons: [jane], personIndex: 0, state, now: NOW };

  const submitDefault = applyFoundOnly({ ...base, config: {} });
  assert.deepEqual(submitDefault.submit.map(b => b.name), ['Found', 'Blocked', 'Fresh', 'Plain']);
  assert.deepEqual(submitDefault.skipped.map(s => [s.broker.name, s.decision.reason]), [['Absent', 'not listed (scan of 2026-11-10)']]);

  const skipUnknown = applyFoundOnly({ ...base, config: { scan: { unknown: 'skip' } } });
  assert.deepEqual(skipUnknown.submit.map(b => b.name), ['Found']);
  assert.deepEqual(skipUnknown.skipped.map(s => s.broker.name), ['Absent', 'Blocked', 'Fresh', 'Plain']);
  assert.ok(skipUnknown.skipped.every(s => s.decision.reason.length > 0));
});

test('applyFoundOnly: each person is judged on their own scans, and order is kept', () => {
  const state = { optOuts: {}, scans: {
    'A|Jane Sample': { at: daysBefore(1), outcome: 'found', fp: personFingerprint(jane), sh: hashOf('A') },
    'A|Sam Sample': { at: daysBefore(1), outcome: 'not_found', fp: personFingerprint(sam), sh: hashOf('A') },
    'B|Jane Sample': { at: daysBefore(1), outcome: 'not_found', fp: personFingerprint(jane), sh: hashOf('B') },
    'B|Sam Sample': { at: daysBefore(1), outcome: 'found', fp: personFingerprint(sam), sh: hashOf('B') },
  } };
  const brokers = [searchable('A'), searchable('B')];
  const run = (person, personIndex) => applyFoundOnly({ brokers, person, personCount: 2, persons: [jane, sam], personIndex, state, config: {}, now: NOW });
  assert.deepEqual(run(jane, 0).submit.map(b => b.name), ['A']);
  assert.deepEqual(run(sam, 1).submit.map(b => b.name), ['B']);
});
