/**
 * test/secrets-cache.test.js
 *
 * CFG2-11: the dashboard decrypted the config (synchronous scrypt, N=2^17: 166 ms
 * on a laptop, seconds on a NAS) on every request, and /api/summary polls every
 * 15 s. decryptConfigCached memoizes by the envelope's content and the passphrase,
 * so it can never return a result for bytes it has not verified.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const secrets = require('../lib/secrets');

const PLAIN = { person: { firstName: 'Ann', lastName: 'Probe' }, capsolver: { apiKey: 'CAP-1' } };

function countScrypt(fn) {
  const real = crypto.scryptSync;
  let n = 0;
  crypto.scryptSync = (...a) => { n += 1; return real(...a); };
  try { fn(); } finally { crypto.scryptSync = real; }
  return n;
}

test('two consecutive calls on the same envelope derive the key once', () => {
  const env = secrets.encryptConfig(PLAIN, 'pw');
  const n = countScrypt(() => {
    assert.deepEqual(secrets.decryptConfigCached(env, 'pw'), PLAIN);
    assert.deepEqual(secrets.decryptConfigCached(env, 'pw'), PLAIN);
  });
  assert.equal(n, 1);
});

test('a different envelope, or a different passphrase, is decrypted afresh', () => {
  const a = secrets.encryptConfig(PLAIN, 'pw');
  const b = secrets.encryptConfig({ ...PLAIN, extra: 1 }, 'pw');
  secrets.decryptConfigCached(a, 'pw');
  const n = countScrypt(() => {
    assert.equal(secrets.decryptConfigCached(b, 'pw').extra, 1);
    assert.throws(() => secrets.decryptConfigCached(a, 'wrong'), /failed to decrypt/);
  });
  assert.equal(n, 2);
});

test('a tampered envelope is never served from the cache', () => {
  const env = secrets.encryptConfig(PLAIN, 'pw');
  secrets.decryptConfigCached(env, 'pw');
  const flipped = env.ciphertext.slice(0, 2) === '00' ? 'ff' + env.ciphertext.slice(2) : '00' + env.ciphertext.slice(2);
  assert.throws(() => secrets.decryptConfigCached({ ...env, ciphertext: flipped }, 'pw'), /failed to decrypt/);
  assert.throws(() => secrets.decryptConfigCached({ ...env, v: 99 }, 'pw'), /unsupported envelope version/);
});

test('the caller gets a copy: changing it does not change the next answer', () => {
  const env = secrets.encryptConfig(PLAIN, 'pw');
  const first = secrets.decryptConfigCached(env, 'pw');
  first.person.firstName = 'Mallory';
  assert.equal(secrets.decryptConfigCached(env, 'pw').person.firstName, 'Ann');
});

test('failures are not cached: the right passphrase works right after a wrong one', () => {
  const env = secrets.encryptConfig(PLAIN, 'pw');
  assert.throws(() => secrets.decryptConfigCached(env, 'nope'));
  assert.deepEqual(secrets.decryptConfigCached(env, 'pw'), PLAIN);
});

test('the memo stays small', () => {
  for (let i = 0; i < 12; i += 1) secrets.decryptConfigCached(secrets.encryptConfig({ i }, 'pw'), 'pw');
  const env = secrets.encryptConfig(PLAIN, 'pw');
  secrets.decryptConfigCached(env, 'pw');
  assert.ok(secrets.__cacheSize() <= 4);
});
