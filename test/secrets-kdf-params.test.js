/**
 * test/secrets-kdf-params.test.js
 *
 * CFG-14: the envelope used scrypt N=2^14 with the parameters implied by the
 * code rather than stored in the file, and decryptConfig did not pin the GCM
 * tag length (Node accepts a truncated tag of 4+ bytes, which weakens the
 * forgery bound from 2^-128 to 2^-32).
 *
 * Contract:
 *   - new envelopes carry kdf: { N, r, p } with N = 2^17;
 *   - envelopes written by the old code (kdf: 'scrypt', no params) still
 *     decrypt, using the legacy N = 2^14 default;
 *   - any tag that is not 16 bytes is rejected before decryption.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const secrets = require('../lib/secrets');

const PLAIN = {
  person: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
  capsolver: { apiKey: 'CAP-SECRET-123' },
};
const PASS = 'correct horse battery staple';

// Produced by the pre-CFG-14 encryptConfig (scrypt N=2^14, kdf: 'scrypt', no params).
const LEGACY_PASSPHRASE = 'legacy-passphrase';
const LEGACY_PLAIN = {
  person: { firstName: 'Legacy', lastName: 'Fixture', email: 'legacy@example.com', zip: '00000' },
  notify: { textTo: '+15555550100' },
};
const LEGACY_ENVELOPE = {
  v: 1,
  alg: 'aes-256-gcm',
  kdf: 'scrypt',
  salt: 'b364b5bdd4e0299e05141951f89074a1',
  iv: '50bf60f28bf20ea0ab975323',
  tag: '06c886617ebcf8d4319e0fcbf0692c41',
  ciphertext:
    '671e2c313d2587871a12a6d4889f2cd1a2a7df5fe7026a09cdaf073b53465a9edece166323980cfd903db1987b0319f5' +
    '48ba6937f02d74d7c3df93f8f6142a10fa90c15974f3e7cbf92fe459a4bd1cf1f0d2bb12df44b435e1c6b8879c3dababe' +
    '5408b1e9a15be6721448eeaa32252f5a26bf8e95852eadd0be8ce77ab3dc3a4fa508037',
};

test('new envelopes record the scrypt parameters, with N = 2^17', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.deepEqual(env.kdf, { N: 131072, r: 8, p: 1 });
});

test('a new envelope round-trips with the stronger parameters', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.deepEqual(secrets.decryptConfig(env, PASS), PLAIN);
});

test('an envelope written by the old code (no params, kdf: "scrypt") still decrypts', () => {
  assert.deepEqual(secrets.decryptConfig(LEGACY_ENVELOPE, LEGACY_PASSPHRASE), LEGACY_PLAIN);
});

test('the legacy fixture is still recognised as an envelope', () => {
  assert.equal(secrets.isEncryptedEnvelope(LEGACY_ENVELOPE), true);
});

test('the stored parameters are what decryption uses, not the current default', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const weaker = { ...env, kdf: { ...env.kdf, N: 16384 } };
  assert.throws(() => secrets.decryptConfig(weaker, PASS), /failed to decrypt/);
});

test('a truncated GCM tag is rejected, not accepted as a weaker check', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  for (const bytes of [4, 8, 12, 15]) {
    const short = { ...env, tag: env.tag.slice(0, bytes * 2) };
    assert.throws(() => secrets.decryptConfig(short, PASS), /tag/i, `${bytes}-byte tag must be rejected`);
  }
});

test('an over-long tag is rejected too', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig({ ...env, tag: env.tag + '00' }, PASS), /tag/i);
});

test('a truncated tag on a legacy envelope is rejected as well', () => {
  const short = { ...LEGACY_ENVELOPE, tag: LEGACY_ENVELOPE.tag.slice(0, 8) };
  assert.throws(() => secrets.decryptConfig(short, LEGACY_PASSPHRASE), /tag/i);
});

test('absurd kdf parameters are refused before any memory is allocated', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  for (const bad of [
    { ...env.kdf, N: 3 },
    { ...env.kdf, N: 2 ** 30 },
    { ...env.kdf, N: 100000 },
    { ...env.kdf, r: 0 },
    { ...env.kdf, p: 1000 },
    { ...env.kdf, N: 'big' },
  ]) {
    assert.throws(() => secrets.decryptConfig({ ...env, kdf: bad }, PASS), /kdf/i, JSON.stringify(bad));
  }
});
