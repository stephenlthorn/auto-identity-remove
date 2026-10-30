/**
 * test/redact-identity.test.js
 *
 * codex #8: a broker page often echoes what was submitted ("Thanks Jane, we sent a
 * confirmation to jane@home.example"). The runners log and record a snippet of that
 * page, which put the person's own details in run logs and state.json. The
 * configured identity values are removed from a snippet before it goes anywhere.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactIdentity, REDACTED } = require('../lib/redact-identity');

const PERSON = {
  firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'Jane.Doe@home.example',
  phone: '5125550142', phoneFormatted: '(512) 555-0142', zip: '78701', city: 'Austin', state: 'TX',
  address: '12 Elm Street Apt 4',
};

test('names, email (any case), phone (any formatting), zip and street are removed', () => {
  const text = 'Thanks Jane Doe! Sent to jane.doe@HOME.example for 12 Elm Street Apt 4, 78701. Call 512-555-0142 or +1 (512) 555 0142 or 5125550142.';
  const out = redactIdentity(text, PERSON);
  for (const secret of ['Jane', 'Doe', 'home.example', 'Elm Street', '78701', '555-0142', '555 0142', '5125550142']) {
    assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${secret} survived: ${out}`);
  }
  assert.ok(out.includes(REDACTED));
});

test('extra values (the relay alias a broker saw) are removed too', () => {
  const out = redactIdentity('Confirmation sent to hide.xyz@relay.example.', PERSON, ['hide.xyz@relay.example']);
  assert.ok(!out.includes('relay.example'));
});

test('the wording around the values is kept so the snippet is still evidence', () => {
  const out = redactIdentity('Jane Doe, your opt-out request has been received.', PERSON);
  assert.match(out, /your opt-out request has been received/);
});

test('nothing to redact: the text comes back unchanged', () => {
  assert.equal(redactIdentity('Your request has been received.', PERSON), 'Your request has been received.');
  assert.equal(redactIdentity('Jane Doe', null), 'Jane Doe');
  assert.equal(redactIdentity('', PERSON), '');
  assert.equal(redactIdentity(undefined, PERSON), '');
});

test('a value is matched as a whole word: "Doe" does not eat "Doesn\'t", a zip is not cut out of a longer number', () => {
  assert.equal(redactIdentity("Doesn't match 1787011", PERSON), "Doesn't match 1787011");
});

test('regex characters in a value are literal', () => {
  const out = redactIdentity('a+b@x.example is not (a+b)@x.example', { email: 'a+b@x.example' });
  assert.ok(!out.includes('a+b@x.example'));
});

test('a person with only an email does not crash and a blank field redacts nothing', () => {
  assert.equal(redactIdentity('hello', { email: 'a@b.example', firstName: '', zip: '  ' }), 'hello');
});
