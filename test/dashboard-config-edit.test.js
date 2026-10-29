/**
 * test/dashboard-config-edit.test.js
 *
 * DASH-2 (persons[] configs must be edited through persons[0], never grow a
 * blank sibling `person`) and DASH-4 (blank SMTP / relay / hibp forms must not
 * be saved as objects of empty strings). Pure logic: no express.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyConfigEdit, isBlankDeep, mergeConfig, maskConfig, MASK } = require('../dashboard/config-edit');

const BLANK_PERSON = {
  firstName: '', lastName: '', fullName: '', aliases: [], city: '', state: '', zip: '',
  country: '', email: '', phone: '', phoneFormatted: '',
};

const twoPeople = () => ({
  persons: [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.org', city: 'Austin' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.org', city: 'Boston' },
  ],
  capsolver: { apiKey: 'KEEP-ME' },
});

// ---- DASH-2 ----------------------------------------------------------------

test('DASH-2: a blank person is never created next to persons[]', () => {
  // The Config tab only knew about person.*, so saving SMTP on a two-person config
  // sent a blank `person`, which brokers.js then preferred over persons[0].
  const out = applyConfigEdit(twoPeople(), { person: BLANK_PERSON, email: { smtp: { host: 'smtp.example.org' } } });
  assert.equal('person' in out, false);
  assert.deepEqual(out.persons, twoPeople().persons, 'persons[] must be untouched');
  assert.equal(out.email.smtp.host, 'smtp.example.org');
});

test('DASH-2: an existing all-blank person left by the old UI is dropped on the next save', () => {
  const existing = { ...twoPeople(), person: BLANK_PERSON };
  const out = applyConfigEdit(existing, { notify: { textTo: '+15125550000' } });
  assert.equal('person' in out, false);
  assert.equal(out.notify.textTo, '+15125550000');
});

test('DASH-2: a non-blank leftover person is not silently deleted', () => {
  const existing = { ...twoPeople(), person: { firstName: 'Old', lastName: 'Entry', email: 'old@example.org' } };
  const out = applyConfigEdit(existing, { notify: { textTo: '+1' } });
  assert.equal(out.person.firstName, 'Old');
});

test('DASH-2: a person edit against a persons[] config lands on persons[0], not on a new key', () => {
  const out = applyConfigEdit(twoPeople(), { person: { firstName: 'Alicia', city: 'Dallas' } });
  assert.equal('person' in out, false);
  assert.equal(out.persons[0].firstName, 'Alicia');
  assert.equal(out.persons[0].city, 'Dallas');
  assert.equal(out.persons[0].lastName, 'Smith', 'fields not in the edit are kept');
  assert.deepEqual(out.persons[1], twoPeople().persons[1], 'other people are untouched');
});

test('DASH-2: clearing a field through a person edit clears it on persons[0]', () => {
  const out = applyConfigEdit(twoPeople(), { person: { firstName: 'Alice', city: '' } });
  assert.equal(out.persons[0].city, '');
  assert.equal(out.persons[0].firstName, 'Alice');
});

test('DASH-2: an explicit persons array in the request wins and any person is dropped', () => {
  const next = [{ firstName: 'Zed', lastName: 'Zee', email: 'z@example.org' }];
  const out = applyConfigEdit(twoPeople(), { persons: next, person: { firstName: 'Ignored' } });
  assert.deepEqual(out.persons, next);
  assert.equal('person' in out, false);
});

test('DASH-2: single-person configs behave exactly as before', () => {
  const out = applyConfigEdit({ person: { firstName: 'Jane', lastName: 'Doe' } }, { person: { firstName: 'Jane', lastName: '' } });
  assert.equal(out.person.lastName, '');
  assert.equal('persons' in out, false);
});

test('DASH-2: persons[] is not conjured out of a person edit on a config without it', () => {
  const out = applyConfigEdit({}, { person: { firstName: 'Jane' } });
  assert.equal(out.person.firstName, 'Jane');
  assert.equal('persons' in out, false);
});

// ---- DASH-4 ----------------------------------------------------------------

test('DASH-4: blank SMTP inputs are not saved as an object of empty strings', () => {
  const out = applyConfigEdit({ person: { firstName: 'Jane' } }, {
    email: { smtp: { host: '', port: '', user: '', from: '' } },
  });
  assert.equal(out.email && out.email.smtp, undefined);
  assert.equal('email' in out, false, 'the now-empty parent is not left behind either');
});

test('DASH-4: blank relay and hibp sections are omitted', () => {
  const out = applyConfigEdit({}, { relay: { provider: '', apiKey: '' }, hibp: { apiKey: '' } });
  assert.equal('relay' in out, false);
  assert.equal('hibp' in out, false);
});

test('DASH-4: an SMTP section with a host is kept', () => {
  const out = applyConfigEdit({}, { email: { smtp: { host: 'smtp.example.org', port: 587, user: '', from: '' } } });
  assert.equal(out.email.smtp.host, 'smtp.example.org');
  assert.equal(out.email.smtp.port, 587);
});

test('DASH-4: blanking every SMTP field of a configured section removes it', () => {
  const existing = { email: { smtp: { host: 'smtp.example.org', port: 587, user: 'u', from: 'f' } } };
  const out = applyConfigEdit(existing, { email: { smtp: { host: '', port: '', user: '', from: '' } } });
  assert.equal(out.email && out.email.smtp, undefined);
});

test('DASH-4: a blank SMTP form leaves a stored password alone, so the section survives', () => {
  // The masked password is skipped client-side; blanking only host/user must not
  // throw the stored password away.
  const existing = { email: { smtp: { host: 'h', user: 'u', pass: 'SECRET' } } };
  const out = applyConfigEdit(existing, { email: { smtp: { host: '', user: '' } } });
  assert.equal(out.email.smtp.pass, 'SECRET');
});

test('DASH-4: sections the request did not touch are never pruned', () => {
  const existing = { hibp: { _comment: 'optional', apiKey: '' }, relay: { provider: '', apiKey: '' } };
  const out = applyConfigEdit(existing, { notify: { textTo: '+1' } });
  assert.deepEqual(out.hibp, existing.hibp);
  assert.deepEqual(out.relay, existing.relay);
});

test('DASH-4: pruning keeps sibling keys of the parent', () => {
  const existing = { email: { subjectPrefix: 'Opt-out', smtp: { host: 'h' } } };
  const out = applyConfigEdit(existing, { email: { smtp: { host: '' } } });
  assert.deepEqual(out.email, { subjectPrefix: 'Opt-out' });
});

test('explicit empty string still clears a non-pruned secret (capsolver)', () => {
  const out = applyConfigEdit({ capsolver: { apiKey: 'SECRET' } }, { capsolver: { apiKey: '' } });
  assert.equal(out.capsolver.apiKey, '');
});

test('the MASK sentinel keeps the stored secret', () => {
  const out = applyConfigEdit({ capsolver: { apiKey: 'SECRET' } }, { capsolver: { apiKey: MASK } });
  assert.equal(out.capsolver.apiKey, 'SECRET');
});

test('applyConfigEdit does not mutate its inputs', () => {
  const existing = twoPeople();
  const incoming = { person: { firstName: 'Alicia' }, email: { smtp: { host: '' } } };
  const e0 = JSON.stringify(existing), i0 = JSON.stringify(incoming);
  applyConfigEdit(existing, incoming);
  assert.equal(JSON.stringify(existing), e0);
  assert.equal(JSON.stringify(incoming), i0);
});

// ---- helpers still exported for the server and its tests ---------------------

test('isBlankDeep treats comments, empty arrays and nested blanks as blank but not numbers', () => {
  assert.equal(isBlankDeep({ _comment: 'x', a: '', b: ['', ' '], c: { d: null } }), true);
  assert.equal(isBlankDeep({ port: 0 }), false);
  assert.equal(isBlankDeep({ on: false }), false);
  assert.equal(isBlankDeep('x'), false);
});

test('mergeConfig and maskConfig keep their previous behaviour', () => {
  assert.deepEqual(mergeConfig({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } });
  assert.equal(maskConfig({ relay: { apiKey: 'x' } }).relay.apiKey, MASK);
});
