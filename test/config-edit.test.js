/**
 * test/config-edit.test.js
 *
 * CORE-10 (library part) + CFG-15a.
 *
 * `--allow` / `--unallow` edited the raw config.json through tmp+rename: it
 * replaced a 0600 file with a 0644 one, threw an uncaught EBUSY on a Docker
 * single-file mount (leaving config.json.tmp behind), and exited "could not read
 * config.json" when the config lived in config.json.enc. editConfig() is the one
 * write-back path: load through the normal loader, apply a pure mutator, write
 * back the way it was stored (re-encrypting if it was encrypted), atomically,
 * mode 0600.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets');
const config = require('../lib/config');
const { addToAllowlist } = require('../lib/allowlist-edit');

const PLAIN = {
  person: { firstName: 'Katherine', lastName: 'Johnson', email: 'kj@example.org', zip: '23665' },
  allowlist: ['Existing Broker'],
  email: { smtp: { host: 'smtp.example.org', pass: 'hunter2' } },
};
const PASS = 'edit-passphrase';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-edit-'));
}

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

const noPlatformModes = process.platform === 'win32';

test('plaintext config: edit is applied, every other key is preserved, mode becomes 0600', { skip: noPlatformModes }, () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN, null, 2), { mode: 0o644 });
  fs.chmodSync(configPath, 0o644);

  const res = config.editConfig(c => addToAllowlist(c, 'Spokeo'), { configPath, encPath });

  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.allowlist, ['Existing Broker', 'Spokeo']);
  assert.deepEqual(onDisk.person, PLAIN.person);
  assert.deepEqual(onDisk.email, PLAIN.email);
  assert.equal(mode(configPath), 0o600, 'an existing 0644 file is tightened');
  assert.equal(fs.existsSync(configPath + '.tmp'), false);
  assert.equal(fs.existsSync(encPath), false, 'must not create an encrypted copy of a plaintext install');
  assert.equal(res.encrypted, false);
  assert.deepEqual(res.config.allowlist, ['Existing Broker', 'Spokeo']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encrypted .enc config: edited and re-encrypted, no plaintext written', { skip: noPlatformModes }, () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)), { mode: 0o644 });
  fs.chmodSync(encPath, 0o644);

  const res = config.editConfig(c => addToAllowlist(c, 'Spokeo'), { configPath, encPath, passphrase: PASS });

  assert.equal(res.encrypted, true);
  assert.equal(fs.existsSync(configPath), false, 'no plaintext config.json may appear');
  const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.deepEqual(secrets.decryptConfig(env, PASS).allowlist, ['Existing Broker', 'Spokeo']);
  assert.deepEqual(secrets.decryptConfig(env, PASS).person, PLAIN.person);
  assert.equal(mode(encPath), 0o600);
  assert.equal(fs.existsSync(encPath + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('envelope stored in config.json itself stays in config.json', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));

  config.editConfig(c => addToAllowlist(c, 'Spokeo'), { configPath, encPath, passphrase: PASS });

  assert.equal(fs.existsSync(encPath), false);
  const env = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.ok(secrets.decryptConfig(env, PASS).allowlist.includes('Spokeo'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encrypted config without a passphrase: throws and the file is untouched', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  const before = JSON.stringify(secrets.encryptConfig(PLAIN, PASS));
  fs.writeFileSync(encPath, before);

  const saved = { p: process.env.AIDR_PASSPHRASE, f: process.env.AIDR_PASSPHRASE_FILE };
  delete process.env.AIDR_PASSPHRASE; delete process.env.AIDR_PASSPHRASE_FILE;
  try {
    assert.throws(() => config.editConfig(c => c, { configPath, encPath }), /passphrase/i);
  } finally {
    if (saved.p !== undefined) process.env.AIDR_PASSPHRASE = saved.p;
    if (saved.f !== undefined) process.env.AIDR_PASSPHRASE_FILE = saved.f;
  }
  assert.equal(fs.readFileSync(encPath, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the passphrase file is honoured when no passphrase option is given', { skip: noPlatformModes }, () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  const pf = path.join(dir, 'pw');
  fs.writeFileSync(pf, PASS + '\n', { mode: 0o600 });
  fs.chmodSync(pf, 0o600);

  const saved = { p: process.env.AIDR_PASSPHRASE, f: process.env.AIDR_PASSPHRASE_FILE };
  delete process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE_FILE = pf;
  try {
    config.editConfig(c => addToAllowlist(c, 'Spokeo'), { configPath, encPath });
  } finally {
    if (saved.p !== undefined) process.env.AIDR_PASSPHRASE = saved.p;
    if (saved.f !== undefined) process.env.AIDR_PASSPHRASE_FILE = saved.f; else delete process.env.AIDR_PASSPHRASE_FILE;
  }
  assert.ok(secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), PASS).allowlist.includes('Spokeo'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config that is not there is an error, not process.exit', () => {
  const dir = tmpdir();
  assert.throws(
    () => config.editConfig(c => c, { configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc') }),
    /not found/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a mutator that returns nothing (or a non-object) does not wipe the config', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const original = JSON.stringify(PLAIN, null, 2);
  fs.writeFileSync(configPath, original);
  for (const bad of [() => undefined, () => null, () => 'oops', () => [1]]) {
    assert.throws(() => config.editConfig(bad, { configPath, encPath: path.join(dir, 'x.enc') }), /mutator/i);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Docker single-file mount (rename -> EBUSY): the edit is still persisted, no .tmp left behind', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === configPath) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
    return realRename(from, to);
  };
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    config.editConfig(c => addToAllowlist(c, 'Spokeo'), { configPath, encPath: path.join(dir, 'config.json.enc') });
  } finally {
    fs.renameSync = realRename;
    console.warn = realWarn;
  }
  assert.ok(JSON.parse(fs.readFileSync(configPath, 'utf8')).allowlist.includes('Spokeo'));
  assert.equal(fs.existsSync(configPath + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- CFG-15a: no plaintext temp file survives a failed write --------------------

test('writeJsonAtomic removes its temp file when the write fails', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'config.json');
  const realWriteSync = fs.writeSync;
  fs.writeSync = () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; };
  try {
    assert.throws(() => config.writeJsonAtomic(target, PLAIN), /ENOSPC/);
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.equal(fs.existsSync(target + '.tmp'), false, 'plaintext temp file must not be left on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic removes its temp file when the rename is refused', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'config.json');
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  try {
    assert.throws(() => config.writeJsonAtomic(target, PLAIN), /EACCES/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.existsSync(target + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decryptConfigToDisk leaves no plaintext temp file when the write fails', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));

  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  try {
    assert.throws(() => config.decryptConfigToDisk({ passphrase: PASS, configPath, encPath, removeEnc: true }), /EACCES/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json.enc'], 'only the encrypted file remains');
  fs.rmSync(dir, { recursive: true, force: true });
});
