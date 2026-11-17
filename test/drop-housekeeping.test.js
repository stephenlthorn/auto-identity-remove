/**
 * test/drop-housekeeping.test.js
 *
 * D11 of the 2.1 review: the record of a DROP request is what the 90-day clock hangs
 * on, so `--done` never silently moves it, `--clear` works for anyone who has a
 * record, and a recorded request is not offered again as a to-do.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const drop = require('../lib/drop');
const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const JANE = { firstName: 'Jane', lastName: 'Sample', state: 'CA', zip: '93701', email: 'jane@sample-test.example' };
const MOVED = { ...JANE, state: 'TX' };

const recorded = (person, day) => {
  const state = { optOuts: {} };
  drop.recordDropRequest(state, person, day, { save: () => {} });
  return state;
};
const run = (person, state, options) => {
  const result = drop.runDrop({ persons: [person], state, options, registryCount: 0, today: '2026-11-17', save: () => {} });
  return { ...result, text: result.lines.join('\n') };
};

test('--done with a record already there changes nothing and says which date is recorded', () => {
  const state = recorded(JANE, '2026-09-01');
  const r = run(JANE, state, { done: true });
  assert.equal(r.code, 0);
  assert.equal(state.drop['Jane Sample'].submittedAt, '2026-09-01', 'the 90-day clock was not reset');
  assert.match(r.text, /already recorded/i);
  assert.match(r.text, /2026-09-01/);
  assert.match(r.text, /--on/, 'says how to change it on purpose');
});

test('--done --on replaces the date, and says it did', () => {
  const state = recorded(JANE, '2026-09-01');
  const r = run(JANE, state, { done: true, on: '2026-10-05' });
  assert.equal(r.code, 0);
  assert.equal(state.drop['Jane Sample'].submittedAt, '2026-10-05');
  assert.match(r.text, /Replaced/);
  assert.match(r.text, /2026-09-01/);
  assert.match(r.text, /2026-10-05/);
});

test('--done --on with the date already recorded is "already recorded", not a change', () => {
  const state = recorded(JANE, '2026-09-01');
  const r = run(JANE, state, { done: true, on: '2026-09-01' });
  assert.match(r.text, /already recorded/i);
});

test('--clear works for a person whose state is no longer California', () => {
  const state = recorded(JANE, '2026-09-01');
  const r = run(MOVED, state, { clear: true });
  assert.equal(r.code, 0);
  assert.equal(drop.getDropRequest(state, MOVED), null);
  assert.deepEqual(state.drop, {});
  assert.match(r.text, /Removed the record/);
  assert.doesNotMatch(r.text, /nothing was changed for this person/, 'no contradictory second line');
});

test('--clear without --person never clears a second person\'s record along the way', () => {
  const state = recorded(JANE, '2026-09-01');
  const other = { firstName: 'Ann', lastName: 'Mover', state: 'TX', zip: '73301', email: 'ann@sample-test.example' };
  drop.recordDropRequest(state, other, '2026-09-02', { save: () => {} });
  const r = drop.runDrop({ persons: [JANE, other], state, options: { clear: true }, registryCount: 0, today: '2026-11-17', save: () => {} });
  assert.equal(r.code, 2);
  assert.equal(Object.keys(state.drop).length, 2);
});

test('recordedDropFor: the manual DROP entry is done once the person has a request', () => {
  const entry = { name: 'CalPrivacy DROP', californiaOnly: true };
  assert.equal(drop.recordedDropFor(entry, JANE, recorded(JANE, '2026-09-01')), '2026-09-01');
  assert.equal(drop.recordedDropFor(entry, JANE, { optOuts: {} }), null);
  assert.equal(drop.recordedDropFor({ name: 'Spokeo' }, JANE, recorded(JANE, '2026-09-01')), null, 'only the californiaOnly entry');
});

// ── the real run: the manual entry stops being a to-do ──────────────────────

const person = (over) => ({
  firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', city: 'Fresno', state: 'CA', zip: '93701', country: 'US',
  email: 'jane@sample-test.example', phone: '5595550101', phoneFormatted: '(559) 555-0101', ...over,
});

test('after --done the run lists DROP as done with its date, not under Manual needed', async () => {
  const sandbox = createSandbox({ config: runnableConfig({ persons: [person()] }) });
  try {
    const before = await runWatcher(sandbox, ['--only', 'CalPrivacy DROP']);
    assert.equal(before.code, 0, before.stdout + before.stderr);
    assert.match(before.stdout, /Manual needed:\s+1/, 'a to-do until it is recorded');

    const done = await runWatcher(sandbox, ['--drop', '--done', '--on', '2026-09-01']);
    assert.equal(done.code, 0, done.stdout + done.stderr);

    const after = await runWatcher(sandbox, ['--only', 'CalPrivacy DROP']);
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /Manual needed:\s+0/);
    assert.match(after.stdout, /already done: your DROP request was recorded on 2026-09-01/);
    const log = JSON.parse(fs.readFileSync(path.join(sandbox.logs, sandbox.runLogs().slice(-1)[0]), 'utf8'));
    assert.match(JSON.stringify(log), /recorded on 2026-09-01/);
  } finally { sandbox.cleanup(); }
});
