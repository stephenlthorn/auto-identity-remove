/**
 * test/allowlist-edit-config.test.js
 *
 * CORE-10 (library part): --allow / --unallow must go through editConfig so an
 * encrypted install works and the config stays 0600. lib/allowlist-edit.js
 * exposes editAllowlist(action, name, opts) for the watcher to call.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets');
const { editAllowlist } = require('../lib/allowlist-edit');

const PLAIN = {
  person: { firstName: 'Mary', lastName: 'Jackson', email: 'mj@example.org', zip: '23665' },
  allowlist: ['Existing'],
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-allowlist-'));
}

test('editAllowlist("allow") adds the broker and returns the new list', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN), { mode: 0o644 });
  fs.chmodSync(configPath, 0o644);

  const res = editAllowlist('allow', 'Spokeo', { configPath, encPath: path.join(dir, 'config.json.enc') });

  assert.deepEqual(res.allowlist, ['Existing', 'Spokeo']);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).allowlist, ['Existing', 'Spokeo']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editAllowlist("unallow") removes it, case-insensitively', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const res = editAllowlist('unallow', 'existing', { configPath, encPath: path.join(dir, 'config.json.enc') });

  assert.deepEqual(res.allowlist, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).allowlist, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('works on an encrypted install: re-encrypts and writes no plaintext', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, 'pw-allow')));

  const res = editAllowlist('allow', 'Spokeo', { configPath, encPath, passphrase: 'pw-allow' });

  assert.deepEqual(res.allowlist, ['Existing', 'Spokeo']);
  assert.equal(fs.existsSync(configPath), false);
  const back = secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), 'pw-allow');
  assert.deepEqual(back.allowlist, ['Existing', 'Spokeo']);
  assert.deepEqual(back.person, PLAIN.person);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a blank broker name is rejected and the config is left untouched', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const original = JSON.stringify(PLAIN);
  fs.writeFileSync(configPath, original);
  assert.throws(
    () => editAllowlist('allow', '  ', { configPath, encPath: path.join(dir, 'config.json.enc') }),
    /non-empty/,
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown action is rejected', () => {
  assert.throws(() => editAllowlist('frobnicate', 'X', {}), /action/i);
});
