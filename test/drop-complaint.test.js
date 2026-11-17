/**
 * test/drop-complaint.test.js
 *
 * After the DROP window, `aidr complaints` may draft a complaint to the California
 * agency for a registry broker, but only when a verification found the person still
 * listed AFTER the deadline. The age of the request alone is never enough.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findDropOverdue, buildDropComplaint, DROP_AGENCY } = require('../lib/complaint');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', city: 'Fresno', zip: '93701', email: 'jane@sample.example' };
const BOB = { firstName: 'Bob', lastName: 'Sample', state: 'TX' };
const REGISTRY = { 'acme-data.example': ['CA'], 'vermont-only.example': ['VT'] };
const HOSTS = { 'Acme Data': 'https://www.acme-data.example/optout', 'Vermont Only': 'https://vermont-only.example/x', 'Unlisted': 'https://unlisted.example' };
const hostFor = (name) => HOSTS[name];
const NOW = new Date('2026-12-15T00:00:00Z'); // deadline for a 2026-09-01 request is 2026-11-30

const find = (optOuts, over = {}) => findDropOverdue({
  optOuts,
  drop: { 'Jane Sample': { submittedAt: '2026-09-01' } },
  ...(over.state || {}),
}, { persons: [JANE], registryHosts: REGISTRY, hostFor, now: NOW, ...over.opts });

test('a registry broker still listed after the deadline is drafted', () => {
  const rows = find({ 'Acme Data': { verifiedStillListedAt: '2026-12-02T10:00:00Z' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].broker, 'Acme Data');
  assert.equal(rows[0].submittedAt, '2026-09-01');
  assert.equal(rows[0].deadline, '2026-11-30');
  assert.equal(rows[0].stillListedAt, '2026-12-02T10:00:00Z');
  assert.equal(rows[0].daysOverdue, 15);
});

test('never from the age of the request alone', () => {
  assert.deepEqual(find({ 'Acme Data': { lastSuccess: '2026-09-02T00:00:00Z' } }), []);
  assert.deepEqual(find({}), []);
});

test('a listing seen before the deadline is not evidence', () => {
  assert.deepEqual(find({ 'Acme Data': { verifiedStillListedAt: '2026-11-30T23:00:00Z' } }), []);
  assert.deepEqual(find({ 'Acme Data': { verifiedStillListedAt: '2026-11-15T00:00:00Z' } }), []);
});

test('a later all-clear cancels the evidence', () => {
  assert.deepEqual(find({ 'Acme Data': { verifiedStillListedAt: '2026-12-02T00:00:00Z', verifiedDeletedAt: '2026-12-10T00:00:00Z' } }), []);
});

test('the window must have passed', () => {
  const early = new Date('2026-11-20T00:00:00Z');
  assert.deepEqual(find({ 'Acme Data': { verifiedStillListedAt: '2026-11-25T00:00:00Z' } }, { opts: { now: early } }), []);
});

test('only brokers on the California registry', () => {
  const rows = find({
    'Vermont Only': { verifiedStillListedAt: '2026-12-02T00:00:00Z' },
    'Unlisted': { verifiedStillListedAt: '2026-12-02T00:00:00Z' },
  });
  assert.deepEqual(rows, []);
});

test('only for a California person with a recorded request', () => {
  const listed = { 'Acme Data': { verifiedStillListedAt: '2026-12-02T00:00:00Z' } };
  assert.deepEqual(find(listed, { state: { drop: {} } }), []);
  assert.deepEqual(find(listed, { opts: { persons: [BOB] } }), []);
});

test('multi-person keys name the person; an unknown person is skipped', () => {
  const listed = { 'Acme Data|Jane Sample': { verifiedStillListedAt: '2026-12-02T00:00:00Z' }, 'Acme Data|Ghost Person': { verifiedStillListedAt: '2026-12-02T00:00:00Z' } };
  const rows = find(listed, { opts: { persons: [JANE, BOB] } });
  assert.deepEqual(rows.map(r => r.person), ['Jane Sample']);
});

test('the complaint cites the statute, the window, the evidence date and the form URL', () => {
  const [row] = find({ 'Acme Data': { verifiedStillListedAt: '2026-12-02T10:00:00Z' } });
  const c = buildDropComplaint({ person: JANE, broker: { name: 'Acme Data', optOutUrl: HOSTS['Acme Data'] }, overdue: row });
  assert.equal(c.agency, DROP_AGENCY);
  assert.match(c.body, /1798\.99\.86\(c\)\(1\)/);
  assert.ok(c.body.includes('https://cppa.ca.gov/webapplications/complaint'));
  assert.match(c.body, /2026-09-01/);
  assert.match(c.body, /2026-11-30/);
  assert.match(c.body, /2026-12-02/);
  assert.match(c.body, /Jane Sample/);
  assert.match(c.body, /DROP/);
});

test('buildDropComplaint refuses to assert a listing it has no evidence for', () => {
  assert.throws(() => buildDropComplaint({ person: JANE, broker: { name: 'Acme Data' }, overdue: { submittedAt: '2026-09-01', deadline: '2026-11-30' } }), /still listed/);
});

test('a shrunken household: the bare entry and the labelled one are one request, the latest evidence wins (D7)', () => {
  const stale = { verifiedStillListedAt: '2026-12-02T10:00:00Z' };
  const gone = { verifiedDeletedAt: '2026-12-10T10:00:00Z' };
  assert.deepEqual(find({ 'Acme Data|Jane Sample': stale, 'Acme Data': gone }), [], 'cleared later than it was seen: no complaint');
  assert.deepEqual(find({ 'Acme Data': gone, 'Acme Data|Jane Sample': stale }), [], 'order of the keys does not matter');
  const rows = find({
    'Acme Data|Jane Sample': { verifiedStillListedAt: '2026-12-12T10:00:00Z' },
    'Acme Data': { verifiedStillListedAt: '2026-12-02T10:00:00Z', verifiedDeletedAt: '2026-12-10T10:00:00Z' },
  });
  assert.equal(rows.length, 1, 'seen again after the clear: one complaint, not two');
  assert.equal(rows[0].stillListedAt, '2026-12-12T10:00:00Z');
});

test('the evidence boundary is past midnight in California: 08:00 UTC on the day after the deadline (D8)', () => {
  const at = (stamp) => find({ 'Acme Data': { verifiedStillListedAt: stamp } });
  assert.deepEqual(at('2026-12-01T06:59:00Z'), [], 'still the deadline day in California (daylight or standard time)');
  assert.deepEqual(at('2026-12-01T07:59:00Z'), [], 'before 08:00 UTC');
  assert.equal(at('2026-12-01T08:00:00Z').length, 1, 'at 08:00 UTC it counts');
  assert.equal(at('2026-12-02T00:00:00Z').length, 1);
});

test('the window is not over until that same boundary has passed', () => {
  const listed = { 'Acme Data': { verifiedStillListedAt: '2026-12-02T00:00:00Z' } };
  const justBefore = new Date('2026-12-01T07:59:00Z');
  const justAfter = new Date('2026-12-01T08:00:00Z');
  assert.deepEqual(find(listed, { opts: { now: justBefore } }), []);
  assert.equal(find({ 'Acme Data': { verifiedStillListedAt: '2026-12-01T08:00:00Z' } }, { opts: { now: justAfter } }).length, 1);
});
