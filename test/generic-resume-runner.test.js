/**
 * test/generic-resume-runner.test.js
 *
 * R2: runGenericBrokers can resume an interrupted generic pass.
 *
 *   opts.resumeFrom      { index, key }  skip the rows before it. If the row at
 *                        `index` no longer has `key` (the dataset changed), find
 *                        `key` by name; if it is gone, start over and say so.
 *                        Skipping on an index nobody verified could leave real
 *                        brokers un-submitted, so an unverifiable resume point
 *                        always means "start over".
 *   opts.saveCheckpoint  (record) => void, called with
 *                        { phase: 'generic', personIndex, key, index } as the loop
 *                        advances. Injected like recordSuccess, so a test (or a
 *                        caller that wants no resume) never touches a real
 *                        checkpoint file.
 *   opts.now             clock for the write throttle (tests).
 *
 * The record is written BEFORE its broker runs, so the checkpoint never points
 * past an unprocessed row: a kill costs at most one re-run of the in-progress
 * broker, never a skipped one.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext } = require('./helpers/generic-fake-page');

const JANE = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'jane@home.example', state: 'CA', zip: '90001' };
const JOHN = { firstName: 'John', lastName: 'Roe', fullName: 'John Roe', email: 'john@home.example', state: 'CA', zip: '90001' };

const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `Row${i}`, url: `https://row${i}.example/x`, source: 'test' }));

/** Run the generic pass over `brokers` and report what was processed and checkpointed. */
async function pass({ brokers = rows(5), logResult, ...opts } = {}) {
  const seen = [];
  const checkpoints = [];
  const result = await gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} },
    logResult || (() => {}),
    () => {},
    {
      injectedBrokers: brokers,
      injectedProcessFn: async (_page, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
      saveCheckpoint: (record) => checkpoints.push(record),
      ...opts,
    },
  );
  return { seen, checkpoints, result };
}

function captureLog(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

// A clock that returns each of `times` once, then keeps the last value.
const clock = (times) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };

// ── resolveResumeStart (pure) ────────────────────────────────────────────────

test('resolveResumeStart trusts an index whose row still has the key', () => {
  const queue = rows(5);
  assert.deepEqual(
    gr.resolveResumeStart(queue, { index: 3, key: 'Row3' }, (n) => n),
    { start: 3, note: null },
  );
});

test('resolveResumeStart relocates by key when the row at the index changed, and says so', () => {
  const queue = [{ name: 'New0' }, { name: 'New1' }, ...rows(5)];
  const { start, note } = gr.resolveResumeStart(queue, { index: 3, key: 'Row3' }, (n) => n);
  assert.equal(start, 5, 'Row3 now sits at position 5');
  assert.match(note, /moved/i);
});

test('resolveResumeStart starts over, with a warning naming the key, when the key is gone', () => {
  const { start, note } = gr.resolveResumeStart(rows(5), { index: 2, key: 'Vanished Co' }, (n) => n);
  assert.equal(start, 0);
  assert.match(note, /Vanished Co/);
  assert.match(note, /starting the generic pass over/i);
});

test('resolveResumeStart starts over when the checkpoint has no key to verify', () => {
  for (const bad of [{ index: 2 }, { index: 2, key: '' }, { index: 2, key: null }]) {
    const { start, note } = gr.resolveResumeStart(rows(5), bad, (n) => n);
    assert.equal(start, 0);
    assert.ok(note);
  }
});

test('resolveResumeStart finds a key by name when the index is missing or beyond the list', () => {
  assert.equal(gr.resolveResumeStart(rows(5), { index: null, key: 'Row4' }, (n) => n).start, 4);
  assert.equal(gr.resolveResumeStart(rows(5), { index: 99, key: 'Row1' }, (n) => n).start, 1);
});

test('resolveResumeStart with no resume point is a plain start', () => {
  for (const nothing of [undefined, null]) {
    assert.deepEqual(gr.resolveResumeStart(rows(3), nothing, (n) => n), { start: 0, note: null });
  }
});

test('resolveResumeStart picks the first of two rows with the same name (never skips past a duplicate)', () => {
  const queue = [{ name: 'A' }, { name: 'Dup' }, { name: 'B' }, { name: 'Dup' }];
  assert.equal(gr.resolveResumeStart(queue, { index: 99, key: 'Dup' }, (n) => n).start, 1);
});

