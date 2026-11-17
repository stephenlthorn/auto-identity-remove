'use strict';

/**
 * test/generic-runner-fields.test.js - Q4: the generic pass reports its fields too.
 *
 * fillGenericForm decides which detail goes in which field (getFieldMap). That
 * decision is recorded as the form is filled, so the report lists what was typed,
 * by name. A preview with fields fills the form WITHOUT submitting it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processGenericUrl, runGenericBrokers, fillGenericForm, _setConfig } = require('../generic-runner');
const { makeFakePage, makeContext, optOutForm } = require('./helpers/generic-fake-page');
const fr = require('../lib/field-report');

const PERSON = {
  firstName: 'ZqFirstNameZq', lastName: 'ZqLastNameZq', fullName: 'ZqFirstNameZq ZqLastNameZq',
  email: 'zq.email.zq@example.com', state: 'ZqStateZq', zip: 'ZqZipZq',
  phone: '5125550142', phoneFormatted: '(512) 555-0142',
};
const VALUES = [PERSON.firstName, PERSON.lastName, PERSON.fullName, PERSON.email, PERSON.state, PERSON.zip, PERSON.phone, PERSON.phoneFormatted];
const ALIAS = 'alias.zq@relay.example';
const BROKER = { name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'markup' };

test.before(() => _setConfig({ person: PERSON }));

const pageWith = (fields) => makeFakePage({
  forms: [optOutForm({ fields, afterSubmit: { body: 'Your request has been received.' } })],
});

test('fillGenericForm records the detail behind every field it typed into', async () => {
  const page = pageWith(['email', 'firstName', 'lastName', 'state', 'zip', 'phone']);
  const record = [];
  await fillGenericForm(page, PERSON, { record });
  assert.deepEqual(record.map(t => t.detail), ['email', 'firstName', 'lastName', 'state', 'zip', 'phone']);
  assert.equal(record.length, page.filled.length, 'one record per field actually typed');
  assert.ok(record.every(t => t.masked === false));
});

test('with a relay alias the email is recorded as masked', async () => {
  const page = pageWith(['email']);
  const record = [];
  await fillGenericForm(page, PERSON, { record, submissionEmail: ALIAS });
  assert.deepEqual(record.map(t => [t.detail, t.masked]), [['email', true]]);
});

test('a preview with fields reports what a real run would type, without typing or submitting', async () => {
  const page = pageWith(['email', 'firstName', 'lastName', 'phone']);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true });
  assert.equal(result.status, 'skipped');
  assert.match(result.detail, /dry-run/);
  assert.deepEqual(result.fieldEntries.map(e => e.details[0]), ['email', 'first name', 'last name', 'phone']);
  assert.ok(result.fieldEntries.every(e => !('value' in e)), 'no value unless showValues');
  assert.equal(page.clicked.filter(c => c.sel.includes('submit')).length, 0, 'nothing is submitted');
  assert.equal(page.filled.length, 0, 'nothing is typed in a preview');
});

test('a preview with fields and showValues carries the values in the entries', async () => {
  const page = pageWith(['email']);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true, showValues: true });
  assert.equal(result.fieldEntries[0].value, PERSON.email);
});

test('a plain dry run still stops before filling anything', async () => {
  const page = pageWith(['email', 'firstName']);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON });
  assert.deepEqual(result, { status: 'skipped', detail: 'dry-run - generic opt-out not submitted' });
  assert.deepEqual(page.filled, []);
});

test('a page with no opt-out form reports nothing and still ends as a dry-run skip', async () => {
  const page = makeFakePage({ forms: [] });
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true });
  assert.equal(result.status, 'skipped');
  assert.equal(result.fieldEntries, undefined);
});

test('a real run attaches the names of the details typed, never values', async () => {
  const page = pageWith(['email', 'firstName', 'phone']);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, submissionEmail: ALIAS });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.fields, ['first name', 'masked email', 'phone']);
  assert.equal(result.fieldEntries, undefined);
});

test('runGenericBrokers hands preview entries to the field report and prints no value', async () => {
  const lines = [];
  const report = fr.createFieldReport({ log: (l) => lines.push(l) });
  const page = pageWith(['email', 'firstName']);
  const logged = [];
  const realLog = console.log;
  const realWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a) => logged.push(a.join(' '));
  process.stdout.write = (chunk) => { logged.push(String(chunk)); return true; };
  try {
    await runGenericBrokers(makeContext(page), new Set(), { optOuts: {} }, (n, s, d) => logged.push(`${n} ${s} ${d}`), () => {}, {
      dryRun: true, person: PERSON, injectedBrokers: [BROKER], previewFields: true, fieldReport: report,
    });
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
  }
  const out = [...lines, ...logged, ...report.renderTables()].join('\n');
  assert.match(out, /ExampleBroker\s+\|\s+first name, email/);
  for (const v of VALUES) assert.ok(!out.includes(v), `"${v}" leaked`);
});

test('runGenericBrokers puts the typed names on the logged result of a real run', async () => {
  const page = pageWith(['email', 'firstName']);
  const calls = [];
  const realLog = console.log;
  const realWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = () => true;
  try {
    await runGenericBrokers(makeContext(page), new Set(), { optOuts: {} }, (n, s, d, extra) => calls.push({ n, s, extra }), () => {}, {
      person: PERSON, injectedBrokers: [BROKER],
    });
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
  }
  const row = calls.find(c => c.n === 'ExampleBroker');
  assert.deepEqual(row.extra.fields, ['first name', 'email']);
  assert.equal(JSON.stringify(row).includes(PERSON.email), false);
});

// ── a preview must not type anything into the page ───────────────────────────

const MUTATORS = ['fill', 'type', 'press', 'pressSequentially', 'selectOption', 'check', 'click', 'setInputFiles', 'dispatchEvent'];

/**
 * Wraps a fake page so every mutating call on any locator is recorded, and models
 * a form whose fields start empty and fire `input` / `change` events when written
 * to, like a page with a session-replay script listening.
 */
