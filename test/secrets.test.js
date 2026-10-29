/**
 * test/secrets.test.js
 *
 * Security-sensitive unit tests for lib/secrets.js (pure crypto, no I/O):
 *   - round-trip fidelity (encrypt -> decrypt returns deep-equal object)
 *   - wrong passphrase is rejected (GCM auth tag mismatch -> throws)
 *   - tamper detection: flipping a byte of ciphertext / tag / iv throws
 *   - envelope shape detection (isEncryptedEnvelope)
 *   - input validation (empty passphrase, non-object plain, bad envelope)
 *
 * All values are hex strings so the envelope is JSON-serializable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const secrets = require('../lib/secrets');

const PLAIN = {
  person: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
  capsolver: { apiKey: 'CAP-SECRET-123' },
  email: { smtp: { host: 'smtp.example.com', port: 587, user: 'ada', pass: 'hunter2' } },
  notify: { textTo: '+15125550000' },
};
const PASS = 'correct horse battery staple';

function flipHexByte(hex, index) {
  // Flip the low nibble of the byte at `index` so the value is guaranteed different.
  const pos = index * 2;
  const orig = hex.slice(pos, pos + 2);
  const flipped = (parseInt(orig, 16) ^ 0x01).toString(16).padStart(2, '0');
  return hex.slice(0, pos) + flipped + hex.slice(pos + 2);
}

test('round-trip: decryptConfig(encryptConfig(x)) deep-equals x', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const out = secrets.decryptConfig(env, PASS);
  assert.deepEqual(out, PLAIN);
});

test('envelope has the documented v/salt/iv/tag/ciphertext fields as hex strings', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.equal(env.v, 1);
  for (const k of ['salt', 'iv', 'tag', 'ciphertext']) {
    assert.equal(typeof env[k], 'string', `${k} should be a string`);
    assert.match(env[k], /^[0-9a-f]+$/, `${k} should be lowercase hex`);
  }
  assert.equal(env.alg, 'aes-256-gcm');
  // CFG-14: the scrypt cost parameters are recorded in the envelope.
  assert.deepEqual(env.kdf, { N: 131072, r: 8, p: 1 });
});

test('two encryptions of the same input use different salt + iv (non-deterministic)', () => {
  const a = secrets.encryptConfig(PLAIN, PASS);
  const b = secrets.encryptConfig(PLAIN, PASS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('wrong passphrase throws (auth tag mismatch)', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig(env, 'wrong passphrase'), /decrypt/i);
});

test('tamper: flipping a ciphertext byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, ciphertext: flipHexByte(env.ciphertext, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('tamper: flipping an auth-tag byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, tag: flipHexByte(env.tag, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('tamper: flipping an iv byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, iv: flipHexByte(env.iv, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('isEncryptedEnvelope: true for a real envelope, false for a plaintext config', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.equal(secrets.isEncryptedEnvelope(PLAIN), false);
  assert.equal(secrets.isEncryptedEnvelope(null), false);
  assert.equal(secrets.isEncryptedEnvelope('string'), false);
  assert.equal(secrets.isEncryptedEnvelope({ v: 1 }), false);
});

test('encryptConfig rejects an empty passphrase', () => {
  assert.throws(() => secrets.encryptConfig(PLAIN, ''), /passphrase/i);
});

test('decryptConfig rejects an empty passphrase', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig(env, ''), /passphrase/i);
});

test('encryptConfig rejects a non-object plain value', () => {
  assert.throws(() => secrets.encryptConfig('not-an-object', PASS), /object/i);
  assert.throws(() => secrets.encryptConfig(null, PASS), /object/i);
});

test('decryptConfig rejects a value that is not an envelope', () => {
  assert.throws(() => secrets.decryptConfig({ foo: 'bar' }, PASS), /envelope/i);
});

test('decryptConfig rejects an unsupported envelope version', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig({ ...env, v: 99 }, PASS), /version/i);
});