// ── runGenericBrokers: resumeFrom ────────────────────────────────────────────

test('resumeFrom skips the rows before it and processes the rest', async () => {
  const { seen, result } = await pass({ resumeFrom: { index: 2, key: 'Row2' } });
  assert.deepEqual(seen, ['Row2', 'Row3', 'Row4']);
  assert.equal(result.count, 3, 'count is the number of rows that ran');
  assert.equal(result.resumeSkipped, 2);
  assert.equal(result.genericStats.attempted, 3);
});

test('without resumeFrom nothing is skipped', async () => {
  const { seen, result } = await pass();
  assert.equal(seen.length, 5);
  assert.equal(result.resumeSkipped, 0);
});

test('a skipped row is never navigated to, logged or recorded', async () => {
  const logged = [];
  const page = makeFakePage();
  await gr.runGenericBrokers(
    makeContext(page), new Set(), { optOuts: {} },
    (name, status) => logged.push({ name, status }), () => {},
    {
      injectedBrokers: rows(4),
      injectedDeadSet: new Set(),
      injectedProcessFn: async (_p, broker) => ({ status: 'manual', detail: broker.url }),
      resumeFrom: { index: 3, key: 'Row3' },
    },
  );
  assert.deepEqual(logged.map(l => l.name), ['Row3']);
  assert.deepEqual(page.gotos, []);
});

test('when the dataset shifted, resume finds the key by name and tells the operator', async (t) => {
  const lines = captureLog(t);
  const shifted = [{ name: 'Inserted A', url: 'https://a.example/x', source: 'test' }, { name: 'Inserted B', url: 'https://b.example/x', source: 'test' }, ...rows(5)];
  const { seen } = await pass({ brokers: shifted, resumeFrom: { index: 3, key: 'Row3' } });
  assert.deepEqual(seen, ['Row3', 'Row4']);
  assert.ok(lines.some(l => /resum/i.test(l) && /Row3/.test(l)), 'a resume line naming the row is printed');
});

test('when the key is gone the whole pass runs again, with a warning', async (t) => {
  const lines = captureLog(t);
  const { seen } = await pass({ resumeFrom: { index: 2, key: 'Row2 (renamed)' } });
  assert.equal(seen.length, 5, 'nothing is skipped on an unverifiable resume point');
  assert.ok(lines.some(l => /Row2 \(renamed\)/.test(l) && /starting the generic pass over/i.test(l)));
});

test('resume uses the per-person state key: a multi-person key resumes, a stale bare key does not', async (t) => {
  captureLog(t);
  const multi = await pass({ person: JANE, personCount: 2, personIndex: 0, resumeFrom: { index: 3, key: 'Row3|Jane Doe' } });
  assert.deepEqual(multi.seen, ['Row3', 'Row4']);

  const stale = await pass({ person: JANE, personCount: 2, personIndex: 0, resumeFrom: { index: 3, key: 'Row3' } });
  assert.equal(stale.seen.length, 5, 'a key from a single-person run must not skip anything for two people');
});

test('resumeFrom is honoured in a dry run (a preview shows what the resume would do)', async () => {
  const { seen, checkpoints } = await pass({ dryRun: true, resumeFrom: { index: 3, key: 'Row3' } });
  assert.deepEqual(seen, ['Row3', 'Row4']);
  assert.deepEqual(checkpoints, [], 'but a preview never writes a checkpoint');
});

test('resumeFrom composes with the include predicate: the index is into the rows that will run', async () => {
  const include = (name) => name !== 'Row1';
  const first = await pass({ include, now: clock([0, 5000, 10000, 15000]) });
  assert.equal(first.checkpoints[2].key, 'Row3');
  assert.equal(first.checkpoints[2].index, 2, 'Row3 is the third row that runs once Row1 is excluded');

  const resumed = await pass({ include, resumeFrom: { index: first.checkpoints[2].index, key: first.checkpoints[2].key } });
  assert.deepEqual(resumed.seen, ['Row3', 'Row4']);
});