function instrumented(page) {
  const probe = { calls: [], values: {}, events: { input: 0, change: 0 } };
  const wrap = (loc) => new Proxy(loc, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (MUTATORS.includes(prop)) {
        return (...args) => {
          probe.calls.push(prop);
          if (prop === 'fill' || prop === 'type' || prop === 'pressSequentially') { probe.events.input++; probe.values[String(Math.random())] = args[0]; }
          if (prop === 'selectOption' || prop === 'check') probe.events.change++;
          return v.apply(target, args);
        };
      }
      if (['first', 'nth', 'locator'].includes(prop)) return (...args) => wrap(v.apply(target, args));
      return v.bind(target);
    },
  });
  const original = page.locator;
  page.locator = (sel) => wrap(original(sel));
  return probe;
}

test('a preview with fields types nothing: no fill, no events, every field still empty', async () => {
  const page = pageWith(['email', 'firstName', 'lastName', 'state', 'zip', 'phone']);
  const probe = instrumented(page);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true });
  assert.deepEqual(probe.calls, [], 'no mutating call of any kind');
  assert.deepEqual(probe.events, { input: 0, change: 0 });
  assert.deepEqual(probe.values, {});
  assert.deepEqual(page.filled, []);
  assert.deepEqual(result.fieldEntries.map(e => e.details[0]), ['email', 'first name', 'last name', 'state', 'ZIP', 'phone']);
});

test('the supplementary phone rule holds in a preview: a lone phone box is not reported', async () => {
  const page = pageWith(['phone']);
  const probe = instrumented(page);
  const result = await processGenericUrl(page, BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true });
  assert.deepEqual(probe.calls, []);
  assert.equal(result.fieldEntries, undefined);
});

test('the same form reports the same details in a preview as a real run types', async () => {
  const fields = ['email', 'firstName', 'lastName', 'phone'];
  const preview = await processGenericUrl(pageWith(fields), BROKER, { optOuts: {} }, true, new Set(), { person: PERSON, previewFields: true });
  const real = await processGenericUrl(pageWith(fields), BROKER, { optOuts: {} }, false, new Set(), { person: PERSON });
  assert.deepEqual(fr.detailNames(preview.fieldEntries), real.fields);
});

test('F1: with no relay (submission email is the person\'s own address) the email is not "masked"', async () => {
  const page = pageWith(['email']);
  const record = [];
  await fillGenericForm(page, PERSON, { record, submissionEmail: ` ${PERSON.email.toUpperCase()} ` });
  assert.deepEqual(record.map(t => [t.detail, t.masked]), [['email', false]]);
  const entries = fr.entriesFromGeneric(record);
  assert.deepEqual(entries[0].details, ['email']);
});
