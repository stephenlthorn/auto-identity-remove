/**
 * test/drop-run.test.js
 *
 * `aidr drop` and the real watcher run, as a child process in a sandbox (fake
 * browser, no network, throwaway config and state). The generic pass is observed
 * through the one thing a fake browser cannot hide: which hosts it tried to look up.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const drop = require('../lib/drop');

// The recorded days by person (each record also carries the identity fingerprint, see drop-identity.test.js).
const days = (table) => Object.fromEntries(Object.entries(table || {}).map(([name, rec]) => [name, rec.submittedAt]));
const person = (over) => ({
  firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', city: 'Fresno', state: 'CA', zip: '93701', country: 'US',
  email: 'jane@sample-test.example', phone: '5595550101', phoneFormatted: '(559) 555-0101', ...over,
});
const config = (persons, extra = {}) => runnableConfig({ persons, ...extra });
const writeRegistry = (sandbox, hosts, count = Object.keys(hosts).length) => fs.writeFileSync(path.join(sandbox.repo, 'data', 'feeds-brokers.json'), JSON.stringify({ brokers: [], registryHosts: hosts, registries: { CA: { ok: true, count, knownCount: count } }, updatedAt: "2026-11-17T00:00:00.000Z" }));

// A row of the shipped Markup dataset: generic, and not an explicit broker.
const ROW = { name: 'Explorium Inc.', host: 'explorium.ai' };

test('aidr drop for a California person: what it is, the URL, the status, the registry count', async () => {
  const sandbox = createSandbox({ config: config([person()]) });
  try {
    writeRegistry(sandbox, { 'a.example': ['CA'], 'b.example': ['CA', 'VT'], 'c.example': ['VT'] }, 2);
    const r = await runWatcher(sandbox, ['--drop']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Delete Request and Opt-out Platform/);
    assert.ok(r.stdout.includes(drop.DROP_URL));
    assert.match(r.stdout, /not recorded yet/);
    assert.match(r.stdout, /knows 2 registry brokers/);
    assert.equal(sandbox.readState().drop, undefined);
  } finally { sandbox.cleanup(); }
});

test('aidr drop with no registry list tells you to run update-brokers', async () => {
  const sandbox = createSandbox({ config: config([person()]) });
  try {
    fs.rmSync(path.join(sandbox.repo, 'data', 'feeds-brokers.json'), { force: true });
    const r = await runWatcher(sandbox, ['--drop']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /aidr update-brokers/);
  } finally { sandbox.cleanup(); }
});

test('aidr drop --done --on records the day in state.json; --clear removes it', async () => {
  const sandbox = createSandbox({ config: config([person()]), state: { optOuts: { Spokeo: { lastSuccess: '2026-09-01T00:00:00.000Z' } } } });
  try {
    const done = await runWatcher(sandbox, ['--drop', '--done', '--on', '2026-09-01']);
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /brokers have until 2026-11-30/);
    assert.deepEqual(days(sandbox.readState().drop), { 'Jane Sample': '2026-09-01' });
    assert.ok(sandbox.readState().optOuts.Spokeo, 'the opt-out history is untouched');

    const cleared = await runWatcher(sandbox, ['--drop', '--clear']);
    assert.equal(cleared.code, 0, cleared.stdout + cleared.stderr);
    assert.deepEqual(sandbox.readState().drop, {});
  } finally { sandbox.cleanup(); }
});

test('aidr drop --done with a future day is refused and records nothing', async () => {
  const sandbox = createSandbox({ config: config([person()]) });
  try {
    const r = await runWatcher(sandbox, ['--drop', '--done', '--on', '2999-01-01']);
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /future/);
    assert.equal(sandbox.readState().drop, undefined);
  } finally { sandbox.cleanup(); }
});

test('aidr drop for a person outside California changes nothing', async () => {
  const sandbox = createSandbox({ config: config([person({ firstName: 'Bob', fullName: 'Bob Sample', state: 'TX' })]) });
  try {
    const r = await runWatcher(sandbox, ['--drop', '--done']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /for California residents/);
    assert.equal(sandbox.readState().drop, undefined);
  } finally { sandbox.cleanup(); }
});

test('--person picks one of several people', async () => {
  const sandbox = createSandbox({ config: config([person(), person({ firstName: 'Janet', fullName: 'Janet Sample' })]) });
  try {
    const r = await runWatcher(sandbox, ['--drop', '--done', '--on', '2026-09-01', '--person', 'Janet Sample']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(days(sandbox.readState().drop), { 'Janet Sample': '2026-09-01' });
  } finally { sandbox.cleanup(); }
});

// ── the run ──────────────────────────────────────────────────────────────────

const runOnlyRow = (sandbox, extra = []) => runWatcher(sandbox, ['--only', ROW.name, ...extra]);
const lookedUp = (sandbox) => sandbox.networkAttempts().some(e => String(e.host || e.url || '').includes(ROW.host));
const loggedRow = (sandbox) => {
  const file = sandbox.runLogs()[0];
  assert.ok(file, 'a run log was written');
  const log = JSON.parse(fs.readFileSync(path.join(sandbox.logs, file), 'utf8'));
  return JSON.stringify(log).includes('covered by your DROP request of 2026-09-01');
};

test('a run for a California person with a recorded request does not visit a covered generic row, and says so', async () => {
  const sandbox = createSandbox({ config: config([person()]), state: { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } } });
  try {
    writeRegistry(sandbox, { [ROW.host]: ['CA'] });
    const r = await runOnlyRow(sandbox);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(lookedUp(sandbox), false, 'the covered host was never looked up');
    assert.match(r.stdout, /covered by your DROP request of 2026-09-01/);
    assert.match(r.stdout, /1 covered by DROP/);
    assert.ok(loggedRow(sandbox), 'the run log carries the reason');
    assert.doesNotMatch(r.stdout, /aidr drop\b/, 'no hint when the request is recorded and the list is known');
  } finally { sandbox.cleanup(); }
});

test('a person in another state, or drop.alsoSubmit, still visits that row', async () => {
  const tx = createSandbox({ config: config([person({ firstName: 'Bob', fullName: 'Bob Sample', state: 'TX' })]), state: { optOuts: {}, drop: { 'Bob Sample': { submittedAt: '2026-09-01' } } } });
  const also = createSandbox({ config: config([person()], { drop: { alsoSubmit: true } }), state: { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } } });
  try {
    for (const sandbox of [tx, also]) {
      writeRegistry(sandbox, { [ROW.host]: ['CA'] });
      const r = await runOnlyRow(sandbox);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(lookedUp(sandbox), true, 'the host was looked up as before');
      assert.doesNotMatch(r.stdout, /covered by DROP/);
    }
  } finally { tx.cleanup(); also.cleanup(); }
});

test('a real run for a California person with no recorded request prints one hint', async () => {
  const sandbox = createSandbox({ config: config([person(), person({ firstName: 'Janet', fullName: 'Janet Sample' })]) });
  try {
    const r = await runOnlyRow(sandbox);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const hints = r.stdout.split('\n').filter(l => /See: aidr drop/.test(l));
    assert.equal(hints.length, 1, r.stdout);
  } finally { sandbox.cleanup(); }
});

test('a recorded request with no registry list says to run update-brokers, once', async () => {
  const sandbox = createSandbox({ config: config([person()]), state: { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } } });
  try {
    fs.rmSync(path.join(sandbox.repo, 'data', 'feeds-brokers.json'), { force: true });
    const r = await runOnlyRow(sandbox);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.split('\n').filter(l => /aidr update-brokers/.test(l)).length, 1, r.stdout);
  } finally { sandbox.cleanup(); }
});

test('the DROP manual entry is offered only to people in California', async () => {
  const sandbox = createSandbox({ config: config([person(), person({ firstName: 'Bob', fullName: 'Bob Sample', state: 'TX' })]) });
  try {
    const r = await runWatcher(sandbox, ['--only', 'CalPrivacy DROP']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const mentions = r.stdout.match(/consumer\.drop\.privacy\.ca\.gov/g) || [];
    assert.ok(mentions.length >= 1, 'California person is shown the entry');
    const log = JSON.parse(fs.readFileSync(path.join(sandbox.logs, sandbox.runLogs()[0]), 'utf8'));
    const text = JSON.stringify(log);
    assert.ok(text.includes('Jane Sample'), 'the California person has the row');
    assert.ok(!/CalPrivacy DROP[^}]*Bob Sample|Bob Sample[^}]*CalPrivacy DROP/.test(text), 'the Texan has none');
  } finally { sandbox.cleanup(); }
});

// ── complaints ───────────────────────────────────────────────────────────────

const complaintFiles = (sandbox) => {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/-CPPA\.txt$/.test(name)) out.push(full);
    }
  };
  walk(sandbox.dir);
  return out;
};

test('aidr complaints drafts a DROP complaint only when verification found a listing after the window', async () => {
  const stateFor = (optOut) => ({ optOuts: { Spokeo: optOut }, drop: { 'Jane Sample': { submittedAt: '2026-01-15' } } });
  // deadline for a request before 2026-08-01 is 2026-10-30; today is well past it
  const evidence = createSandbox({ config: config([person()]), state: stateFor({ verifiedStillListedAt: '2026-11-05T00:00:00.000Z' }) });
  const ageOnly = createSandbox({ config: config([person()]), state: stateFor({ lastSuccess: '2026-02-01T00:00:00.000Z' }) });
  try {
    for (const sandbox of [evidence, ageOnly]) writeRegistry(sandbox, { 'spokeo.com': ['CA'] });
    const withEvidence = await runWatcher(evidence, ['--complaints']);
    assert.equal(withEvidence.code, 0, withEvidence.stdout + withEvidence.stderr);
    const files = complaintFiles(evidence);
    assert.equal(files.length, 1, withEvidence.stdout);
    assert.match(fs.readFileSync(files[0], 'utf8'), /1798\.99\.86\(c\)\(1\)/);

    const withoutEvidence = await runWatcher(ageOnly, ['--complaints']);
    assert.equal(withoutEvidence.code, 0, withoutEvidence.stdout + withoutEvidence.stderr);
    assert.deepEqual(complaintFiles(ageOnly), []);
  } finally { evidence.cleanup(); ageOnly.cleanup(); }
});

test('a mistyped drop.alsoSubmit submits the covered row and the run says why, once (D6)', async () => {
  const sandbox = createSandbox({ config: config([person()], { drop: { alsoSubmit: 'true' } }), state: { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } } });
  try {
    writeRegistry(sandbox, { [ROW.host]: ['CA'] });
    const r = await runOnlyRow(sandbox);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(lookedUp(sandbox), true, 'the row was visited, not skipped');
    assert.doesNotMatch(r.stdout, /covered by DROP/);
    assert.equal(r.stdout.split('\n').filter(l => /drop\.alsoSubmit must be true or false/.test(l)).length, 1, r.stdout);
  } finally { sandbox.cleanup(); }
});

// D12: a bundled row on a shared form platform is never "covered" by a platform domain.
test('a bundled row on a shared form platform is still visited, even if the registry file lists the platform', async () => {
  const platformRow = { name: 'Path2Response LLC', host: 'privacyportal-cdn.onetrust.com' };
  const sandbox = createSandbox({ config: config([person()]), state: { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } } });
  try {
    writeRegistry(sandbox, { 'onetrust.com': ['CA'], 'co.uk': ['CA'], 'acme-data.example': ['CA'] });
    const r = await runWatcher(sandbox, ['--only', platformRow.name]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(sandbox.networkAttempts().some(e => String(e.host || e.url || '').includes(platformRow.host)), true, 'the portal host was looked up');
    assert.doesNotMatch(r.stdout, /covered by DROP/);
  } finally { sandbox.cleanup(); }
});
