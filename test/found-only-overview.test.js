/**
 * S2: `--found-only` says what the scan gave it to go by, per person, before it starts, and
 * refuses to start only when NO person has any usable result (a record that is stale, could
 * not tell, or was made for other details is not one).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyFoundOnly, hasUsableScan } = require('../lib/scan');
const { foundOnlyOverview } = require('../lib/scan-report');
const { searchHash } = require('../lib/identity');

const NOW = new Date('2026-11-17T12:00:00.000Z');
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const jane = { firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', state: 'TX', zip: '78701', email: 'jane@example.org' };
const sam = { firstName: 'Sam', lastName: 'Other', fullName: 'Sam Other', state: 'CA', zip: '90210', email: 'sam@example.org' };

const searchable = (name, extra = {}) => ({ name, method: 'search-form', searchUrl: `https://${name}.example/s`, listingPattern: /x/, searchCheckedAt: '2026-11-17', ...extra });
const formOnly = (name) => ({ name, method: 'direct-form', optOutUrl: `https://${name}.example/o` });
const sh = (name) => searchHash(`https://${name}.example/s`);

const plan = (over) => applyFoundOnly({
  person: jane, personCount: 1, persons: [jane], personIndex: 0, state: { optOuts: {}, scans: {} }, config: {}, now: NOW, ...over,
});

test('the plan keeps one decision per broker, with the basis', () => {
  const state = { optOuts: {}, scans: {
    A: { at: daysBefore(1), outcome: 'found', sh: sh('A') },
    B: { at: daysBefore(1), outcome: 'not_found', sh: sh('B') },
    C: { at: daysBefore(31), outcome: 'found', sh: sh('C') },
    D: { at: daysBefore(1), outcome: 'unknown', reason: 'bot wall', sh: sh('D') },
  } };
  const p = plan({ brokers: [searchable('A'), searchable('B'), searchable('C'), searchable('D'), searchable('E'), formOnly('F')], state });
  assert.deepEqual(p.decisions.map(d => [d.broker.name, d.decision.basis]), [
    ['A', 'found'], ['B', 'not_found'], ['C', 'stale'], ['D', 'unknown'], ['E', 'missing'], ['F', 'unsearchable'],
  ]);
});

test('the overview line counts what is submitted and skipped and WHY the rest follows scan.unknown', () => {
  const state = { optOuts: {}, scans: {
    A: { at: daysBefore(1), outcome: 'found', sh: sh('A') },
    B: { at: daysBefore(1), outcome: 'not_found', sh: sh('B') },
    C: { at: daysBefore(31), outcome: 'found', sh: sh('C') },
    D: { at: daysBefore(1), outcome: 'unknown', reason: 'bot wall', sh: sh('D') },
  } };
  const p = plan({ brokers: [searchable('A'), searchable('B'), searchable('C'), searchable('D'), searchable('E'), formOnly('F'), formOnly('G')], state });
  const text = foundOnlyOverview({ plan: p, config: {}, name: '' }).join('\n');
  assert.match(text, /1 listed/);
  assert.match(text, /1 not listed \(skipped\)/);
  assert.match(text, /1 scan too old/);
  assert.match(text, /1 could not tell/);
  assert.match(text, /1 never scanned/);
  assert.match(text, /2 cannot be searched/);
  assert.match(text, /scan\.unknown is "submit"/);
  assert.doesNotMatch(text, /no usable scan result/);
});

test('the overview names the person when there are several, and says "skipped" under skip', () => {
  const p = plan({ brokers: [searchable('A'), formOnly('F')], state: { optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found', sh: sh('A') } } } });
  const text = foundOnlyOverview({ plan: p, config: { scan: { unknown: 'skip' } }, name: 'Jane Sample' }).join('\n');
  assert.match(text, /Jane Sample/);
  assert.match(text, /scan\.unknown is "skip"/);
});

test('zero usable results is said plainly, with what to do', () => {
  const state = { optOuts: {}, scans: {
    A: { at: daysBefore(31), outcome: 'found', sh: sh('A') },
    B: { at: daysBefore(1), outcome: 'unknown', reason: 'bot wall', sh: sh('B') },
  } };
  const p = plan({ brokers: [searchable('A'), searchable('B'), searchable('C'), formOnly('F')], state });
  const text = foundOnlyOverview({ plan: p, config: {}, name: 'Jane Sample' }).join('\n');
  assert.match(text, /Jane Sample has no usable scan result/);
  assert.match(text, /run `aidr scan` again/i);
  assert.match(text, /1 scan too old/);
  assert.match(text, /1 could not tell/);
});

test('an overview never carries a search address', () => {
  const p = plan({ brokers: [searchable('A')], state: { optOuts: {}, scans: {} } });
  assert.doesNotMatch(foundOnlyOverview({ plan: p, config: {}, name: '' }).join('\n'), /https?:|\.example/);
});

// ── the gate ─────────────────────────────────────────────────────────────────

const gate = (state, persons = [jane], config = {}) => hasUsableScan({
  brokersFor: (p) => [searchable('A', { searchUrl: `https://A.example/s?${p.state}` }), searchable('B'), formOnly('F')],
  persons, state, config, now: NOW,
});
const shFor = (p) => searchHash(`https://A.example/s?${p.state}`);

test('gate: stale, could-not-tell and other-details records are not usable; a fresh found or not_found is', () => {
  assert.equal(gate({ optOuts: {} }), false);
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(31), outcome: 'found', sh: shFor(jane) } } }), false, 'stale');
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'unknown', sh: shFor(jane) } } }), false, 'could not tell');
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found', sh: 'ffffffffffffffff' } } }), false, 'another search');
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found' } } }), false, 'older version, no hash');
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found', sh: shFor(jane) } } }), true);
  assert.equal(gate({ optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'not_found', sh: shFor(jane) } } }), true);
});

test('gate: a sighting made only by an ordinary run is not a scan', () => {
  const state = { optOuts: {}, scans: { A: { at: daysBefore(1), outcome: 'found', source: 'run', sh: shFor(jane) } } };
  assert.equal(gate(state), false);
});

test('gate: one person with a usable result is enough', () => {
  const state = { optOuts: {}, scans: { 'A|Jane Sample': { at: daysBefore(1), outcome: 'found', sh: shFor(jane) } } };
  assert.equal(gate(state, [jane, sam]), true);
  assert.equal(gate({ optOuts: {}, scans: {} }, [jane, sam]), false);
});
