/**
 * test/smtp.test.js
 *
 * Covers lib/smtp.js smtpTransportOptions():
 *  - without ca: plain host/port/auth, no tls override
 *  - port 465 -> secure, anything else -> STARTTLS
 *  - ca set: the PEM is loaded into tls.ca, relative to the project root
 *  - ca set but unreadable: throws naming the setting, never disables checks
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { smtpTransportOptions } = require('../lib/smtp');

const BASE = { host: '127.0.0.1', port: 1025, user: 'u@x.com', pass: 'pw' };

test('without ca there is no tls override', () => {
  const o = smtpTransportOptions(BASE);
  assert.equal(o.host, '127.0.0.1');
  assert.equal(o.port, 1025);
  assert.equal(o.secure, false);
  assert.deepEqual(o.auth, { user: 'u@x.com', pass: 'pw' });
  assert.equal(o.tls, undefined);
});

test('port defaults to 587, and only 465 is implicit TLS', () => {
  assert.equal(smtpTransportOptions({ ...BASE, port: undefined }).port, 587);
  assert.equal(smtpTransportOptions({ ...BASE, port: 465 }).secure, true);
  assert.equal(smtpTransportOptions({ ...BASE, port: 587 }).secure, false);
});

test('a relative ca is read from the root dir into tls.ca', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-smtp-'));
  try {
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
    fs.writeFileSync(path.join(dir, 'cert.pem'), pem);
    const o = smtpTransportOptions({ ...BASE, ca: 'cert.pem' }, dir);
    assert.equal(o.tls.ca, pem);
    // Trusting a specific cert must never come with verification switched off.
    assert.equal(o.tls.rejectUnauthorized, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable ca throws, naming the setting and the error code first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-smtp-'));
  try {
    assert.throws(
      () => smtpTransportOptions({ ...BASE, ca: 'missing.pem' }, dir),
      /^Error: email\.smtp\.ca unreadable \(ENOENT\)/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
