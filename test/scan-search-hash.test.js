/**
 * S1: a scan result is tied to the exact search that was made. The record carries a
 * one-way hash of the search URL (never the URL: it holds the person's name), and a
 * record whose hash is not the person's current search for that broker counts as
 * "never scanned". A search whose inputs are blank is "could not tell", never "not found".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordScan, readScan, decideFoundOnly, applyFoundOnly, runScan } = require('../lib/scan');
const { searchHash } = require('../lib/identity');
const brokers = require('../brokers');

// A person written as the config has them: with the state and the full name the search URLs use.
const jane = { firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', state: 'TX', zip: '78701', email: 'jane@example.org' };
const janeInCA = { ...jane, state: 'CA' };
const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// USPhonebook is the one searchable broker whose search step was validated live, so its
// "not listed" is the kind that can drive a skip.
const spokeoFor = (person) => brokers.forPerson(person).find(b => b.name === 'USPhonebook');
const realSpokeoFor = (person) => brokers.forPerson(person).find(b => b.name === 'Spokeo');
const ref = (brokerName, person = jane) => ({ brokerName, person, personCount: 1, persons: [person], personIndex: 0 });

const makeContext = () => ({ newPage: async () => ({ close: async () => {} }) });

test('searchHash is a short one-way digest: equal for equal URLs, different otherwise, and not the URL', () => {
  const url = 'https://www.spokeo.com/search?q=Jane%20Sample&type=pp&state=TX';
  assert.equal(searchHash(url), searchHash(url));
  assert.notEqual(searchHash(url), searchHash(url.replace('TX', 'CA')));
  assert.match(searchHash(url), /^[0-9a-f]{16}$/);
  assert.doesNotMatch(searchHash(url), /jane|sample|spokeo/i);
  assert.equal(searchHash(''), null);
  assert.equal(searchHash(undefined), null);
});

test('the scan record carries the hash of the search it made and never the search URL', async () => {
  const state = { optOuts: {} };
  const broker = spokeoFor(jane);
  await runScan(makeContext(), [broker], [jane], {
    state, brokersFor: (p) => [spokeoFor(p)], findUrl: async () => null, now: NOW,
  });
  const record = state.scans.USPhonebook;
  assert.equal(record.sh, searchHash(broker.searchUrl));
  const stored = JSON.stringify(state);
  assert.doesNotMatch(stored, /Jane(%20|\+| |-)Sample/i);
  assert.doesNotMatch(stored, /search\?q=/);
});

test('S1 scenario: scanned with the wrong state, the fixed state is "never scanned" and is submitted', async () => {
  const state = { optOuts: {} };
  await runScan(makeContext(), [spokeoFor(jane)], [jane], {
    state, brokersFor: (p) => [spokeoFor(p)], findUrl: async () => null, now: new Date(daysBefore(3)),
  });
  assert.equal(state.scans.USPhonebook.outcome, 'not_found');

  const run = (person, config = {}) => applyFoundOnly({
    brokers: [spokeoFor(person)], person, personCount: 1, persons: [person], personIndex: 0, state, config, now: NOW,
  });
  assert.equal(run(jane).skipped.length, 1, 'the search that was made still counts');

  const fixed = run(janeInCA);
  assert.equal(fixed.skipped.length, 0, 'a search that was never made cannot say "not listed"');
  assert.equal(fixed.submit.length, 1);
  const strict = run(janeInCA, { scan: { unknown: 'skip' } });
  assert.equal(strict.skipped[0].decision.basis, 'missing');
  assert.match(strict.skipped[0].decision.reason, /never scanned/);
});

test('a changed full name is a different search too', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('Spokeo'), { outcome: 'not_found', at: daysBefore(2), searchHash: searchHash(realSpokeoFor(jane).searchUrl) });
  const basisFor = (person) => applyFoundOnly({
    brokers: [realSpokeoFor(person)], person, personCount: 1, persons: [person], personIndex: 0, state,
    config: { scan: { unknown: 'skip' } }, now: NOW,
  }).skipped[0].decision.basis;
  assert.equal(basisFor(jane), 'unvalidated', 'the same search: the record is read (and, for Spokeo, not trusted for a skip)');
  assert.equal(basisFor({ ...jane, fullName: 'Jane Q Sample' }), 'missing', 'another name: nothing ever searched for it');
});

test('a record written without a hash (older code) counts as never scanned', () => {
  const current = searchHash('https://example.test/search');
  const legacy = { at: daysBefore(2), outcome: 'not_found' };
  const d = decideFoundOnly({ scan: legacy, searchable: true, config: { scan: { unknown: 'skip' } }, now: NOW, searchHash: current });
  assert.equal(d.basis, 'missing');
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /never scanned/);
  assert.equal(decideFoundOnly({ scan: legacy, searchable: true, config: {}, now: NOW, searchHash: current }).action, 'submit');
});

test('a matching hash is trusted as before', () => {
  const h = searchHash('https://example.test/search');
  const scan = (outcome) => ({ at: daysBefore(2), outcome, sh: h });
  const decide = (outcome) => decideFoundOnly({ scan: scan(outcome), searchable: true, config: {}, now: NOW, searchHash: h, validated: true });
  assert.equal(decide('found').action, 'submit');
  assert.equal(decide('not_found').action, 'skip');
});

test('a sighting from a search that was since changed is not carried into the new one', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('USPhonebook'), { outcome: 'found', at: daysBefore(10), listingUrl: 'https://s.example/a', searchHash: 'aaaaaaaaaaaaaaaa' });
  recordScan(state, ref('USPhonebook'), { outcome: 'not_found', at: daysBefore(1), searchHash: 'bbbbbbbbbbbbbbbb' });
  assert.equal(state.scans.USPhonebook.lastFoundAt, undefined);
  assert.equal(state.scans.USPhonebook.sh, 'bbbbbbbbbbbbbbbb');
});

test('a result with no hash of its own (the list could not be built) keeps the old hash and sighting', () => {
  const state = { optOuts: {} };
  recordScan(state, ref('USPhonebook'), { outcome: 'found', at: daysBefore(10), listingUrl: 'https://s.example/a', searchHash: 'aaaaaaaaaaaaaaaa' });
  recordScan(state, ref('USPhonebook'), { outcome: 'unknown', at: daysBefore(1), reason: 'could not build broker list' });
  assert.equal(state.scans.USPhonebook.sh, 'aaaaaaaaaaaaaaaa');
  assert.equal(state.scans.USPhonebook.lastFoundAt, daysBefore(10));
  assert.equal(readScan(state, 'USPhonebook', jane, 1).outcome, 'unknown');
});

test('blank search inputs: "could not tell" with a reason that names the missing detail, never not_found', async () => {
  const handWritten = { firstName: 'Jane', lastName: 'Sample', zip: '78701', email: 'jane@example.org' };
  const state = { optOuts: {} };
  let searched = 0;
  const result = await runScan(makeContext(), [realSpokeoFor(handWritten)], [handWritten], {
    state, brokersFor: (p) => [realSpokeoFor(p)], findUrl: async () => { searched += 1; return null; }, now: NOW,
  });
  assert.equal(searched, 0, 'a search that cannot name the person is not made');
  assert.equal(result.not_found.length, 0);
  assert.equal(result.unknown.length, 1);
  assert.match(result.unknown[0].reason, /fullName/);
  assert.match(result.unknown[0].reason, /state/);
  assert.equal(state.scans.Spokeo.outcome, 'unknown');
});

test('only a blank detail the search URL uses stops the search', async () => {
  const noState = { ...jane, state: '' };
  const state = { optOuts: {} };
  const wp = (p) => brokers.forPerson(p).find(b => b.name === 'WhitePages');
  const result = await runScan(makeContext(), [wp(noState)], [noState], {
    state, brokersFor: (p) => [wp(p)], findUrl: async () => null, now: NOW,
  });
  assert.equal(result.unknown.length, 1);
  assert.match(result.unknown[0].reason, /state/);
  assert.doesNotMatch(result.unknown[0].reason, /firstName|lastName/);
});

test('every searchable broker says which details its search URL uses', () => {
  for (const b of brokers.forPerson(jane).filter(x => x.searchUrl && x.listingPattern)) {
    assert.ok(Array.isArray(b.searchNeeds) && b.searchNeeds.length > 0, `${b.name} must declare searchNeeds`);
    for (const field of b.searchNeeds) assert.ok(['firstName', 'lastName', 'fullName', 'state'].includes(field), `${b.name}: ${field}`);
  }
});
