// test/complaint-evidence.test.js
/**
 * NET-6 / codex #8: a regulator complaint is signed by the user and asserts
 * that a deletion request was ignored and the data is still listed. So it may
 * only be generated when
 *   (a) a DELETION request date exists - lastSuccess, never knowRequestedAt
 *       (a right-to-know request is a disclosure request), and
 *   (b) a verification pass found the person still listed AFTER the response
 *       deadline, and no later pass found them gone.
 * A broker that merely has an old lastSuccess may have complied. Overdue
 * access requests are reported separately and never become deletion complaints.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findOverdue,
  buildComplaint,
  findOverdueKnowRequests,
  formatOverdueKnowNote,
} = require('../lib/complaint');

const NOW = new Date('2026-06-09T00:00:00.000Z');
const daysBefore = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const run = (optOuts, opts = {}) => findOverdue({ optOuts }, { now: NOW, ...opts });

// -- (b) positive evidence ----------------------------------------------------

test('NET-6: lastSuccess 60 days ago with no verification is NOT a complaint', () => {
  assert.deepEqual(run({ Spokeo: { lastSuccess: daysBefore(60) } }), []);
});

test('NET-6: still listed after the deadline is a complaint, dated from lastSuccess', () => {
  const out = run({ Spokeo: { lastSuccess: daysBefore(60), verifiedStillListedAt: daysBefore(5) } });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(60));
  assert.equal(out[0].stillListedAt, daysBefore(5));
  assert.equal(out[0].daysOverdue, 15);
});

test('NET-6: a still-listed check made INSIDE the response window proves nothing yet', () => {
  // Verified at T+7 (day -53); the 45-day deadline fell on day -15.
  assert.deepEqual(run({ Spokeo: { lastSuccess: daysBefore(60), verifiedStillListedAt: daysBefore(53) } }), []);
});

test('NET-6: a still-listed check older than the last submission is stale evidence', () => {
  // Re-submitted 60 days ago; the "still listed" stamp belongs to the previous cycle.
  assert.deepEqual(run({ Spokeo: { lastSuccess: daysBefore(60), verifiedStillListedAt: daysBefore(100) } }), []);
});

test('NET-6: a later verified-clear overrides an earlier still-listed', () => {
  const out = run({
    Spokeo: {
      lastSuccess: daysBefore(60),
      verifiedStillListedAt: daysBefore(10),
      verifiedDeletedAt: daysBefore(3),
    },
  });
  assert.deepEqual(out, []);
});

test('NET-6: a later still-listed overrides an earlier verified-clear (re-listed)', () => {
  const out = run({
    Spokeo: {
      lastSuccess: daysBefore(80),
      verifiedDeletedAt: daysBefore(40),
      verifiedStillListedAt: daysBefore(3),
    },
  });
  assert.equal(out.length, 1);
});

// -- (a) a deletion request date ---------------------------------------------

test('NET-6 / codex #8: knowRequestedAt is never a deletion request date', () => {
  const state = { Intelius: { knowRequestedAt: daysBefore(90) } };
  assert.deepEqual(run(state), []);
});

test('NET-6 / codex #8: a know request does not hijack the deletion date of a real submission', () => {
  const out = run({
    Intelius: {
      knowRequestedAt: daysBefore(100),
      lastSuccess: daysBefore(60),
      verifiedStillListedAt: daysBefore(5),
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(60), 'the deletion date, not the disclosure date');
});

test('NET-6: a know request made after a verified clear does not re-flag a clean broker', () => {
  const out = run({
    Spokeo: {
      lastSuccess: daysBefore(80),
      verifiedDeletedAt: daysBefore(70),
      knowRequestedAt: daysBefore(60),
    },
  });
  assert.deepEqual(out, []);
});

test('NET-6: still-listed evidence without any deletion request is not a complaint', () => {
  assert.deepEqual(run({ Radaris: { verifiedStillListedAt: daysBefore(5) } }), []);
});

test('NET-6: pendingConfirm and lastAttempt are not deletion requests either', () => {
  assert.deepEqual(run({
    InfoTracer: { pendingConfirm: { since: daysBefore(60) }, verifiedStillListedAt: daysBefore(5) },
    PeopleFinders: { lastAttempt: daysBefore(60), verifiedStillListedAt: daysBefore(5) },
  }), []);
});

// -- the complaint text -------------------------------------------------------

const PERSON = { fullName: 'Jane Doe', city: 'Fresno', state: 'CA', zip: '93650', email: 'j@example.com' };
const BROKER = { name: 'Spokeo' };

test('NET-6: buildComplaint refuses to assert "still listed" without a verification date', () => {
  assert.throws(
    () => buildComplaint({
      person: PERSON, broker: BROKER, regime: 'CA_AG',
      overdue: { requestedAt: daysBefore(60), daysOverdue: 15, regime: 'ccpa' },
    }),
    /still listed|verification/i
  );
});

test('NET-6: the complaint states what was checked and when, and claims nothing it cannot know', () => {
  const { body } = buildComplaint({
    person: PERSON, broker: BROKER, regime: 'CA_AG',
    overdue: {
      requestedAt: daysBefore(60), stillListedAt: daysBefore(5), daysOverdue: 15, regime: 'ccpa',
    },
  });
  assert.match(body, /2026-04-10/, 'request date');
  assert.match(body, /2026-06-04/, 'date the listing was last seen');
  assert.match(body, /still (publicly )?listed/i);
  assert.doesNotMatch(body, /\bsold\b|selling/i, 'a listing is not proof of a sale');
  assert.doesNotMatch(body, /verified request/i);
  assert.doesNotMatch(body, /lawful basis for refusing/i, 'the tool cannot see the broker\'s reply');
});

// -- overdue access requests --------------------------------------------------

test('codex #8: an overdue right-to-know request is reported, not turned into a deletion complaint', () => {
  const state = { optOuts: { Pipl: { knowRequestedAt: daysBefore(60) }, Acme: { knowRequestedAt: daysBefore(10) } } };
  assert.deepEqual(findOverdue(state, { now: NOW }), []);

  const overdue = findOverdueKnowRequests(state, { now: NOW });
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].broker, 'Pipl');
  assert.equal(overdue[0].daysOverdue, 15);

  const note = formatOverdueKnowNote(overdue);
  assert.match(note, /no complaint/i);
  assert.match(note, /Pipl/);
  assert.equal(formatOverdueKnowNote([]), '');
});

test('codex #8: know-request windows follow the person (GDPR 30 days)', () => {
  const de = { firstName: 'Klaus', lastName: 'Mueller', country: 'DE' };
  const state = { optOuts: { 'Pipl|Klaus Mueller': { knowRequestedAt: daysBefore(35) } } };
  const out = findOverdueKnowRequests(state, { now: NOW, persons: [de, { firstName: 'A', lastName: 'B' }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].person, 'Klaus Mueller');
});
