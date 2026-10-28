/**
 * test/broker-runner-phone.test.js
 *
 * Two small hooks the phone-number brokers need from the runner:
 *
 *   skipReason       - set by brokers.js when this person has no value the form
 *                      requires (no phone number). The runner must log a skip
 *                      and never open a page, rather than submit an empty form
 *                      that the broker rejects every month.
 *   preClickSelector - Sync.ME opens a modal cookie <dialog> that makes its
 *                      form inert. The runner clicks it away before filling.
 *
 * Uses the same Module._load interception as the other broker-runner tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const events = [];

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: () => {},
  recordPendingConfirmation: () => {},
  recordFailure: () => {},
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => { events.push('fill'); },
    findListingUrl: async () => null,
  };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'ok' }) };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

function clearAll() {
  logged.length = 0;
  events.length = 0;
}

function makeContext({ preClickVisible = true } = {}) {
  let pagesOpened = 0;
  const ctx = {
    get pagesOpened() { return pagesOpened; },
    newPage: async () => {
      pagesOpened++;
      return {
        goto: async () => {},
        locator: (sel) => ({
          first: () => ({
            fill: async () => {},
            count: async () => 1,
            isVisible: async () => (sel.includes('Accept') ? preClickVisible : true),
            click: async () => { events.push(`click:${sel}`); },
          }),
        }),
        evaluate: async () => 'ok',
        close: async () => {},
      };
    },
  };
  return ctx;
}

test('a broker with skipReason is logged as skipped and no page is opened', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });
  const ctx = makeContext();
  const broker = {
    name: 'PhoneBroker', method: 'direct-form', optOutUrl: 'https://example.com/optout',
    formFields: { 'input[type="tel"]': '' }, submitSelector: 'button[type="submit"]',
    skipReason: 'no phone number in config.json',
  };

  await processBrokerWithPerson(ctx, broker, PERSON);

  assert.equal(ctx.pagesOpened, 0, 'no page should be opened for a skipped broker');
  assert.deepEqual(logged, [{ name: 'PhoneBroker', status: 'skipped', detail: 'no phone number in config.json' }]);
});

test('preClickSelector is clicked before the form is filled', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });
  const broker = {
    name: 'Sync.ME', method: 'direct-form', optOutUrl: 'https://example.com/unsubscribe',
    preClickSelector: 'dialog[open] button:has-text("Accept All Cookies")',
    formFields: { '#phoneNumber': '5125550000' },
    submitSelector: 'button[type="submit"]',
  };

  await processBrokerWithPerson(makeContext(), broker, PERSON);

  const clickIdx = events.indexOf('click:dialog[open] button:has-text("Accept All Cookies")');
  const fillIdx = events.indexOf('fill');
  assert.ok(clickIdx >= 0, `pre-click must happen, events: ${events.join(', ')}`);
  assert.ok(fillIdx > clickIdx, 'the form is filled only after the pre-click');
});

test('a missing preClick target does not abort the opt-out', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null });
  const broker = {
    name: 'Sync.ME', method: 'direct-form', optOutUrl: 'https://example.com/unsubscribe',
    preClickSelector: 'dialog[open] button:has-text("Accept All Cookies")',
    formFields: { '#phoneNumber': '5125550000' },
    submitSelector: 'button[type="submit"]',
  };

  await processBrokerWithPerson(makeContext({ preClickVisible: false }), broker, PERSON);

  assert.ok(!events.some(e => e.includes('Accept')), 'an invisible pre-click target is not clicked');
  assert.ok(events.includes('fill'), 'the form is still filled');
  assert.equal(logged.at(-1).status, 'success');
});
