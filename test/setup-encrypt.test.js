/**
 * test/setup-encrypt.test.js
 *
 * Unit test for setup.js's pure maybeEncryptConfig helper. Hermetic: temp files
 * only. Verifies it encrypts a freshly-written plaintext config and shreds it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { maybeEncryptConfig } = require('../setup');
const secrets = require('../lib/secrets');

const PLAIN = { person: { firstName: 'Edsger', lastName: 'Dijkstra' }, capsolver: { apiKey: 'CAP-9' } };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-'));
}

test('maybeEncryptConfig with a passphrase encrypts and shreds the plaintext', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN, null, 2));

  const res = maybeEncryptConfig({ passphrase: 'pw', configPath, encPath });

  assert.equal(res.encrypted, true);
  assert.ok(fs.existsSync(encPath));
  assert.equal(fs.existsSync(configPath), false);
  assert.deepEqual(secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), 'pw'), PLAIN);
});

test('maybeEncryptConfig with an empty passphrase is a no-op (leaves plaintext)', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN, null, 2));

  const res = maybeEncryptConfig({ passphrase: '', configPath, encPath });

  assert.equal(res.encrypted, false);
  assert.ok(fs.existsSync(configPath), 'plaintext should remain');
  assert.equal(fs.existsSync(encPath), false, 'no envelope should be written');
});
