/**
 * test/config-plaintext-copies.test.js
 *
 * CFG2-5. The dashboard keeps a byte copy of config.json before every plaintext
 * save (config.json.bak, config.json.unreadable-<ts>.bak) and the atomic writers
 * leave config.json.tmp* behind when killed. --encrypt-config shredded only
 * config.json, so those copies kept the whole config in the clear next to the
 * encrypted file, and `aidr config check` printed nothing about it.
 *
 * Now: encrypting removes every plaintext copy it can identify (once config.json
 * itself is gone), and config check and doctor warn about any that remain.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const secrets = require('../lib/secrets');
const { checkConfig, formatConfigCheck } = require('../lib/config-check');
const doctor = require('../lib/doctor');
const h = require('./config-check-helpers');

const SECRET = 'SMTP-SECRET-COPY-77123';
const PLAIN = { person: { firstName: 'Ann', lastName: 'Probe', email: 'ann@example.test', zip: '12345' }, email: { smtp: { host: 'h', user: 'u', pass: SECRET } } };
const PASS = 'a-passphrase';

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-copies-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  }
  return dir;
}

const readableSecret = (dir) => fs.readdirSync(dir).filter((f) => {
  try { return fs.readFileSync(path.join(dir, f), 'utf8').includes(SECRET); } catch (_) { return false; }
});

test('after --encrypt-config no readable sibling of config.json still holds the secret', () => {
  const dir = dirWith({
    'config.json': PLAIN,
    'config.json.bak': PLAIN,
    'config.json.unreadable-20261029101500.bak': PLAIN,
    'config.json.tmp': PLAIN,
    'config.json.tmp-ab12cd34': PLAIN,
    'config.json.bak.tmp-ab12cd34': PLAIN,
  });
  const res = cfg.encryptConfigToDisk({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc'), passphrase: PASS, shred: true });
  assert.equal(res.shredded, true);
  assert.deepEqual(readableSecret(dir), [], 'nothing in the directory holds the secret in the clear');
  assert.equal(res.removedCopies.length, 5, 'every plaintext copy was removed and reported');
  assert.deepEqual(secrets.decryptConfig(JSON.parse(fs.readFileSync(path.join(dir, 'config.json.enc'), 'utf8')), PASS), PLAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt (possibly partial) plaintext copy goes too; encrypted copies and unrelated files stay', () => {
  const envelope = secrets.encryptConfig(PLAIN, PASS);
  const dir = dirWith({
    'config.json': PLAIN,
    'config.json.bak': `{"person":{"firstName":"Ann","email":"ann@example.test"},"email":{"smtp":{"pass":"${SECRET}`,
    'config.json.enc.bak': envelope,
    'config.json.unreadable-20261029101500.bak': envelope,
    'state.json': { optOuts: {} },
    'notes.txt': 'keep me',
  });
  cfg.encryptConfigToDisk({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc'), passphrase: PASS, shred: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json.enc', 'config.json.enc.bak', 'config.json.unreadable-20261029101500.bak', 'notes.txt', 'state.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--keep-plaintext leaves every copy alone', () => {
  const dir = dirWith({ 'config.json': PLAIN, 'config.json.bak': PLAIN });
  const res = cfg.encryptConfigToDisk({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc'), passphrase: PASS, shred: false });
  assert.equal(res.shredded, false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak', 'config.json.enc']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('when config.json itself cannot be removed, the copies are not touched either', () => {
  const dir = dirWith({ 'config.json': PLAIN, 'config.json.bak': PLAIN });
  const configPath = path.join(dir, 'config.json');
  const realRm = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p) === configPath) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
    return realRm(p, ...rest);
  };
  let res;
  try {
    res = cfg.encryptConfigToDisk({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: PASS, shred: true });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(res.shredded, false);
  assert.ok(fs.existsSync(path.join(dir, 'config.json.bak')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a copy that cannot be removed is reported, never silently left', () => {
  const dir = dirWith({ 'config.json': PLAIN, 'config.json.bak': PLAIN });
  const bak = path.join(dir, 'config.json.bak');
  const realRm = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p) === bak) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return realRm(p, ...rest);
  };
  let res;
  try {
    res = cfg.encryptConfigToDisk({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc'), passphrase: PASS, shred: true });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(res.shredded, true);
  assert.deepEqual(res.keptCopies, [bak]);
  assert.match(res.notice, /config\.json\.bak/);
  assert.match(res.notice, /delete/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the listing, and the warnings ------------------------------------------

test('plaintextConfigCopies lists the copies and a plaintext config.json shadowed by a .enc', () => {
  const envelope = secrets.encryptConfig(PLAIN, PASS);
  const dir = dirWith({ 'config.json.enc': envelope, 'config.json': PLAIN, 'config.json.bak': PLAIN, 'config.json.enc.bak': envelope });
  const found = cfg.plaintextConfigCopies({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc') });
  assert.deepEqual(found.map((p) => path.basename(p)).sort(), ['config.json', 'config.json.bak']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a plain-text install has no "copies": config.json is the config', () => {
  const dir = dirWith({ 'config.json': PLAIN, 'config.json.bak': PLAIN });
  // No encrypted config anywhere: nothing is shadowed, nothing is being protected.
  assert.deepEqual(cfg.plaintextConfigCopies({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc') }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an in-place envelope: plaintext copies beside it are listed, the envelope itself is not', () => {
  const dir = dirWith({ 'config.json': secrets.encryptConfig(PLAIN, PASS), 'config.json.bak': PLAIN });
  const found = cfg.plaintextConfigCopies({ configPath: path.join(dir, 'config.json'), encPath: path.join(dir, 'config.json.enc') });
  assert.deepEqual(found.map((p) => path.basename(p)), ['config.json.bak']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config check warns about a plaintext copy beside the encrypted config, without echoing it', () => {
  const root = h.makeRoot();
  h.writeEncFile(root);
  h.writeFile(path.join(root, 'config.json.bak'), h.goodConfig());
  const result = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  const text = formatConfigCheck(result).join('\n');
  assert.equal(result.ok, true, 'a warning, not a failure');
  assert.ok(result.warnings.some((w) => w.includes(path.join(root, 'config.json.bak')) && /plain ?text/i.test(w) && /delete|remove|rm /i.test(w)), result.warnings.join('\n'));
  assert.doesNotMatch(text, /smtp-secret-pass-90210|zebediah/i);
  h.cleanup(root);
});

test('config check is quiet when there is no plaintext beside the encrypted config', () => {
  const root = h.makeRoot();
  h.writeEncFile(root);
  const result = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  assert.equal(result.warnings.filter((w) => /plain ?text copy/i.test(w)).length, 0);
  h.cleanup(root);
});

test('doctor flags the same copies as a warning on the config check', async () => {
  const root = h.makeRoot();
  h.writeEncFile(root);
  h.writeFile(path.join(root, 'config.json'), h.goodConfig());
  const prev = process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE = h.PASSPHRASE;
  let r;
  try {
    r = await doctor.checkConfig(root, { passphrase: h.PASSPHRASE });
  } finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE; else process.env.AIDR_PASSPHRASE = prev;
  }
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.match(r.hint, /plain ?text/i);
  assert.ok(r.hint.includes(path.join(root, 'config.json')));
  h.cleanup(root);
});
