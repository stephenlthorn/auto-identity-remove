/**
 * test/broker-runner-country-case.test.js
 *
 * BRK-14: `country: "us"` (lowercase) is a normal way to write the code, but the
 * usOnly comparison was case-sensitive, so every US-only broker was skipped for
 * a US user.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext } = require('./broker-runner-harness');

const US_ONLY = {
  name: 'UsOnlyBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
  usOnly: true,
};

async function statusFor(country) {
  const h = loadRunner();
  const person = { firstName: 'A', lastName: 'B', country };
  h.runner.configure({ dryRun: false, person, personCount: 1, capsolver: null });
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });
  await h.runner.processBrokerWithPerson(makeContext(page), US_ONLY, person);
  return h.logged.at(-1).status;
}

test('BRK-14: lowercase, mixed-case and padded "us" are treated as US', async () => {
  for (const country of ['us', 'Us', ' US ', 'US', undefined]) {
    assert.equal(await statusFor(country), 'success', `country ${JSON.stringify(country)} should run`);
  }
});

test('BRK-14: a non-US country is still skipped', async () => {
  for (const country of ['ca', 'GB', 'de']) {
    assert.equal(await statusFor(country), 'skipped', `country ${country} should be skipped`);
  }
});
