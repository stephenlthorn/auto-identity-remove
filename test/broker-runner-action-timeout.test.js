/**
 * test/broker-runner-action-timeout.test.js
 *
 * BRK-12 (runner part): Playwright waits 30 s per action by default. The runner
 * filled a hidden `return_url` input (30 s of waiting for it to become editable)
 * and every other missed selector cost the same, so a handful of brokers stalled
 * the run for minutes. Skip hidden inputs and give each page a short default
 * action timeout, keeping the explicit navigation timeouts.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');

const SUBMIT = { id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true };
const URL_FIELD = (visible) => ({
  id: 'return_url', matches: ['input[name*="url" i]'], inForm: true, visible,
});

const SEARCH_BROKER = {
  name: 'UrlFieldBroker',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

function run(elements, broker = SEARCH_BROKER) {
  const h = loadRunner({
    './forms': { fillForm: async () => {}, findListingUrl: async () => 'https://example.com/listing/9' },
  });
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage({ elements, before: 'Opt out', after: 'Opt out\nYour request has been received.' });
  return h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON).then(() => ({ ...h, page }));
}

test('BRK-12: a hidden profile-URL input is not filled', async () => {
  const { page } = await run([URL_FIELD(false), SUBMIT]);
  assert.deepEqual(page.fills, [], 'filling a hidden input waits the full action timeout');
});

test('BRK-12: a visible profile-URL input is still filled with the listing URL', async () => {
  const { page } = await run([URL_FIELD(true), SUBMIT]);
  assert.deepEqual(page.fills.map(f => f.value), ['https://example.com/listing/9']);
});

test('BRK-12: the page gets a short default action timeout', async () => {
  const { page } = await run([SUBMIT]);
  assert.equal(page.timeouts.default, 5000);
});

test('BRK-12: a broker can raise its own action timeout', async () => {
  const { page } = await run([SUBMIT], { ...SEARCH_BROKER, actionTimeoutMs: 12000 });
  assert.equal(page.timeouts.default, 12000);
});

test('BRK-12: explicit navigation timeouts are untouched', async () => {
  const { page } = await run([SUBMIT], { ...SEARCH_BROKER, timeoutMs: 30000 });
  assert.equal(page.gotos[0].opts.timeout, 30000);
});