test('resuming with a different --only than the interrupted run still lands on the key', async (t) => {
  captureLog(t);
  // Interrupted at index 3 of the full list; this run only includes two rows.
  const { seen } = await pass({ include: (n) => n === 'Row3' || n === 'Row4', resumeFrom: { index: 3, key: 'Row3' } });
  assert.deepEqual(seen, ['Row3', 'Row4']);
});

test('resuming at a key the include predicate excludes starts the pass over', async (t) => {
  captureLog(t);
  const { seen } = await pass({ include: (n) => n !== 'Row3', resumeFrom: { index: 3, key: 'Row3' } });
  assert.deepEqual(seen, ['Row0', 'Row1', 'Row2', 'Row4']);
});

// ── runGenericBrokers: checkpoint writes ─────────────────────────────────────

test('the loop checkpoints each row, before it runs, as a structured generic record', async () => {
  const order = [];
  const { checkpoints } = await pass({
    brokers: rows(3),
    now: clock([0, 5000, 10000]),
    saveCheckpoint: (r) => order.push(['saved', r.key]),
    injectedProcessFn: async (_p, b) => { order.push(['ran', b.name]); return { status: 'manual', detail: '' }; },
  });
  assert.deepEqual(checkpoints, [], 'the helper stub was replaced by the order recorder');
  assert.deepEqual(order, [
    ['saved', 'Row0'], ['ran', 'Row0'],
    ['saved', 'Row1'], ['ran', 'Row1'],
    ['saved', 'Row2'], ['ran', 'Row2'],
  ]);
});

test('records carry phase, personIndex, the per-person state key and the absolute index', async () => {
  const { checkpoints } = await pass({
    brokers: rows(3), person: JOHN, personCount: 2, personIndex: 1, now: clock([0, 5000, 10000]),
  });
  assert.deepEqual(checkpoints, [
    { phase: 'generic', personIndex: 1, key: 'Row0|John Roe', index: 0 },
    { phase: 'generic', personIndex: 1, key: 'Row1|John Roe', index: 1 },
    { phase: 'generic', personIndex: 1, key: 'Row2|John Roe', index: 2 },
  ]);
});

test('a single-person caller with no personIndex checkpoints as person 0 with bare keys', async () => {
  const { checkpoints } = await pass({ brokers: rows(1) });
  assert.deepEqual(checkpoints, [{ phase: 'generic', personIndex: 0, key: 'Row0', index: 0 }]);
});

test('a resumed pass keeps the original row numbers in its checkpoints', async () => {
  const { checkpoints } = await pass({ resumeFrom: { index: 3, key: 'Row3' }, now: clock([0, 5000]) });
  assert.deepEqual(checkpoints.map(c => c.index), [3, 4]);
});

test('writes are throttled to one per second, and the last row is always written', async () => {
  // Rows arrive at 0, 400, 800, 1200, 1600 ms: only 0 and 1200 are due, 1600 is
  // not, so the final flush is what puts the last row on disk.
  const { checkpoints } = await pass({ now: clock([0, 400, 800, 1200, 1600]) });
  assert.deepEqual(checkpoints.map(c => c.index), [0, 3, 4]);
});

test('a burst of instant rows writes the first and, at the end, the last', async () => {
  const { checkpoints } = await pass({ now: () => 0 });
  assert.deepEqual(checkpoints.map(c => c.index), [0, 4]);
});

test('the first write of a pass is never throttled, even right after another pass ended', async () => {
  // Two persons run back to back; the second pass must checkpoint at once so a
  // kill early in it does not resume into the first person's rows.
  const stamp = clock([100, 100]);
  const a = await pass({ brokers: rows(2), person: JANE, personCount: 2, personIndex: 0, now: stamp });
  const b = await pass({ brokers: rows(2), person: JOHN, personCount: 2, personIndex: 1, now: stamp });
  assert.equal(a.checkpoints.at(-1).personIndex, 0);
  assert.equal(b.checkpoints[0].personIndex, 1);
  assert.equal(b.checkpoints[0].index, 0);
});

test('an empty queue writes nothing', async () => {
  const { checkpoints } = await pass({ brokers: [] });
  assert.deepEqual(checkpoints, []);
});

test('a dry run never writes a checkpoint', async () => {
  const { checkpoints, seen } = await pass({ dryRun: true });
  assert.equal(seen.length, 5, 'the dry run still walks the list');
  assert.deepEqual(checkpoints, []);
});

