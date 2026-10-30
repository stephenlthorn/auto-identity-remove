/**
 * test/checkpoint-done.test.js
 *
 * BRK2-9, the half that lives outside generic-runner.js. The generic pass can list
 * the rows it finished in its checkpoint (opts.checkpointDone: `done`, fingerprints
 * of state keys) so a --resume after a feed update skips exactly those rows, an
 * inserted row included in the rest. That only works if the list survives the trip:
 *
 *   saveCheckpoint -> the file -> loadCheckpoint -> planResume -> opts.resumeFrom
 *
 * normalizeCheckpoint dropped every field it did not know, so `done` never reached
 * the file, and a moved list always started over from the top. And the watcher never
 * asked the runner for it (checkpointDone).
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext } = require('./helpers/generic-fake-page');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

let dir;
let ckpt;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-ckpt-done-'));
  ckpt = path.join(dir, 'state.json.checkpoint');
  cfg.setTestCheckpointPath(ckpt);
  cfg.setDryRun(false);
});

afterEach(() => {
  cfg.setDryRun(false);
  cfg.setTestCheckpointPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const RECORD = { phase: 'generic', personIndex: 0, key: 'D', index: 3 };
const DONE = ['0a1b2c3d4e', 'ffeeddccbb', '1234567890'];

test('normalizeCheckpoint keeps a list of finished-row fingerprints', () => {
  assert.deepEqual(cfg.normalizeCheckpoint({ ...RECORD, done: DONE }), { ...RECORD, done: DONE });
});

test('a record without one has no done key at all (older checkpoints are unchanged)', () => {
  assert.deepEqual(cfg.normalizeCheckpoint(RECORD), RECORD);
  assert.ok(!('done' in cfg.normalizeCheckpoint(RECORD)));
});

test('a done that is not a list of strings is dropped, so a hand-edited file degrades to "start over"', () => {
  for (const bad of ['abc', 7, {}, [1, 2], ['ok', null], [['nested']]]) {
    const record = cfg.normalizeCheckpoint({ ...RECORD, done: bad });
    assert.deepEqual(record, RECORD, `done: ${JSON.stringify(bad)}`);
  }
});

test('saveCheckpoint writes done and loadCheckpoint reads it back', () => {
  cfg.saveCheckpoint({ ...RECORD, done: DONE });
  assert.deepEqual(JSON.parse(fs.readFileSync(ckpt, 'utf8')), { ...RECORD, done: DONE });
  assert.deepEqual(cfg.loadCheckpoint(), { ...RECORD, done: DONE });
});

test('saveCheckpoint refuses a done that is not a list of strings and keeps the old checkpoint', () => {
  cfg.saveCheckpoint('Spokeo');
  assert.throws(() => cfg.saveCheckpoint({ ...RECORD, done: [1, 2] }), TypeError);
  assert.throws(() => cfg.saveCheckpoint({ ...RECORD, done: 'abc' }), TypeError);
  assert.equal(fs.readFileSync(ckpt, 'utf8'), 'Spokeo\n');
});

test('planResume hands the finished rows to the person the generic checkpoint is inside', () => {
  const people = [{ firstName: 'Ann', lastName: 'A' }, { firstName: 'Bob', lastName: 'B' }];
  const plan = cfg.planResume({ phase: 'generic', personIndex: 1, key: 'D|Bob B', index: 3, done: DONE }, people);
  assert.deepEqual(plan[1].genericResume, { index: 3, key: 'D|Bob B', done: DONE });
  assert.equal(plan[0].genericResume, null);
});

test('planResume keeps { index, key } exactly when the checkpoint has no finished rows', () => {
  const plan = cfg.planResume({ phase: 'generic', personIndex: 0, key: 'D', index: 3 }, [{ firstName: 'Ann', lastName: 'A' }]);
  assert.deepEqual(plan[0].genericResume, { index: 3, key: 'D' });
});

const named = (...names) => names.map((name) => ({ name, url: `https://${name.toLowerCase()}.example/x`, source: 'test' }));

async function pass({ brokers, resumeFrom }) {
  const seen = [];
  const checkpoints = [];
  await gr.runGenericBrokers(makeContext(makeFakePage()), new Set(), { optOuts: {} }, () => {}, () => {}, {
    injectedBrokers: brokers,
    resumeFrom,
    checkpointDone: true,
    now: () => 0,
    saveCheckpoint: (record) => { checkpoints.push(record); cfg.saveCheckpoint(record); },
    injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
  });
  return { seen, checkpoints };
}

test('end to end: a row a feed update inserted before the checkpoint still runs after a --resume', async () => {
  const interrupted = await pass({ brokers: named('A', 'B', 'C', 'D') });
  const atD = interrupted.checkpoints.find((c) => c.key === 'D');
  cfg.saveCheckpoint(atD);

  const plan = cfg.planResume(cfg.loadCheckpoint(), [{ firstName: 'Ann', lastName: 'A' }]);
  const resumed = await pass({ brokers: named('A', 'N', 'B', 'C', 'D'), resumeFrom: plan[0].genericResume });

  assert.deepEqual(resumed.seen, ['N', 'D'], 'only the new row and the one that was in progress run');
});

// ── the watcher asks for it and hands it on ─────────────────────────────────────

test('watcher: --resume passes checkpointDone and the stored finished rows to the generic pass', async () => {
  const sandbox = createSandbox();
  try {
    const stored = { phase: 'generic', personIndex: 0, key: 'Acme Data|Ada Lovelace', index: 3, done: DONE };
    fs.writeFileSync(sandbox.state + '.checkpoint', JSON.stringify(stored) + '\n', { mode: 0o600 });

    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--resume']);
    assert.equal(r.code, 0, r.stdout + r.stderr);

    const generic = sandbox.fakeEvents().filter(e => e.event === 'generic');
    const ada = generic.find(e => e.person === 'Ada Lovelace');
    assert.ok(ada, 'the generic pass ran for Ada');
    assert.equal(ada.checkpointDone, true, 'the runner is asked to record the finished rows');
    assert.deepEqual(ada.resumeFrom, { index: 3, key: 'Acme Data|Ada Lovelace', done: DONE });
    const alan = generic.find(e => e.person === 'Alan Turing');
    assert.equal(alan.resumeFrom, null, 'the checkpoint belongs to Ada alone');
  } finally {
    sandbox.cleanup();
  }
});
