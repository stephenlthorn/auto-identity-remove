/**
 * test/broker-runner-relay.test.js
 *
 * Verifies processBrokerWithPerson forwards opts.submissionEmail to fillForm.
 * All of broker-runner's relative deps are stubbed via Module._load so no real
 * Playwright, config, captcha, or network is touched.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'jane.doe@example.com', country: 'US' };
const DIRECT_BROKER = {
  name: 'TruePeopleSearch',
  method: 'direct-form',
  optOutUrl: 'https://example.test/removal',
  formFields: { 'input[type="email"]': 'jane.doe@example.com' },
  submitSelector: 'button[type="submit"]',
};

// Minimal Playwright page/context stub. fillForm is stubbed separately so we
// only need the page object to exist and close cleanly.
function makeContext() {
  const page = {
    async goto() {},
    locator() { return { first() { return { async count() { return 0; }, async isVisible() { return false; }, async click() {}, async fill() {} }; } }; },
    async evaluate() { return ''; },
    async close() {},
  };
  return { async newPage() { return page; } };
}

/**
 * Load a fresh broker-runner with all relative deps stubbed. fillFormCalls
 * captures every (formFields, person, submissionEmail) tuple.
 */
function loadRunnerWithStubs() {
  const fillFormCalls = [];
  const logCalls = [];
  const originalLoad = Module._load.bind(Module);

  function patchedLoad(request, parent, isMain) {
    if (!parent || !parent.filename || !parent.filename.includes('broker-runner')) {
      return originalLoad(request, parent, isMain);
    }
    if (request === './config') {
      return {
        recordSuccess: () => {},
        recordPendingConfirmation: () => {},
        recordFailure: () => {},
        shouldSkip: () => null,
        saveCheckpoint: () => {},
        stateKey: (name) => name,
      };
    }
    if (request === './logger') {
      return { logResult: (broker, status, detail) => logCalls.push({ broker, status, detail }), STATUS_BUCKET: {} };
    }
    if (request === './forms') {
      return {
        fillForm: async (page, formFields, person, submissionEmail) => {
          fillFormCalls.push({ formFields, person, submissionEmail });
        },
        findListingUrl: async () => null,
      };
    }
    if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
    if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false }) };
    if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'removed' }) };
    if (request === './retry') return { withRetry: (fn) => fn() };
    if (request === './timing') return { jitterSleep: async () => {} };
    if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
    return originalLoad(request, parent, isMain);
  }

  Module._load = patchedLoad;
  delete require.cache[require.resolve('../lib/broker-runner')];
  const runner = require('../lib/broker-runner');
  Module._load = originalLoad;
  delete require.cache[require.resolve('../lib/broker-runner')];

  return { runner, fillFormCalls, logCalls };
}

test('processBrokerWithPerson forwards opts.submissionEmail to fillForm', async () => {
  const { runner, fillFormCalls } = loadRunnerWithStubs();
  runner.configure({ dryRun: false, person: PERSON, personCount: 1, submissionEmail: 'masked@aliases.simplelogin.io' });

  await runner.processBrokerWithPerson(makeContext(), DIRECT_BROKER, PERSON);

  assert.equal(fillFormCalls.length, 1, 'fillForm should be called once');
  assert.equal(fillFormCalls[0].submissionEmail, 'masked@aliases.simplelogin.io');
});

test('processBrokerWithPerson passes undefined submissionEmail when none configured', async () => {
  const { runner, fillFormCalls } = loadRunnerWithStubs();
  runner.configure({ dryRun: false, person: PERSON, personCount: 1 });

  await runner.processBrokerWithPerson(makeContext(), DIRECT_BROKER, PERSON);

  assert.equal(fillFormCalls.length, 1);
  assert.equal(fillFormCalls[0].submissionEmail, undefined);
});
