/**
 * test/generic-resume-queue-change.test.js
 *
 * BRK2-9: --resume skipped every row BEFORE the checkpoint's key, wherever that key
 * now sat. A feed update between the interrupted run and its resume (a row inserted
 * before the checkpoint) therefore left the new row unprocessed for the whole month.
 * The rows to skip are the ones that were finished, not "the ones above the key":
 *
 *   - when the checkpoint carries the finished rows (opts.checkpointDone), exactly
 *     those are skipped and everything else runs, the inserted row included
 *   - when it does not, a list that moved is run again from the top (rows that
 *     already have a recent result are skipped by the per-row state check, cheaply)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gr = require('../generic-runner');
const { makeFakePage, makeContext } = require('./helpers/generic-fake-page');

const named = (...names) => names.map((name) => ({ name, url: `https://${name.toLowerCase()}.example/x`, source: 'test' }));

async function pass({ brokers, resumeFrom, checkpointDone = false } = {}) {
  const seen = [];
  const checkpoints = [];
  const result = await gr.runGenericBrokers(makeContext(makeFakePage()), new Set(), { optOuts: {} }, () => {}, () => {}, {
    injectedBrokers: brokers,
    resumeFrom,
    checkpointDone,
    now: () => 0,
    saveCheckpoint: (record) => checkpoints.push(record),
    injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
  });
  return { seen, checkpoints, result };
}

const keyOf = (name) => name;

test('BRK2-9: a row inserted before the checkpoint runs (queue A,N,B,C,D, checkpoint D, finished A,B,C)', async () => {
  // what the interrupted run (queue A,B,C,D) would have recorded when it reached D
  const first = await pass({ brokers: named('A', 'B', 'C', 'D'), checkpointDone: true });
  const atD = first.checkpoints.find((c) => c.key === 'D');
  assert.ok(Array.isArray(atD.done) && atD.done.length === 3, JSON.stringify(atD));

  const resumed = await pass({ brokers: named('A', 'N', 'B', 'C', 'D'), resumeFrom: atD, checkpointDone: true });
  assert.deepEqual(resumed.seen, ['N', 'D'], 'only the new row and the one in progress run');
  assert.equal(resumed.result.resumeSkipped, 3);
  assert.equal(resumed.result.count, 2);
});

test('BRK2-9: a row removed before the checkpoint costs nothing', async () => {
  const first = await pass({ brokers: named('A', 'B', 'C', 'D'), checkpointDone: true });
  const atD = first.checkpoints.find((c) => c.key === 'D');
  const resumed = await pass({ brokers: named('A', 'C', 'D'), resumeFrom: atD });
  assert.deepEqual(resumed.seen, ['D']);
});

test('BRK2-9: without the finished rows a moved list is run again from the top, never skipped on a guess', async () => {
  const resumed = await pass({ brokers: named('A', 'N', 'B', 'C', 'D'), resumeFrom: { index: 3, key: 'D' } });
  assert.deepEqual(resumed.seen, ['A', 'N', 'B', 'C', 'D']);
});

test('BRK2-9: an unchanged list resumes exactly as before', async () => {
  const resumed = await pass({ brokers: named('A', 'B', 'C', 'D'), resumeFrom: { index: 2, key: 'C' } });
  assert.deepEqual(resumed.seen, ['C', 'D']);
});

test('BRK2-9: the records of a resumed pass keep the finished rows, so a second kill still resumes correctly', async () => {
  const first = await pass({ brokers: named('A', 'B', 'C', 'D'), checkpointDone: true });
  const atD = first.checkpoints.find((c) => c.key === 'D');
  const resumed = await pass({ brokers: named('A', 'N', 'B', 'C', 'D'), resumeFrom: atD, checkpointDone: true });
  const last = resumed.checkpoints.at(-1);
  assert.equal(last.key, 'D');
  assert.equal(last.done.length, 4, 'A, B, C from before plus N from this pass');
});

test('BRK2-9: records carry no finished-row list unless asked (the stored shape is unchanged)', async () => {
  const { checkpoints } = await pass({ brokers: named('A', 'B') });
  assert.deepEqual(Object.keys(checkpoints[0]).sort(), ['index', 'key', 'personIndex', 'phase']);
});

test('BRK2-9 (pure): resolveResumeStart explains a moved list', () => {
  const queue = named('A', 'N', 'B', 'C', 'D');
  const { start, note, skip } = gr.resolveResumeStart(queue, { index: 3, key: 'D', done: [] }, keyOf);
  assert.equal(start, 0);
  assert.ok(skip instanceof Set);
  assert.match(note, /changed|moved/i);
});