test('without an injected saveCheckpoint nothing is written (no hidden file writes)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-resume-nowrite-'));
  const ckpt = path.join(dir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckpt);
  cfg.setDryRun(false);
  try {
    const { seen } = await pass({ saveCheckpoint: undefined });
    assert.equal(seen.length, 5);
    assert.equal(fs.existsSync(ckpt), false);
  } finally {
    cfg.setTestCheckpointPath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkpoint write that fails never aborts the pass, and is reported once', async (t) => {
  const lines = captureLog(t);
  let calls = 0;
  const { seen } = await pass({
    now: clock([0, 5000, 10000, 15000, 20000]),
    saveCheckpoint: () => { calls++; throw new Error('EROFS: read-only file system'); },
  });
  assert.equal(seen.length, 5, 'every broker still ran');
  assert.ok(calls >= 1);
  const warnings = lines.filter(l => /checkpoint/i.test(l) && /EROFS/.test(l));
  assert.equal(warnings.length, 1, 'one warning, not one per broker');
  assert.match(warnings[0], /--resume/);
});

// ── interrupted pass, then resumed (real checkpoint file) ────────────────────

function withCheckpointFile(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-resume-e2e-'));
    cfg.setTestCheckpointPath(path.join(dir, 'state.json.checkpoint'));
    cfg.setDryRun(false);
    try { await fn(); } finally {
      cfg.setDryRun(false);
      cfg.setTestCheckpointPath(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('a pass killed in the middle resumes at the in-progress broker', withCheckpointFile(async () => {
  // logResult throwing outside the per-broker guard is how a kill shows up here:
  // the loop unwinds mid-pass, exactly as a SIGTERM would stop it.
  const killAt = 'Row2';
  const first = await pass({
    brokers: rows(5),
    now: clock([0, 5000, 10000, 15000, 20000]),
    saveCheckpoint: cfg.saveCheckpoint,
    logResult: (name) => { if (name === killAt) throw new Error('killed'); },
  }).catch((err) => err);
  assert.equal(first.message, 'killed');

  const saved = cfg.loadCheckpoint();
  assert.deepEqual(saved, { phase: 'generic', personIndex: 0, key: 'Row2', index: 2 });

  const plan = cfg.planResume(saved, [JANE]);
  const resumed = await pass({ brokers: rows(5), resumeFrom: plan[0].genericResume });
  assert.deepEqual(resumed.seen, ['Row2', 'Row3', 'Row4'], 'the row that was in progress runs again; nothing after it was skipped');
}));

test('two persons: person 0 finished, person 1 killed mid-pass; resume skips person 0 and resumes person 1', withCheckpointFile(async () => {
  const persons = [JANE, JOHN];
  const processed = [];
  const runFor = async (person, index, extra) => gr.runGenericBrokers(
    makeContext(makeFakePage()), new Set(), { optOuts: {} },
    extra.logResult || (() => {}), () => {},
    {
      injectedBrokers: rows(4), person, personCount: persons.length, personIndex: index,
      now: clock([0, 5000, 10000, 15000, 20000]),
      saveCheckpoint: cfg.saveCheckpoint,
      injectedProcessFn: async (_p, b) => { processed.push(`${person.firstName}:${b.name}`); return { status: 'manual', detail: '' }; },
      ...extra.opts,
    },
  );

  await runFor(JANE, 0, {});
  await assert.rejects(
    runFor(JOHN, 1, { logResult: (name) => { if (name === 'Row2') throw new Error('killed'); } }),
    /killed/,
  );
  assert.deepEqual(processed.filter(p => p.startsWith('John')), ['John:Row0', 'John:Row1', 'John:Row2']);

  const plan = cfg.planResume(cfg.loadCheckpoint(), persons);
  assert.equal(plan[0].skipGeneric, true);
  assert.deepEqual(plan[1].genericResume, { index: 2, key: 'Row2|John Roe' });

  processed.length = 0;
  for (const [index, person] of persons.entries()) {
    if (plan[index].skipGeneric) continue;
    await runFor(person, index, { opts: { resumeFrom: plan[index].genericResume || undefined } });
  }
  assert.deepEqual(processed, ['John:Row2', 'John:Row3'], 'only the unfinished person, from the in-progress row');
}));
