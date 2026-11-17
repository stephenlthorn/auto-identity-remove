/**
 * test/drop.test.js
 *
 * lib/drop.js: California's DROP (Delete Request and Opt-out Platform). The tool
 * cannot submit a request (identity verification is done by the state), so this
 * module only records that the person did, keeps the legal clock, and answers
 * "is this broker already covered by that request?".
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drop = require('../lib/drop');
const cfg = require('../lib/config');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', country: 'US' };
const BOB = { firstName: 'Bob', lastName: 'Sample', state: 'TX' };
const REGISTRY = { 'acme-data.example': ['CA'], 'other.example': ['CA', 'VT'], 'vermont-only.example': ['VT'] };

test('the statute window is 45 + 45 days and the constants say so', () => {
  assert.equal(drop.PICKUP_DAYS, 45);
  assert.equal(drop.DELETE_DAYS, 45);
  assert.equal(drop.WINDOW_DAYS, 90);
  assert.equal(drop.BROKERS_START_DAY, '2026-08-01');
  assert.equal(drop.DROP_URL, 'https://consumer.drop.privacy.ca.gov');
  assert.equal(drop.COMPLAINT_URL, 'https://cppa.ca.gov/webapplications/complaint');
});

test('isCaliforniaResident: CA or California in any case, US or unset country', () => {
  for (const state of ['CA', 'ca', 'California', ' california ', 'CALIFORNIA']) {
    assert.equal(drop.isCaliforniaResident({ state }), true, state);
    assert.equal(drop.isCaliforniaResident({ state, country: 'us' }), true, state);
  }
  assert.equal(drop.isCaliforniaResident({ state: 'CA', country: 'CA' }), false, 'Canada, not California');
  assert.equal(drop.isCaliforniaResident({ state: 'CA', country: 'GB' }), false);
  assert.equal(drop.isCaliforniaResident({ state: 'TX' }), false);
  assert.equal(drop.isCaliforniaResident({}), false);
  assert.equal(drop.isCaliforniaResident(null), false);
});

test('dropDeadline: submitted day + 90, but never earlier than 2026-08-01 + 90', () => {
  assert.equal(drop.dropDeadline('2026-09-01'), '2026-11-30');
  assert.equal(drop.dropDeadline('2026-08-01'), '2026-10-30');
  assert.equal(drop.dropDeadline('2026-01-15'), '2026-10-30', 'the broker clock starts on 2026-08-01');
  assert.equal(drop.dropDeadline('2026-07-31'), '2026-10-30');
});

test('parseDay accepts only real YYYY-MM-DD dates', () => {
  assert.notEqual(drop.parseDay('2026-09-01'), null);
  for (const bad of ['2026-9-1', '2026-02-30', 'yesterday', '', null, undefined, '2026-09-01T00:00:00Z']) {
    assert.equal(drop.parseDay(bad), null, String(bad));
  }
});

test('checkSubmittedDay refuses the future and anything before DROP opened', () => {
  const today = '2026-11-17';
  assert.equal(drop.checkSubmittedDay('2026-11-17', today).ok, true);
  assert.equal(drop.checkSubmittedDay('2026-01-01', today).ok, true);
  assert.match(drop.checkSubmittedDay('2026-11-18', today).error, /future/);
  assert.match(drop.checkSubmittedDay('2025-12-31', today).error, /2026-01-01/);
  assert.match(drop.checkSubmittedDay('last week', today).error, /YYYY-MM-DD/);
});

test('recording is per person and leaves optOuts alone; clearing removes only that person', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: '2026-09-01T00:00:00Z' } } };
  const saved = [];
  const save = () => saved.push(JSON.stringify(state));
  const jane2 = { firstName: 'Janet', lastName: 'Sample', state: 'CA' };

  drop.recordDropRequest(state, JANE, '2026-09-01', { save });
  drop.recordDropRequest(state, jane2, '2026-09-05', { save });
  assert.deepEqual(drop.getDropRequest(state, JANE), { submittedAt: '2026-09-01' });
  assert.deepEqual(drop.getDropRequest(state, jane2), { submittedAt: '2026-09-05' });
  assert.equal(drop.getDropRequest(state, BOB), null);
  assert.deepEqual(state.optOuts, { Spokeo: { lastSuccess: '2026-09-01T00:00:00Z' } });
  assert.equal(saved.length, 2);

  drop.clearDropRequest(state, JANE, { save });
  assert.equal(drop.getDropRequest(state, JANE), null);
  assert.deepEqual(drop.getDropRequest(state, jane2), { submittedAt: '2026-09-05' });
  assert.equal(saved.length, 3);
});

test('recording persists through the real state file, like --freeze-done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-drop-'));
  try {
    cfg.setTestStatePath(path.join(dir, 'state.json'));
    cfg.resetState();
    const state = cfg.loadState();
    drop.recordDropRequest(state, JANE, '2026-09-01');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.drop, { 'Jane Sample': { submittedAt: '2026-09-01' } });
  } finally {
    cfg.setTestStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged drop record is treated as no record', () => {
  assert.equal(drop.getDropRequest({ drop: { 'Jane Sample': { submittedAt: 'soon' } } }, JANE), null);
  assert.equal(drop.getDropRequest({ drop: 'x' }, JANE), null);
  assert.equal(drop.getDropRequest(null, JANE), null);
});

test('dropStatus: none, waiting (with the deadline) and passed', () => {
  const none = drop.dropStatus({ state: {}, person: JANE, today: '2026-11-17' });
  assert.deepEqual(none, { kind: 'none' });

  const state = { drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
  const waiting = drop.dropStatus({ state, person: JANE, today: '2026-11-17' });
  assert.deepEqual(waiting, { kind: 'waiting', submittedAt: '2026-09-01', deadline: '2026-11-30' });
  assert.equal(drop.dropStatus({ state, person: JANE, today: '2026-11-30' }).kind, 'waiting', 'the deadline day itself is still inside the window');
  const passed = drop.dropStatus({ state, person: JANE, today: '2026-12-01' });
  assert.deepEqual(passed, { kind: 'passed', submittedAt: '2026-09-01', deadline: '2026-11-30' });
});

test('loadRegistryHosts: reads registryHosts, and a missing file or key is an empty map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-drop-'));
  try {
    const file = path.join(dir, 'feeds-brokers.json');
    assert.deepEqual(drop.loadRegistryHosts({ filePath: file }), {});
    fs.writeFileSync(file, JSON.stringify([{ name: 'x' }]));
    assert.deepEqual(drop.loadRegistryHosts({ filePath: file }), {}, 'the old array shape has no registryHosts');
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(drop.loadRegistryHosts({ filePath: file }), {});
    fs.writeFileSync(file, JSON.stringify({ rows: [], registryHosts: REGISTRY }));
    assert.deepEqual(drop.loadRegistryHosts({ filePath: file }), REGISTRY);
    fs.writeFileSync(file, JSON.stringify({ registryHosts: { 'WWW.Acme-Data.example': ['ca'], 'bad.example': 'CA', 'worse.example': [] } }));
    assert.deepEqual(drop.loadRegistryHosts({ filePath: file }), { 'acme-data.example': ['CA'] }, 'normalised; malformed rows dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('californiaDomains counts only domains whose codes include CA', () => {
  assert.deepEqual([...drop.californiaDomains(REGISTRY)].sort(), ['acme-data.example', 'other.example']);
  assert.equal(drop.californiaDomains({}).size, 0);
});

const STATE_WITH_DROP = { drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
const covered = (over = {}) => drop.isCoveredByDrop({
  person: JANE, state: STATE_WITH_DROP, config: {}, host: 'acme-data.example', registryHosts: REGISTRY, ...over,
});

test('isCoveredByDrop: California resident + recorded request + registry domain', () => {
  assert.equal(covered(), true);
  assert.equal(covered({ host: 'privacy.www.acme-data.example' }), true, 'a subdomain is the same registrable domain');
  assert.equal(covered({ host: 'www.other.example' }), true);
});

test('isCoveredByDrop is false when any condition is missing', () => {
  assert.equal(covered({ person: BOB, state: { drop: { 'Bob Sample': { submittedAt: '2026-09-01' } } } }), false, 'not a California resident');
  assert.equal(covered({ state: {} }), false, 'no recorded request');
  assert.equal(covered({ host: 'vermont-only.example' }), false, 'not on the California registry');
  assert.equal(covered({ host: 'unlisted.example' }), false);
  assert.equal(covered({ registryHosts: {} }), false, 'empty registry covers nothing');
  assert.equal(covered({ host: '' }), false);
});

test('drop.alsoSubmit: true turns coverage off, any other value does not', () => {
  assert.equal(covered({ config: { drop: { alsoSubmit: true } } }), false);
  assert.equal(covered({ config: { drop: { alsoSubmit: false } } }), true);
  assert.equal(covered({ config: { drop: { alsoSubmit: 'true' } } }), true, 'only the boolean true counts');
});

test('coverageReason names the date; makeCoveredByDrop works on generic rows by url', () => {
  const fn = drop.makeCoveredByDrop({ person: JANE, state: STATE_WITH_DROP, config: {}, registryHosts: REGISTRY });
  assert.equal(fn({ name: 'Acme Data', url: 'https://www.acme-data.example/optout' }), 'covered by your DROP request of 2026-09-01');
  assert.equal(fn({ name: 'Elsewhere', url: 'https://elsewhere.example/optout' }), null);
  assert.equal(fn({ name: 'No url' }), null);
});

test('makeCoveredByDrop returns null when it can never cover anything (no state work for other people)', () => {
  assert.equal(drop.makeCoveredByDrop({ person: BOB, state: {}, config: {}, registryHosts: REGISTRY }), null);
  assert.equal(drop.makeCoveredByDrop({ person: JANE, state: STATE_WITH_DROP, config: { drop: { alsoSubmit: true } }, registryHosts: REGISTRY }), null);
  assert.equal(drop.makeCoveredByDrop({ person: JANE, state: STATE_WITH_DROP, config: {}, registryHosts: {} }), null);
});

test('dropConfigProblems: only a non-boolean alsoSubmit is a problem', () => {
  assert.deepEqual(drop.dropConfigProblems({}), []);
  assert.deepEqual(drop.dropConfigProblems({ drop: { alsoSubmit: true } }), []);
  assert.deepEqual(drop.dropConfigProblems({ drop: { alsoSubmit: false } }), []);
  assert.match(drop.dropConfigProblems({ drop: { alsoSubmit: 'yes' } })[0], /drop\.alsoSubmit must be true or false/);
  assert.match(drop.dropConfigProblems({ drop: 'x' })[0], /drop must be an object/);
});

test('describeDrop: not recorded, waiting and passed, for a California person', () => {
  const none = drop.describeDrop({ person: JANE, state: {}, registryCount: 625, today: '2026-11-17' }).join('\n');
  assert.match(none, /Delete Request and Opt-out Platform/);
  assert.match(none, /https:\/\/consumer\.drop\.privacy\.ca\.gov/);
  assert.match(none, /name, date of birth and email/);
  assert.match(none, /not recorded yet/);
  assert.match(none, /625/);

  const waiting = drop.describeDrop({ person: JANE, state: STATE_WITH_DROP, registryCount: 625, today: '2026-11-17' }).join('\n');
  assert.match(waiting, /submitted on 2026-09-01/);
  assert.match(waiting, /brokers have until 2026-11-30/);

  const passed = drop.describeDrop({ person: JANE, state: STATE_WITH_DROP, registryCount: 625, today: '2026-12-05' }).join('\n');
  assert.match(passed, /the window passed on 2026-11-30/);
  assert.match(passed, /aidr verify/);
});

test('describeDrop tells you to run update-brokers when no registry is known', () => {
  const text = drop.describeDrop({ person: JANE, state: {}, registryCount: 0, today: '2026-11-17' }).join('\n');
  assert.match(text, /aidr update-brokers/);
  assert.doesNotMatch(text, /\b0 registered/);
});

test('describeDrop for someone outside California says so and nothing else', () => {
  const text = drop.describeDrop({ person: BOB, state: {}, registryCount: 625, today: '2026-11-17' }).join('\n');
  assert.match(text, /for California residents/);
  assert.doesNotMatch(text, /consumer\.drop/);
});

// ─── the command: runDrop ────────────────────────────────────────────────────

const JANET = { firstName: 'Janet', lastName: 'Sample', state: 'California' };
const runDrop = (over = {}) => {
  const state = over.state || { optOuts: {} };
  const result = drop.runDrop({
    persons: over.persons || [JANE, BOB],
    state,
    options: over.options || {},
    registryCount: over.registryCount === undefined ? 625 : over.registryCount,
    today: over.today || '2026-11-17',
    save: () => {},
  });
  return { ...result, state, text: result.lines.join('\n') };
};

test('runDrop with no flags prints each person and changes nothing', () => {
  const r = runDrop();
  assert.equal(r.code, 0);
  assert.match(r.text, /Jane Sample/);
  assert.match(r.text, /not recorded yet/);
  assert.match(r.text, /Bob Sample[\s\S]*for California residents/);
  assert.equal(r.state.drop, undefined);
});

test('runDrop --done records today for the California people only', () => {
  const r = runDrop({ persons: [JANE, BOB, JANET], options: { done: true } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.state.drop, {
    'Jane Sample': { submittedAt: '2026-11-17' },
    'Janet Sample': { submittedAt: '2026-11-17' },
  });
  assert.match(r.text, /submitted on 2026-11-17/);
});

test('runDrop --done --on records that day and shows the deadline', () => {
  const r = runDrop({ options: { done: true, on: '2026-09-01' } });
  assert.deepEqual(r.state.drop, { 'Jane Sample': { submittedAt: '2026-09-01' } });
  assert.match(r.text, /brokers have until 2026-11-30/);
});

test('runDrop refuses a bad --on before recording anything', () => {
  for (const on of ['2026-11-18', '2025-12-31', 'soon']) {
    const r = runDrop({ persons: [JANE, JANET], options: { done: true, on } });
    assert.equal(r.code, 2, on);
    assert.equal(r.state.drop, undefined, `${on} must record nothing`);
    assert.match(r.text, /Error:/);
  }
});

test('runDrop --person picks one person, and an unknown name is an error that lists the names', () => {
  const r = runDrop({ persons: [JANE, JANET], options: { done: true, person: 'janet sample' } });
  assert.deepEqual(r.state.drop, { 'Janet Sample': { submittedAt: '2026-11-17' } });
  assert.doesNotMatch(r.text, /Jane Sample/);

  const bad = runDrop({ persons: [JANE, JANET], options: { done: true, person: 'Nobody Here' } });
  assert.equal(bad.code, 2);
  assert.equal(bad.state.drop, undefined);
  assert.match(bad.text, /Nobody Here/);
  assert.match(bad.text, /Jane Sample, Janet Sample/);
});

test('runDrop --done for a person outside California records nothing and says so', () => {
  const r = runDrop({ persons: [BOB], options: { done: true } });
  assert.equal(r.code, 0);
  assert.equal(r.state.drop, undefined);
  assert.match(r.text, /for California residents/);
  assert.match(r.text, /Nothing was recorded/);
});

test('runDrop --clear removes the record', () => {
  const state = { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
  const r = runDrop({ state, options: { clear: true } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.state.drop, {});
  assert.match(r.text, /Removed the record/);
  assert.match(r.text, /not recorded yet/);
});

test('runDrop --clear with nothing recorded says so', () => {
  const r = runDrop({ options: { clear: true } });
  assert.equal(r.code, 0);
  assert.match(r.text, /no DROP request was recorded/i);
});

test('runDrop tells you to run update-brokers when the registry is unknown', () => {
  assert.match(runDrop({ registryCount: 0 }).text, /aidr update-brokers/);
});

// ─── what a run says about DROP ──────────────────────────────────────────────

const notes = (over = {}) => drop.dropRunNotes({
  persons: [JANE, BOB], state: {}, config: {}, registryHosts: REGISTRY, ...over,
});

test('dropRunNotes: one hint when a California person has no recorded request', () => {
  const lines = notes();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /aidr drop/);
  assert.match(lines[0], /Jane Sample|California/);
});

test('dropRunNotes: still one line when several California people have no record', () => {
  assert.equal(notes({ persons: [JANE, JANET] }).length, 1);
});

test('dropRunNotes: nothing for people outside California', () => {
  assert.deepEqual(notes({ persons: [BOB] }), []);
});

test('dropRunNotes: nothing when every California person has a record and the registry is known', () => {
  assert.deepEqual(notes({ state: STATE_WITH_DROP, persons: [JANE, BOB] }), []);
});

test('dropRunNotes: a record with an empty registry list says to run update-brokers', () => {
  const lines = notes({ state: STATE_WITH_DROP, registryHosts: {} });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /aidr update-brokers/);
});

test('dropRunNotes: alsoSubmit silences the empty-registry line (nothing would be skipped anyway)', () => {
  assert.deepEqual(notes({ state: STATE_WITH_DROP, registryHosts: {}, config: { drop: { alsoSubmit: true } } }), []);
});
