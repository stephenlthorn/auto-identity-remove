/**
 * test/browser-dialogs.test.js
 *
 * Playwright auto-DISMISSES every JavaScript dialog unless a listener is
 * attached. "Are you sure you want to opt out?" is a confirm(), so dismissing it
 * silently aborts the opt-out while the runner carries on and reports on the
 * page text. acceptOptOutDialogs() attaches a listener that accepts confirm and
 * alert (and beforeunload, so navigation is not blocked) and logs that it did.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { acceptOptOutDialogs } = require('../lib/browser');
const { loadRunner, makePage, makeContext, PERSON, SUBMIT_BROKER } = require('./broker-runner-harness');

function fakeDialog(type, message = 'Are you sure you want to remove Jane Doe?') {
  const d = {
    accepted: 0,
    dismissed: 0,
    type: () => type,
    message: () => message,
    accept: async () => { d.accepted++; },
    dismiss: async () => { d.dismissed++; },
  };
  return d;
}

function fakePage() {
  const page = { handlers: {}, on(event, fn) { page.handlers[event] = fn; } };
  return page;
}

test('a confirm() dialog is accepted, not auto-dismissed', async () => {
  const page = fakePage();
  const lines = [];
  acceptOptOutDialogs(page, { log: (l) => lines.push(l) });

  const dialog = fakeDialog('confirm');
  await page.handlers.dialog(dialog);

  assert.equal(dialog.accepted, 1);
  assert.equal(dialog.dismissed, 0);
});

test('alert and beforeunload dialogs are accepted too', async () => {
  const page = fakePage();
  acceptOptOutDialogs(page, { log: () => {} });

  for (const type of ['alert', 'beforeunload']) {
    const dialog = fakeDialog(type);
    await page.handlers.dialog(dialog);
    assert.equal(dialog.accepted, 1, `${type} should be accepted`);
  }
});

test('a prompt() is dismissed: the runner has nothing sensible to type into it', async () => {
  const page = fakePage();
  acceptOptOutDialogs(page, { log: () => {} });

  const dialog = fakeDialog('prompt');
  await page.handlers.dialog(dialog);

  assert.equal(dialog.accepted, 0);
  assert.equal(dialog.dismissed, 1);
});

test('the log says a dialog was accepted but never echoes its text', async () => {
  const page = fakePage();
  const lines = [];
  acceptOptOutDialogs(page, { log: (l) => lines.push(l) });

  await page.handlers.dialog(fakeDialog('confirm', 'Remove Jane Doe at 12 Elm St?'));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /dialog accepted/i);
  assert.match(lines[0], /confirm/);
  assert.ok(!/Jane|Elm/.test(lines[0]), `dialog text leaked into the log: ${lines[0]}`);
});

test('a dialog that throws on accept does not crash the handler', async () => {
  const page = fakePage();
  acceptOptOutDialogs(page, { log: () => {} });

  const dialog = fakeDialog('confirm');
  dialog.accept = async () => { throw new Error('Cannot accept dialog which is already handled'); };

  await assert.doesNotReject(() => page.handlers.dialog(dialog));
});

test('a page without .on() is tolerated (minimal mocks)', () => {
  assert.doesNotThrow(() => acceptOptOutDialogs({}, { log: () => {} }));
  assert.doesNotThrow(() => acceptOptOutDialogs(null, { log: () => {} }));
});

test('broker-runner attaches the dialog handler to the page it drives', async () => {
  const h = loadRunner();
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });

  await h.runner.processBrokerWithPerson(makeContext(page), SUBMIT_BROKER, PERSON);

  assert.equal(typeof page.handlers.dialog, 'function', 'runner must register a dialog handler');
  const dialog = fakeDialog('confirm');
  await page.handlers.dialog(dialog);
  assert.equal(dialog.accepted, 1);
});
