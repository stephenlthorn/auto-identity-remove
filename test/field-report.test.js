'use strict';

/**
 * test/field-report.test.js - Q4: which of the person's details go into which field.
 *
 * lib/field-report.js is pure: it maps a form-field template to the NAMES of the
 * details it carries, and renders per-broker lines and the closing table. These
 * tests use a made-up person and check that values never appear unless asked for.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fr = require('../lib/field-report');

const PERSON = {
  firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample',
  email: 'jane.sample@example.com', phone: '+1 737 555 0199',
  city: 'Springfield', state: 'IL', zip: '62701', country: 'US',
};

test('sentinelPerson gives every detail a unique token and keeps the country', () => {
  const s = fr.sentinelPerson({ country: 'GB' });
  const values = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'state', 'zip'].map(k => String(s[k]));
  assert.equal(new Set(values).size, values.length);
  assert.equal(s.country, 'GB');
});

test('detailsIn reads which details a template value carries, including composed values', () => {
  const s = fr.sentinelPerson();
  assert.deepEqual(fr.detailsIn(s.firstName, s), ['firstName']);
  assert.deepEqual(fr.detailsIn(`${s.firstName} ${s.lastName}`, s), ['firstName', 'lastName']);
  assert.deepEqual(fr.detailsIn(s.fullName, s), ['fullName']);
  assert.deepEqual(fr.detailsIn(s.email, s), ['email']);
  assert.deepEqual(fr.detailsIn('Delete my data', s), []);
});

test('detailsIn finds the phone number in both national and +country forms', () => {
  const s = fr.sentinelPerson();
  const { phoneDigits } = fr.SENTINEL;
  assert.deepEqual(fr.detailsIn(phoneDigits, s), ['phone']);
  assert.deepEqual(fr.detailsIn(`+1${phoneDigits}`, s), ['phone']);
});

test('detailLabels names details in a fixed order, "masked email" for a relay alias, "fixed text" for none', () => {
  assert.deepEqual(fr.detailLabels(['lastName', 'firstName']), ['first name', 'last name']);
  assert.deepEqual(fr.detailLabels(['zip', 'state', 'city', 'phone', 'email', 'fullName']), ['full name', 'email', 'phone', 'city', 'state', 'ZIP']);
  assert.deepEqual(fr.detailLabels(['email'], { masked: true }), ['masked email']);
  assert.deepEqual(fr.detailLabels([]), ['fixed text']);
});

test('templatesFor maps every selector of a broker to the details its value carries', () => {
  const build = (p) => [{ name: 'Fixture', formFields: { '#n': p.fullName, '#e': p.email, '#s': p.state, '#t': 'Delete', '#c': `${p.city}, ${p.state}` } }];
  const t = fr.templatesFor('Fixture', build, PERSON);
  assert.deepEqual(t['#n'], ['fullName']);
  assert.deepEqual(t['#e'], ['email']);
  assert.deepEqual(t['#s'], ['state']);
  assert.deepEqual(t['#t'], []);
  assert.deepEqual(t['#c'], ['city', 'state']);
});

test('templatesFor follows the region aliases fillForm adds for a non-US person', () => {
  const build = (p) => [{ name: 'Fixture', formFields: { 'input[name*="state" i]': p.state } }];
  const t = fr.templatesFor('Fixture', build, { ...PERSON, country: 'GB' });
  const aliased = Object.keys(t).find(sel => /province/.test(sel));
  assert.deepEqual(t[aliased], ['state']);
});

test('templatesFor returns null when the broker cannot be rebuilt, never "fixed text"', () => {
  assert.equal(fr.templatesFor('Nope', () => [], PERSON), null);
  assert.equal(fr.templatesFor('Fixture', () => { throw new Error('boom'); }, PERSON), null);
});

test('entriesFromTyped labels what was typed and drops values unless showValues', () => {
  const templates = { '#n': ['fullName'], '#e': ['email'] };
  const typed = [
    { selector: '#n', value: 'Jane Sample' },
    { selector: '#e', value: 'alias@relay.example', masked: true },
  ];
  const names = fr.entriesFromTyped(typed, templates);
  assert.deepEqual(names.map(e => e.details), [['full name'], ['masked email']]);
  assert.ok(names.every(e => !('value' in e)));
  const shown = fr.entriesFromTyped(typed, templates, { showValues: true });
  assert.deepEqual(shown.map(e => e.value), ['Jane Sample', 'alias@relay.example']);
});

test('entriesFromTyped says "unmapped" when there is no template, so a detail is never called fixed', () => {
  const e = fr.entriesFromTyped([{ selector: '#x', value: 'Jane' }], null);
  assert.deepEqual(e[0].details, ['unmapped']);
});

test('fieldLabel makes a readable name out of a selector', () => {
  assert.equal(fr.fieldLabel('input[name="firstName"]'), 'firstName');
  assert.equal(fr.fieldLabel('select[name*="state" i]'), 'state');
  assert.equal(fr.fieldLabel('input[type="email"]'), 'email');
  assert.equal(fr.fieldLabel('#phoneNumber'), 'phoneNumber');
});

test('detailNames flattens entries to a unique name list (for the audit report)', () => {
  const entries = [{ field: 'a', details: ['first name'] }, { field: 'b', details: ['first name', 'last name'] }, { field: 'c', details: ['fixed text'] }];
  assert.deepEqual(fr.detailNames(entries), ['first name', 'last name', 'fixed text']);
});

test('the collector prints per-broker lines and a closing table with totals', () => {
  const lines = [];
  const report = fr.createFieldReport({ log: (l) => lines.push(l) });
  report.add('Alpha', [{ field: 'firstName', details: ['first name'] }, { field: 'email', details: ['email'] }]);
  report.add('Beta', [{ field: 'phone', details: ['phone'] }, { field: 'email', details: ['masked email'] }]);
  report.add('Gamma', []);
  const out = lines.join('\n');
  assert.match(out, /Alpha/);
  assert.match(out, /firstName/);
  const table = report.renderTables().join('\n');
  assert.match(table, /Alpha\s+\|\s+first name, email/);
  assert.match(table, /Beta\s+\|\s+masked email, phone/);
  assert.match(table, /Gamma\s+\|\s+\(nothing typed\)/);
  assert.match(table, /phone: 1 of 3/);
  assert.match(table, /email: 1 of 3/);
  assert.match(table, /masked email: 1 of 3/);
});

test('the collector never holds or prints a value without showValues, even if one is passed in', () => {
  const lines = [];
  const report = fr.createFieldReport({ log: (l) => lines.push(l) });
  report.add('Alpha', [{ field: 'first', details: ['first name'], value: 'Jane' }]);
  assert.ok(!/Jane/.test(lines.join('\n') + report.renderTables().join('\n')));
});

test('with showValues the per-broker line carries the value but the table still does not', () => {
  const lines = [];
  const report = fr.createFieldReport({ log: (l) => lines.push(l), showValues: true });
  report.add('Alpha', [{ field: 'first', details: ['first name'], value: 'Jane' }]);
  assert.match(lines.join('\n'), /Jane/);
  assert.ok(!/Jane/.test(report.renderTables().join('\n')));
});

test('one table per person when persons are set', () => {
  const report = fr.createFieldReport({ log() {} });
  report.setPerson('Jane Sample');
  report.add('Alpha', [{ field: 'e', details: ['email'] }]);
  report.setPerson('Joe Sample');
  report.add('Alpha', [{ field: 'p', details: ['phone'] }]);
  const out = report.renderTables().join('\n');
  assert.match(out, /Jane Sample/);
  assert.match(out, /Joe Sample/);
  assert.equal(out.match(/Alpha/g).length, 2);
});

test('a broker reached twice in one person pass merges its details', () => {
  const report = fr.createFieldReport({ log() {} });
  report.add('Alpha', [{ field: 'e', details: ['email'] }]);
  report.add('Alpha', [{ field: 'p', details: ['phone'] }]);
  assert.match(report.renderTables().join('\n'), /Alpha\s+\|\s+email, phone/);
});
