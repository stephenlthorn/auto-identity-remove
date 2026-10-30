/**
 * test/broker-runner-noise.test.js
 *
 * BRK-7 / CORE-3 / NET-7: --pollute passed the module-level brokers (formFields
 * baked from the REAL person) to processBrokerWithPerson, so the "bogus"
 * submission carried the real name and email, the relay alias replaced the fake
 * email, and a success wrote the real broker's state (or a recent real success
 * silently skipped the bogus one).
 *
 * A noise submission must: use values derived from the fake person, never the
 * relay email, never read or write state or the checkpoint, and stay out of the
 * run results the report is built from.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRunner, makePage, makeContext } = require('./broker-runner-harness');
const { generateBogusPerson } = require('../lib/noise');
const buildBrokers = require('../brokers').forPerson;

const REAL = {
  firstName: 'Realfirst', lastName: 'Reallast', fullName: 'Realfirst Reallast',
  email: 'real.person@realmail.test', state: 'TX', city: 'Austin', zip: '78701',
  phone: '5125550123', country: 'US',
};
const SUBMIT = { id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true };

function setup({ submissionEmail = 'relay-alias@simplelogin.test' } = {}) {
  const h = loadRunner();
  h.runner.configure({
    dryRun: false, person: REAL, personCount: 1, capsolver: null, submissionEmail,
    brokersFor: buildBrokers,
  });
  const page = makePage({
    elements: [SUBMIT],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });
  return { ...h, page, context: makeContext(page) };
}

const realThatsThem = () => buildBrokers(REAL).find(b => b.name === 'ThatsThem');

test('NET-7: form values come from the fake person, not the real one', async () => {
  const h = setup();
  const fake = generateBogusPerson();

  // the watcher hands over the broker built for the REAL person
  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), fake);

  assert.equal(h.calls.fillForm.length, 1);
  const values = Object.values(h.calls.fillForm[0].formFields);
  assert.ok(values.includes(fake.fullName), `expected fake name in ${JSON.stringify(values)}`);
  assert.ok(values.includes(fake.email), `expected fake email in ${JSON.stringify(values)}`);
  const sent = JSON.stringify(values);
  for (const real of [REAL.fullName, REAL.firstName, REAL.lastName, REAL.email]) {
    assert.ok(!sent.includes(real), `real value "${real}" leaked into a bogus submission`);
  }
});

test('NET-7: the relay email never replaces the fake email', async () => {
  const h = setup({ submissionEmail: 'relay-alias@simplelogin.test' });
  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), generateBogusPerson());

  assert.equal(h.calls.fillForm[0].submissionEmail, undefined);
  assert.equal(h.calls.fillForm[0].person.isBogus, true);
});

test('CORE-3: a noise submission neither reads nor writes state or the checkpoint', async () => {
  const h = setup();
  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), generateBogusPerson());

  assert.deepEqual(h.recorded.checkpoints, [], 'no checkpoint');
  assert.deepEqual(h.recorded.skipChecks, [], 'no shouldSkip lookup: a recent real success must not suppress it');
  assert.deepEqual(h.recorded.success, [], 'no recordSuccess on the real broker');
  assert.deepEqual(h.recorded.pending, []);
  assert.deepEqual(h.recorded.failure, []);
  assert.equal(h.page.clicks.length, 1, 'the form is still submitted');
});

test('CORE-3: a noise failure does not write state either', async () => {
  const h = setup();
  h.page.evaluate = async (fn) => (String(fn).includes('innerText')
    ? (h.page.submitted ? 'Opt out\nThis field is required.' : 'Opt out')
    : '');
  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), generateBogusPerson());

  assert.deepEqual(h.recorded.failure, []);
});

test('noise outcomes stay out of the run results (no logResult)', async () => {
  const h = setup();
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await h.runner.processBrokerWithPerson(h.context, realThatsThem(), generateBogusPerson());
  } finally {
    console.log = realLog;
  }

  assert.deepEqual(h.logged, [], 'bogus submissions must not inflate the summary or the run log');
  assert.ok(lines.some(l => /noise/i.test(l)), 'the outcome is still printed for the operator');
});

test('{ noState: true } gives the same guarantees without the person marker', async () => {
  const h = setup();
  const notMarked = { ...generateBogusPerson(), isBogus: undefined };

  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), notMarked, { noState: true });

  assert.deepEqual(h.recorded.checkpoints, []);
  assert.deepEqual(h.recorded.success, []);
  assert.equal(h.calls.fillForm[0].submissionEmail, undefined);
  const values = Object.values(h.calls.fillForm[0].formFields);
  assert.ok(values.includes(notMarked.email));
});

test('a normal run is unchanged: real values, relay email, state written', async () => {
  const h = setup();
  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), REAL);

  assert.equal(h.calls.fillForm[0].submissionEmail, 'relay-alias@simplelogin.test');
  assert.deepEqual(h.recorded.checkpoints, ['ThatsThem']);
  assert.equal(h.recorded.success.length, 1);
  assert.equal(h.logged.at(-1).status, 'success');
});

test('a noise broker that no longer exists for the fake person is skipped, not guessed', async () => {
  const h = setup();
  h.runner.configure({ brokersFor: () => [] });

  await h.runner.processBrokerWithPerson(h.context, realThatsThem(), generateBogusPerson());

  assert.equal(h.calls.fillForm.length, 0);
  assert.equal(h.page.clicks.length, 0);
});
