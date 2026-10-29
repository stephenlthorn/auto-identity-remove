/**
 * test/broker-runner-preview-redaction.test.js
 *
 * codex #6: --preview formatted every populated input value into the log detail,
 * which goes to stdout, the dashboard's live stream, `docker logs` and journald.
 * Preview now reports field NAMES and whether each is filled - never a value -
 * and strips the query string from the target URL (some opt-out URLs carry the
 * person's name and state as parameters).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');

const BROKER = {
  name: 'PreviewSite',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout?firstName=Jane&lastName=Doe&state=TX',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

async function preview(fields) {
  const h = loadRunner();
  h.runner.configure({ dryRun: true, preview: true, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage({ fields });
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await h.runner.processBrokerWithPerson(makeContext(page), BROKER, PERSON);
  } finally {
    console.log = realLog;
  }
  const entry = h.logged.find(l => l.status === 'preview');
  return { entry, output: lines.join('\n') + '\n' + JSON.stringify(h.logged) };
}

test('codex #6: preview lists field names and fill status, never values', async () => {
  const { entry, output } = await preview([
    { name: 'first_name', filled: true, type: 'text' },
    { name: 'email', filled: true, type: 'email' },
    { name: 'phone', filled: false, type: 'tel' },
  ]);

  assert.ok(entry, 'a preview entry is logged');
  assert.match(entry.detail, /first_name/);
  assert.match(entry.detail, /email/);
  assert.match(entry.detail, /phone/);
  assert.match(entry.detail, /filled/);
  assert.match(entry.detail, /empty|not filled/);
  assert.ok(!/Jane|Doe|@|5125550123/.test(output), `a value reached the output: ${output}`);
});

test('codex #6: even a stub that returns raw values cannot make them appear', async () => {
  const { entry, output } = await preview([
    { name: 'first', value: 'Jane', type: 'text' },
    { name: 'email', value: 'jane@example.com', type: 'email' },
  ]);

  assert.match(entry.detail, /first/);
  assert.ok(!/Jane|jane@example\.com/.test(output), `a raw value reached the output: ${output}`);
});

test('codex #6: the target URL loses its query string', async () => {
  const { entry } = await preview([]);

  assert.match(entry.detail, /example\.com\/optout/);
  assert.ok(!/firstName|Jane|lastName|state=TX/.test(entry.detail), `query leaked: ${entry.detail}`);
});

test('codex #6: preview still reports it would POST to the opt-out URL', async () => {
  const { entry } = await preview([{ name: 'email', filled: true, type: 'email' }]);
  assert.match(entry.detail, /would POST to/);
});
