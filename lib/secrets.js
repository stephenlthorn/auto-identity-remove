/**
 * lib/secrets.js
 *
 * Pure crypto for encrypting config.json at rest. No file I/O lives here so
 * the functions are trivially unit-testable.
 *
 * Scheme:
 *   - Key derivation: scrypt (crypto.scryptSync) over the UTF-8 passphrase and
 *     a per-encryption random 16-byte salt -> 32-byte key (AES-256). The cost
 *     parameters are written into the envelope (kdf: { N, r, p }) so they can
 *     be raised later without breaking files already on disk. New envelopes use
 *     N=2^17; envelopes written before that carried `kdf: 'scrypt'` and no
 *     parameters, and are read with the N=2^14 they were written with.
 *   - Cipher: AES-256-GCM with a random 12-byte IV. The 16-byte GCM auth tag is
 *     stored in the envelope; decrypt verifies it, so any tampering with the
 *     ciphertext, IV, or tag (or a wrong passphrase) makes decrypt throw. The
 *     tag length is pinned to 16 bytes on both sides: Node otherwise accepts a
 *     truncated tag (down to 4 bytes) as valid, which would cut the forgery
 *     bound from 2^-128 to 2^-32.
 *
 * Envelope shape (all binary fields are lowercase hex strings so the envelope
 * is plain JSON):
 *   { v: 2, alg: 'aes-256-gcm', kdf: { N, r, p },
 *     salt, iv, tag, ciphertext }
 *
 * Versions: v:1 envelopes carry `kdf: 'scrypt'` (N=2^14 implied) or, from the
 * release that first recorded parameters, an explicit kdf object. v:2 is what is
 * written now: explicit parameters, always. Code that predates the parameters only
 * accepts v:1, so it refuses a v:2 file by version instead of deriving the wrong
 * key from N=2^14 and blaming the passphrase (CFG2-9). Both are read.
 */

'use strict';

const crypto = require('crypto');

const ENVELOPE_VERSION = 2; // what encryptConfig writes
const SUPPORTED_VERSIONS = Object.freeze([1, 2]); // what decryptConfig reads
const ALGO = 'aes-256-gcm';
const SALT_BYTES = 16;
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // pinned: see header
const KEY_BYTES = 32; // AES-256
const SCRYPT_COST = 131072; // N=2^17 for new envelopes (~128 MiB, ~0.3 s)
const SCRYPT_BLOCK = 8; // r
const SCRYPT_PARALLEL = 1; // p
// What envelopes written before the parameters were recorded used. Never change.
const LEGACY_KDF = Object.freeze({ N: 16384, r: 8, p: 1 });
// Sanity bounds for parameters read from a file, so a damaged or hostile
// envelope cannot make decrypt allocate gigabytes before the tag check.
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const MAX_R = 8;
const MAX_P = 4;

/**
 * The scrypt parameters an envelope was written with. Legacy envelopes (kdf is
 * the string 'scrypt', or absent) get the old default; anything else must be an
 * in-bounds { N, r, p }.
 */
function kdfParamsOf(envelope) {
  const kdf = envelope.kdf;
  if (kdf === undefined || kdf === 'scrypt') return LEGACY_KDF;
  if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf)) {
    throw new Error('decryptConfig: unsupported kdf (expected scrypt parameters)');
  }
  const { N, r, p } = kdf;
  const isPow2 = Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
  if (!isPow2 || N < MIN_N || N > MAX_N ||
      !Number.isInteger(r) || r < 1 || r > MAX_R ||
      !Number.isInteger(p) || p < 1 || p > MAX_P) {
    throw new Error('decryptConfig: kdf parameters out of range');
  }
  return { N, r, p };
}

function deriveKey(passphrase, saltBuf, params) {
  const { N, r, p } = params;
  return crypto.scryptSync(passphrase, saltBuf, KEY_BYTES, {
    N, r, p,
    // 128*N*r is the working set; leave headroom or scrypt refuses to run.
    maxmem: Math.max(64 * 1024 * 1024, 256 * N * r),
  });
}

/**
 * True iff `obj` looks like a (v1 or v2) encryption envelope produced by encryptConfig.
 * @param {unknown} obj
 * @returns {boolean}
 */
function isEncryptedEnvelope(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    SUPPORTED_VERSIONS.includes(obj.v) &&
    typeof obj.salt === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.tag === 'string' &&
    typeof obj.ciphertext === 'string'
  );
}

/**
 * Encrypt a plain config object with a passphrase.
 * @param {object} plainObj  The config object (must be a non-null plain object).
 * @param {string} passphrase  Non-empty passphrase.
 * @returns {{v:number, alg:string, kdf:{N:number,r:number,p:number}, salt:string, iv:string, tag:string, ciphertext:string}}
 */
function encryptConfig(plainObj, passphrase) {
  if (!plainObj || typeof plainObj !== 'object' || Array.isArray(plainObj)) {
    throw new Error('encryptConfig: plainObj must be a non-null object');
  }
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('encryptConfig: passphrase must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const kdf = { N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL };
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: ALGO,
    kdf,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypt an envelope produced by encryptConfig back into the original object.
 * Throws if the envelope is malformed, the version is unsupported, the
 * passphrase is wrong, or any field has been tampered with.
 * @param {object} envelope
 * @param {string} passphrase
 * @returns {object}
 */
function decryptConfig(envelope, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('decryptConfig: passphrase must be a non-empty string');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('decryptConfig: envelope must be an object');
  }
  // Structural check first (independent of version) so a non-envelope object
  // reports an "envelope" error, while a well-shaped-but-future envelope reports
  // a "version" error. Order matters: the tests assert each message distinctly.
  const hasShape =
    typeof envelope.salt === 'string' &&
    typeof envelope.iv === 'string' &&
    typeof envelope.tag === 'string' &&
    typeof envelope.ciphertext === 'string';
  if (!hasShape) {
    throw new Error('decryptConfig: value is not a valid encryption envelope');
  }
  if (!SUPPORTED_VERSIONS.includes(envelope.v)) {
    throw new Error(`decryptConfig: unsupported envelope version ${envelope.v}`);
  }
  const salt = Buffer.from(envelope.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const tag = Buffer.from(envelope.tag, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex');
  if (tag.length !== TAG_BYTES) {
    throw new Error(`decryptConfig: invalid auth tag length (${tag.length} bytes, expected ${TAG_BYTES})`);
  }
  const key = deriveKey(passphrase, salt, kdfParamsOf(envelope));
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    // GCM tag verification failed: wrong passphrase or tampered data.
    throw new Error('decryptConfig: failed to decrypt (wrong passphrase or tampered data)');
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch (_) {
    throw new Error('decryptConfig: decrypted payload is not valid JSON');
  }
}

module.exports = {
  ENVELOPE_VERSION,
  SUPPORTED_VERSIONS,
  encryptConfig,
  decryptConfig,
  isEncryptedEnvelope,
};
