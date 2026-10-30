/**
 * test/resume-relay-guard.test.js
 *
 * planResume infers "every explicit pass already ended" from a generic-phase
 * checkpoint, for EVERY person. But a person the masked-email relay could not serve
 * was skipped by the interrupted run altogether: their explicit pass never happened.
 * Resuming then "skipped the explicit pass for <them>, already done", their generic
 * pass started from row 0, and the run ended complete with their explicit brokers
 * never submitted.
 *
 * The watcher now reads the interrupted run's journal (or summary) for the persons
 * the relay failed for, and does not let the resume plan skip anything for them.
 * Skipping needs evidence; absence of a result is not evidence.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planResume } = require('../lib/config');
const { RELAY_BROKER, relaySkippedNames, guardResumePlan } = require('../lib/resume-guard');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const ADA = { firstName: 'Ada', lastName: 'Lovelace' };
const ALAN = { firstName: 'Alan', lastName: 'Turing' };
const PERSONS = [ADA, ALAN];
const genericCheckpoint = { phase: 'generic', personIndex: 0, key: 'Some Broker|Ada Lovelace', index: 40 };

const dirs = [];
function logDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-resume-guard-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const relayEntry = (person) => ({ broker: RELAY_BROKER, status: 'error', detail: 'unavailable', person, time: '2026-10-01T09:00:00.000Z' });
const journalLines = (entries, { ended = false } = {}) => [
  { type: 'run', startedAt: '2026-10-01T09:00:00.000Z', mode: 'run', partial: false, filter: null },
  ...entries,
  ...(ended ? [{ type: 'end', counts: {} }] : []),
].map(l => JSON.stringify(l)).join('\n') + '\n';

// ── guardResumePlan (pure) ───────────────────────────────────────────────────

test('a generic-phase checkpoint skips every explicit pass, which the guard takes back for a relay-skipped person', () => {
  const plan = planResume(genericCheckpoint, PERSONS);
  assert.deepEqual(plan.map(p => p.skipExplicit), [true, true], 'the inference this guards against');

  const guarded = guardResumePlan(plan, PERSONS, new Set(['Alan Turing']));
  assert.equal(guarded[0].skipExplicit, true, 'Ada really did finish hers');
  assert.equal(guarded[1].skipExplicit, false, 'Alan was skipped by the interrupted run: nothing proves his explicit pass');
  assert.equal(guarded[1].skipGeneric, false);
});

test('the person the checkpoint is inside is never relay-skipped, but a skipped person BEFORE it must not be marked generic-done', () => {
  const plan = planResume({ phase: 'generic', personIndex: 1, key: 'X|Alan Turing', index: 5 }, PERSONS);
  assert.equal(plan[0].skipGeneric, true, 'planResume assumes everyone before the checkpoint finished');
  const guarded = guardResumePlan(plan, PERSONS, new Set(['Ada Lovelace']));
  assert.equal(guarded[0].skipGeneric, false, 'Ada was skipped, so her generic pass did not finish either');
  assert.equal(guarded[0].skipExplicit, false);
  assert.deepEqual(guarded[1].genericResume, plan[1].genericResume, 'the person the checkpoint belongs to is untouched');
});

test('an explicit-phase checkpoint: a relay-skipped person before it is not skipped either', () => {
  const plan = planResume({ phase: 'explicit', personIndex: 1, key: 'Radaris|Alan Turing', index: null }, PERSONS);
  assert.equal(plan[0].skipExplicit, true);
  const guarded = guardResumePlan(plan, PERSONS, new Set(['Ada Lovelace']));
  assert.equal(guarded[0].skipExplicit, false);
});

test('nobody relay-skipped: the plan is returned as it was, and the input is never mutated', () => {
  const plan = planResume(genericCheckpoint, PERSONS);
  const copy = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(guardResumePlan(plan, PERSONS, new Set()), copy);
  guardResumePlan(plan, PERSONS, new Set(['Alan Turing']));
  assert.deepEqual(plan, copy, 'the original plan is untouched');
});

test('a name that matches no current person changes nothing', () => {
  const plan = planResume(genericCheckpoint, PERSONS);
  assert.deepEqual(guardResumePlan(plan, PERSONS, new Set(['Grace Hopper'])), plan);
});

// ── relaySkippedNames: reading the interrupted run ───────────────────────────

test('reads the relay failures out of a run that crashed before it wrote a summary (its journal)', () => {
  const dir = logDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-01T09-00-00.jsonl'), journalLines([relayEntry('Alan Turing'), { broker: 'Radaris', status: 'error', detail: 'x', person: 'Ada Lovelace' }]));
  assert.deepEqual([...relaySkippedNames(dir)], ['Alan Turing']);
});

test('reads them out of a summary too', () => {
  const dir = logDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-01T09-00-00.json'), JSON.stringify({ runAt: 'x', errors: [relayEntry('Ada Lovelace')], succeeded: [] }));
  assert.deepEqual([...relaySkippedNames(dir)], ['Ada Lovelace']);
});

test('looks past a newer partial run: a filtered run in between must not hide the interrupted one', () => {
  const dir = logDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-01T09-00-00.jsonl'), journalLines([relayEntry('Alan Turing')]));
  fs.writeFileSync(path.join(dir, 'run-2026-10-02T09-00-00.json'), JSON.stringify({ runAt: 'x', partial: true, errors: [], succeeded: [] }));
  assert.deepEqual([...relaySkippedNames(dir)], ['Alan Turing']);
});

test('the run in progress is left out, and a missing or empty directory is no evidence of anything', () => {
  const dir = logDir();
  fs.writeFileSync(path.join(dir, 'run-2026-10-03T09-00-00.jsonl'), journalLines([relayEntry('Ada Lovelace')]));
  assert.deepEqual([...relaySkippedNames(dir, { exclude: path.join(dir, 'run-2026-10-03T09-00-00.json') })], []);
  assert.deepEqual([...relaySkippedNames(path.join(dir, 'nope'))], []);
});

test('only the most recent runs are read', () => {
  const dir = logDir();
  fs.writeFileSync(path.join(dir, 'run-2026-01-01T09-00-00.jsonl'), journalLines([relayEntry('Alan Turing')]));
  for (let day = 1; day <= 6; day++) {
    fs.writeFileSync(path.join(dir, `run-2026-02-0${day}T09-00-00.json`), JSON.stringify({ runAt: 'x', errors: [], succeeded: [] }));
  }
  assert.deepEqual([...relaySkippedNames(dir)], [], 'a relay failure from months ago says nothing about this checkpoint');
});

// ── the watcher, end to end ──────────────────────────────────────────────────

test('--resume runs the explicit pass of a person the interrupted run never served', async () => {
  const sandbox = createSandbox();
  try {
    fs.writeFileSync(`${sandbox.state}.checkpoint`, JSON.stringify(genericCheckpoint) + '\n', { mode: 0o600 });
    fs.mkdirSync(sandbox.logs, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sandbox.logs, 'run-2026-10-01T09-00-00.jsonl'), journalLines([relayEntry('Alan Turing')]), { mode: 0o600 });

    const r = await runWatcher(sandbox, ['--resume', '--only', 'zzz-no-such-broker'], { timeoutMs: 90000 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--resume: the explicit pass for Ada Lovelace is already done, skipping/, 'Ada finished hers');
    assert.doesNotMatch(r.stdout, /explicit pass for Alan Turing is already done/, 'Alan\'s was never done');
    assert.match(r.stdout, /Running for: Alan Turing/);
  } finally {
    sandbox.cleanup();
  }
});

test('--resume with no relay failure on record still skips every finished explicit pass', async () => {
  const sandbox = createSandbox();
  try {
    fs.writeFileSync(`${sandbox.state}.checkpoint`, JSON.stringify(genericCheckpoint) + '\n', { mode: 0o600 });
    const r = await runWatcher(sandbox, ['--resume', '--only', 'zzz-no-such-broker'], { timeoutMs: 90000 });
    assert.match(r.stdout, /explicit pass for Ada Lovelace is already done/);
    assert.match(r.stdout, /explicit pass for Alan Turing is already done/);
  } finally {
    sandbox.cleanup();
  }
});
