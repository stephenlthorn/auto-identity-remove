/**
 * S8: only a broker whose search step was validated live (searchCheckedAt, both
 * directions) may make `--found-only` skip it as "not listed". For any other broker an
 * empty result is "no listing seen", which follows scan.unknown; a `found` from any
 * searchable broker is still used, because that direction is safe.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideFoundOnly, applyFoundOnly, runScan } = require('../lib/scan');
const { searchHash } = require('../lib/identity');
const { scanReportLines } = require('../lib/scan-report');
const brokers = require('../brokers');

const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const SEARCH = searchHash('https://x.example/search');
const jane = { firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', state: 'TX', zip: '78701', email: 'jane@example.org' };

const decide = (over) => decideFoundOnly({ searchable: true, config: {}, now: NOW, searchHash: SEARCH, ...over });
const scanOf = (outcome, extra = {}) => ({ at: daysBefore(2), outcome, sh: SEARCH, ...extra });

test('a not_found from a search that was not validated follows scan.unknown, and says why', () => {
  const submit = decide({ scan: scanOf('not_found'), validated: false });
  assert.equal(submit.action, 'submit', 'the default policy submits');
  assert.equal(submit.basis, 'unvalidated');
  const skip = decide({ scan: scanOf('not_found'), validated: false, config: { scan: { unknown: 'skip' } } });
  assert.equal(skip.action, 'skip');
  assert.match(skip.reason, /search step has not been validated/);
});

test('a not_found from a validated search still skips, whatever scan.unknown says', () => {
  const d = decide({ scan: scanOf('not_found'), validated: true, config: { scan: { unknown: 'submit' } } });
  assert.equal(d.action, 'skip');
  assert.equal(d.basis, 'not_found');
});

test('a found from a search that was not validated is used: that direction is safe', () => {
  const d = decide({ scan: scanOf('found'), validated: false, config: { scan: { unknown: 'skip' } } });
  assert.equal(d.action, 'submit');
  assert.equal(d.basis, 'found');
});

test('validation is asked of the broker entry: only USPhonebook has searchCheckedAt today', () => {
  const state = { optOuts: {}, scans: {} };
  const list = brokers.forPerson(jane).filter(b => b.searchUrl && b.listingPattern);
  for (const b of list) state.scans[b.name] = { at: daysBefore(1), outcome: 'not_found', sh: searchHash(b.searchUrl) };
  const plan = applyFoundOnly({
    brokers: list, person: jane, personCount: 1, persons: [jane], personIndex: 0, state, config: { scan: { unknown: 'skip' } }, now: NOW,
  });
  const reasons = Object.fromEntries(plan.skipped.map(s => [s.broker.name, s.decision.reason]));
  assert.match(reasons.USPhonebook, /^not listed \(scan of /);
  for (const name of ['Spokeo', 'WhitePages', 'FastPeopleSearch', 'MyLife', 'Nuwber']) {
    assert.match(reasons[name], /has not been validated/, name);
  }
  const submitDefault = applyFoundOnly({
    brokers: list, person: jane, personCount: 1, persons: [jane], personIndex: 0, state, config: {}, now: NOW,
  });
  assert.deepEqual(submitDefault.skipped.map(s => s.broker.name), ['USPhonebook']);
});

// ── the scan itself ──────────────────────────────────────────────────────────

const makeContext = () => ({ newPage: async () => ({ close: async () => {} }) });
const searchBroker = (name, extra = {}) => ({
  name, method: 'search-form', searchUrl: `https://${name.toLowerCase()}.example/search`, listingPattern: /listing/i, ...extra,
});

test('runScan keeps an empty result from an unvalidated search apart from "not found"', async () => {
  const state = { optOuts: {} };
  const result = await runScan(makeContext(), [
    searchBroker('Checked', { searchCheckedAt: '2026-11-17' }),
    searchBroker('Unchecked'),
  ], [jane], { state, findUrl: async () => null, now: NOW });
  assert.deepEqual(result.not_found.map(e => e.broker), ['Checked']);
  assert.deepEqual(result.unvalidated.map(e => e.broker), ['Unchecked']);
  assert.equal(state.scans.Unchecked.outcome, 'not_found', 'the record is the plain fact: the search showed no listing');
});

test('the scan report lists those apart, under their own heading, never as "Where you were not found"', () => {
  const lines = scanReportLines({
    found: [], not_found: [{ broker: 'Checked' }], unvalidated: [{ broker: 'Unchecked' }],
    unknown: [], unsearchable: [], skipped: [],
  }, { interactive: false, label: (e) => e.broker, many: false });
  const text = lines.join('\n');
  assert.match(text, /Where you were not found:\n\s+Checked/);
  assert.match(text, /No listing seen, but this site's search is not validated:\n\s+Unchecked/);
  assert.doesNotMatch(text.split('No listing seen')[0], /Unchecked/);
});
