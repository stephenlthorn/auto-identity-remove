/**
 * test/checkpoint-plan-resume.test.js
 *
 * R2: planResume(checkpoint, persons) is the pure decision the watcher makes
 * before `--resume` touches a browser. The run order is
 *   explicit pass for person 0..n-1, THEN generic pass for person 0..n-1,
 * so a checkpoint says exactly which of those 2n passes were already finished.
 *
 * It returns one entry per person:
 *   skipExplicit      this person's explicit pass (and email opt-outs) is done
 *   explicitResumeKey the checkpoint key to hand to findResumeIndex (only for
 *                     the person the explicit checkpoint belongs to), else null
 *   skipGeneric       this person's generic pass is done
 *   genericResume     { index, key } for the person the generic checkpoint is in
 *                     the middle of, else null
 *
 * Skipping is only ever done on evidence. A checkpoint that cannot be pinned to
 * a current person (the person list changed since the run was interrupted)
 * skips nothing: re-running is cheap, silently skipping someone is not.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planResume } = require('../lib/config');

const ALICE = { firstName: 'Alice', lastName: 'Adams' };
const BOB = { firstName: 'Bob', lastName: 'Baker' };
const CAROL = { firstName: 'Carol', lastName: 'Cole' };

const NOTHING = { skipExplicit: false, explicitResumeKey: null, skipGeneric: false, genericResume: null };

test('no checkpoint: nobody is skipped', () => {
  assert.deepEqual(planResume(null, [ALICE, BOB]), [NOTHING, NOTHING]);
  assert.deepEqual(planResume(undefined, [ALICE]), [NOTHING]);
});

test('an empty or missing person list yields an empty plan', () => {
  assert.deepEqual(planResume('Spokeo', []), []);
  assert.deepEqual(planResume('Spokeo', undefined), []);
});

test('plain-string checkpoint, single person: that person resumes the explicit list at the key', () => {
  assert.deepEqual(planResume('Spokeo', [ALICE]), [{ ...NOTHING, explicitResumeKey: 'Spokeo' }]);
});

test('plain-string composite checkpoint: persons before the named one skip their explicit pass', () => {
  const plan = planResume('Spokeo|Bob Baker', [ALICE, BOB, CAROL]);
  assert.deepEqual(plan, [
    { ...NOTHING, skipExplicit: true },
    { ...NOTHING, explicitResumeKey: 'Spokeo|Bob Baker' },
    { ...NOTHING },
  ]);
});

test('plain-string composite checkpoint for the first person skips nobody', () => {
  const plan = planResume('Spokeo|Alice Adams', [ALICE, BOB]);
  assert.deepEqual(plan, [
    { ...NOTHING, explicitResumeKey: 'Spokeo|Alice Adams' },
    { ...NOTHING },
  ]);
});

test('a bare checkpoint with several persons names nobody, so it skips nothing (same as findResumeIndex)', () => {
  assert.deepEqual(planResume('Spokeo', [ALICE, BOB]), [NOTHING, NOTHING]);
});

test('a composite checkpoint for a person who is no longer in the config skips nothing', () => {
  assert.deepEqual(planResume('Spokeo|Zed Zane', [ALICE, BOB]), [NOTHING, NOTHING]);
});

test('a composite checkpoint with one configured person skips nothing (the person list shrank)', () => {
  assert.deepEqual(planResume('Spokeo|Bob Baker', [ALICE]), [NOTHING]);
});

test('structured explicit checkpoint behaves like the plain composite string', () => {
  const plan = planResume({ phase: 'explicit', personIndex: 1, key: 'Spokeo|Bob Baker', index: 7 }, [ALICE, BOB]);
  assert.deepEqual(plan, [
    { ...NOTHING, skipExplicit: true },
    { ...NOTHING, explicitResumeKey: 'Spokeo|Bob Baker' },
  ]);
});

test('generic checkpoint: the explicit pass is finished for everyone, earlier persons are finished generically, the named one resumes', () => {
  const record = { phase: 'generic', personIndex: 1, key: 'Acme Data|Bob Baker', index: 42 };
  const plan = planResume(record, [ALICE, BOB, CAROL]);
  assert.deepEqual(plan, [
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: true, genericResume: null },
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: false, genericResume: { index: 42, key: 'Acme Data|Bob Baker' } },
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: false, genericResume: null },
  ]);
});

test('generic checkpoint, single person, bare key', () => {
  const plan = planResume({ phase: 'generic', personIndex: 0, key: 'Acme Data', index: 3 }, [ALICE]);
  assert.deepEqual(plan, [
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: false, genericResume: { index: 3, key: 'Acme Data' } },
  ]);
});

test('generic checkpoint that cannot be pinned to a person still skips the finished explicit pass but restarts every generic pass', () => {
  const plan = planResume({ phase: 'generic', personIndex: 5, key: 'Acme Data|Zed Zane', index: 3 }, [ALICE, BOB]);
  assert.deepEqual(plan, [
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: false, genericResume: null },
    { skipExplicit: true, explicitResumeKey: null, skipGeneric: false, genericResume: null },
  ]);
});

test('persons reordered since the checkpoint: the name in the key wins over a stale personIndex', () => {
  // Checkpoint written when Bob was person 0; the config now lists Alice first.
  const record = { phase: 'generic', personIndex: 0, key: 'Acme Data|Bob Baker', index: 9 };
  const plan = planResume(record, [ALICE, BOB]);
  assert.equal(plan[0].skipGeneric, true, 'Alice came before Bob in this run order now');
  assert.deepEqual(plan[1].genericResume, { index: 9, key: 'Acme Data|Bob Baker' });
});

test('two persons with the same name: personIndex breaks the tie', () => {
  const twin = { firstName: 'Sam', lastName: 'Lee' };
  const other = { firstName: 'Sam', lastName: 'Lee' };
  const record = { phase: 'generic', personIndex: 1, key: 'Acme Data|Sam Lee', index: 4 };
  const plan = planResume(record, [twin, other]);
  assert.equal(plan[0].skipGeneric, true);
  assert.deepEqual(plan[1].genericResume, { index: 4, key: 'Acme Data|Sam Lee' });
});

test('a hand-edited generic checkpoint with no index still resumes (by name)', () => {
  const plan = planResume({ phase: 'generic', personIndex: 0, key: 'Acme Data', index: null }, [ALICE]);
  assert.deepEqual(plan[0].genericResume, { index: null, key: 'Acme Data' });
});

test('planResume does not mutate its inputs', () => {
  const persons = Object.freeze([Object.freeze({ ...ALICE }), Object.freeze({ ...BOB })]);
  const record = Object.freeze({ phase: 'generic', personIndex: 1, key: 'Acme Data|Bob Baker', index: 2 });
  assert.doesNotThrow(() => planResume(record, persons));
});
