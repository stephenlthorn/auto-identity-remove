/**
 * test/smtp-require-tls.test.js
 *
 * CFG-9: with `secure: false` nodemailer upgrades to TLS only if the server
 * offers STARTTLS, and silently continues in cleartext if it does not. A
 * network attacker who strips the STARTTLS capability from the greeting
 * therefore receives the SMTP password and every opt-out email (name, address,
 * phone) in the clear. requireTLS makes a missing STARTTLS a hard failure.
 *
 * Port 465 is implicit TLS (`secure: true`) and needs no STARTTLS. The one
 * escape hatch is an explicit `smtp.allowInsecure === true`, for a local relay
 * that really speaks plaintext.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { smtpTransportOptions } = require('../lib/smtp');

test('STARTTLS ports require TLS', () => {
  assert.equal(smtpTransportOptions({ host: 'h', port: 587 }).requireTLS, true);
  assert.equal(smtpTransportOptions({ host: 'h', port: 25 }).requireTLS, true);
  assert.equal(smtpTransportOptions({ host: 'h', port: 1025 }).requireTLS, true);
});

test('the default port (587) requires TLS', () => {
  assert.equal(smtpTransportOptions({ host: 'h' }).requireTLS, true);
});

test('port 465 is implicit TLS and does not set requireTLS', () => {
  const o = smtpTransportOptions({ host: 'h', port: 465 });
  assert.equal(o.secure, true);
  assert.notEqual(o.requireTLS, true);
});

test('allowInsecure: true is the explicit opt-out', () => {
  const o = smtpTransportOptions({ host: 'h', port: 587, allowInsecure: true });
  assert.notEqual(o.requireTLS, true);
});

test('only the boolean true opts out (strings and 1 do not)', () => {
  for (const v of ['true', 'yes', 1, 'false', false, null, '']) {
    assert.equal(smtpTransportOptions({ host: 'h', port: 587, allowInsecure: v }).requireTLS, true, String(v));
  }
});

test('requireTLS never comes with certificate verification switched off', () => {
  const o = smtpTransportOptions({ host: 'h', port: 587 });
  assert.equal(o.tls === undefined || o.tls.rejectUnauthorized === undefined, true);
});

test('config.example.json documents allowInsecure next to ca', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.equal(example.email.smtp.allowInsecure, false);
  assert.match(example.email.smtp._allowInsecure_comment, /STARTTLS/);
});
