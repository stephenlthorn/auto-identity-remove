/**
 * test/config-check-load.test.js
 *
 * R5: `aidr config check` reports which config file and passphrase source are in
 * use, every reason the config cannot be run, and where state lives - without
 * ever exiting the process or touching the real install.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkConfig } = require('../lib/config-check');
const h = require('./config-check-helpers');

const posix = process.platform !== 'win32';

function withRoot(fn) {
  const root = h.makeRoot();
  try { return fn(root); } finally { h.cleanup(root); }
}

test('a runnable plaintext config is ok and reports where everything lives', () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.info.configFile, path.join(root, 'config.json'));
  assert.equal(r.info.encrypted, false);
  assert.equal(r.info.passphraseSource, 'none');
  assert.equal(r.info.statePath, path.join(root, 'state.json'));
  assert.equal(r.info.persons, 1);
}));

test('a missing config is a problem, not a process exit', () => withRoot((root) => {
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /config not found/);
  assert.ok(r.problems[0].includes(path.join(root, 'config.json')));
  assert.match(r.problems[0], /setup/);
  assert.equal(r.info.persons, 0);
}));

test('every validation problem is listed, not just the first', () => withRoot((root) => {
  h.writePlain(root, h.goodConfig({ person: h.person({ firstName: '', zip: '  ', email: '' }) }));
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('person.firstName is blank'));
  assert.ok(r.problems.includes('person.zip is blank'));
  assert.ok(r.problems.includes('person.email is blank'));
}));

test('problems name the person by position in a multi-person config', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person(), h.person({ firstName: 'Pip', lastName: 'Wren', email: 'pip@example.net', zip: '' })] });
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('persons[1].zip is blank'));
  assert.equal(r.info.persons, 2);
}));

test('an unedited copy of config.example.json is rejected', () => withRoot((root) => {
  const example = fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8');
  h.writeFile(path.join(root, 'config.json'), example);
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /placeholder/.test(p)), r.problems.join('\n'));
}));

test('a config that is not valid JSON is a problem that never echoes its contents', () => withRoot((root) => {
  h.writeFile(path.join(root, 'config.json'), '{"person": {"email": zebediah.quillfeather@example.net, "zip": 27312}}');
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /not valid JSON/);
  assert.equal(JSON.stringify(r).includes('zebediah'), false, 'a JSON error message can quote the file; it must not reach the output');
}));

test('AIDR_CONFIG_PATH and AIDR_STATE_PATH point the check elsewhere', () => withRoot((root) => {
  const cfgFile = h.writeFile(path.join(root, 'elsewhere', 'mine.json'), h.goodConfig());
  const stateFile = path.join(root, 'elsewhere', 'mine-state.json');
  const r = checkConfig({ env: { AIDR_CONFIG_PATH: cfgFile, AIDR_STATE_PATH: stateFile }, root });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.configFile, cfgFile);
  assert.equal(r.info.statePath, stateFile);
}));

test('a paths resolver, when the install has one, decides the locations', () => withRoot((root) => {
  const cfgFile = h.writeFile(path.join(root, 'home', 'c.json'), h.goodConfig());
  const seen = [];
  const r = checkConfig({
    env: { AIDR_HOME: 'x' },
    root,
    _resolvePaths: (env, rootArg) => {
      seen.push([env, rootArg]);
      return { config: cfgFile, configEnc: cfgFile + '.enc', state: path.join(root, 'home', 's.json') };
    },
  });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.configFile, cfgFile);
  assert.equal(r.info.statePath, path.join(root, 'home', 's.json'));
  assert.deepEqual(seen, [[{ AIDR_HOME: 'x' }, root]]);
}));

test('works with no lib/paths.js at all (the module is optional)', () => withRoot((root) => {
  h.writePlain(root);
  assert.equal(checkConfig({ env: {}, root }).ok, true);
}));

// ---- encryption and the passphrase source ---------------------------------

test('encrypted config.json.enc with AIDR_PASSPHRASE: ok, source env', () => withRoot((root) => {
  h.writeEncFile(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.encrypted, true);
  assert.equal(r.info.passphraseSource, 'env');
  assert.equal(r.info.configFile, path.join(root, 'config.json.enc'));
  assert.equal(r.info.persons, 1);
}));

test('encrypted config with AIDR_PASSPHRASE_FILE: ok, source file', { skip: !posix }, () => withRoot((root) => {
  h.writeEncFile(root);
  const file = h.writePassphraseFile(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE_FILE: file }, root });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.passphraseSource, 'file');
}));

test('the env var wins over the file, as in the real loader', { skip: !posix }, () => withRoot((root) => {
  h.writeEncFile(root);
  const file = h.writePassphraseFile(root, 'a-different-passphrase');
  const r = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE, AIDR_PASSPHRASE_FILE: file }, root });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.passphraseSource, 'env');
}));

test('an in-place envelope inside config.json counts as encrypted', () => withRoot((root) => {
  h.writeEnvelopeInPlace(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.info.encrypted, true);
  assert.equal(r.info.configFile, path.join(root, 'config.json'));
}));

test('encrypted config and no passphrase: a problem naming both ways to supply one', () => withRoot((root) => {
  h.writeEncFile(root);
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  assert.equal(r.info.passphraseSource, 'none');
  assert.equal(r.info.encrypted, true);
  assert.match(r.problems.join('\n'), /AIDR_PASSPHRASE/);
  assert.match(r.problems.join('\n'), /AIDR_PASSPHRASE_FILE/);
}));

test('the check reads the injected env, never the real process env', () => withRoot((root) => {
  h.writeEncFile(root);
  process.env.AIDR_PASSPHRASE = h.PASSPHRASE;
  try {
    const r = checkConfig({ env: {}, root });
    assert.equal(r.ok, false);
    assert.equal(r.info.passphraseSource, 'none');
  } finally {
    delete process.env.AIDR_PASSPHRASE;
  }
}));

test('a wrong passphrase is a problem, and the passphrase is never echoed', () => withRoot((root) => {
  h.writeEncFile(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE: 'not-the-passphrase-0001' }, root });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /decrypt/i);
  assert.equal(JSON.stringify(r).includes('not-the-passphrase-0001'), false);
}));

test('a passphrase file others can read is refused, as the loader refuses it', { skip: !posix }, () => withRoot((root) => {
  h.writeEncFile(root);
  const file = h.writePassphraseFile(root, h.PASSPHRASE, 0o644);
  const r = checkConfig({ env: { AIDR_PASSPHRASE_FILE: file }, root });
  assert.equal(r.ok, false);
  assert.equal(r.info.passphraseSource, 'file');
  assert.match(r.problems.join('\n'), /readable by group\/other/);
  assert.match(r.problems.join('\n'), /chmod 600/);
  assert.equal(JSON.stringify(r).includes(h.PASSPHRASE), false);
}));

test('a missing or empty passphrase file is a problem', { skip: !posix }, () => withRoot((root) => {
  h.writeEncFile(root);
  const missing = checkConfig({ env: { AIDR_PASSPHRASE_FILE: path.join(root, 'nope.txt') }, root });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join('\n'), /cannot be read \(ENOENT\)/);

  const empty = h.writeFile(path.join(root, 'empty.txt'), '\n');
  const e = checkConfig({ env: { AIDR_PASSPHRASE_FILE: empty }, root });
  assert.equal(e.ok, false);
  assert.match(e.problems.join('\n'), /empty/);
}));

// ---- warnings --------------------------------------------------------------

test('a passphrase supplied for a plaintext config is a warning, not a problem', () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  assert.equal(r.ok, true);
  assert.equal(r.info.passphraseSource, 'env');
  assert.ok(r.warnings.some((w) => /plaintext/.test(w) && /encrypt/.test(w)), r.warnings.join('\n'));
}));

test('a config file other local users can read is a warning', { skip: !posix }, () => withRoot((root) => {
  h.writePlain(root, h.goodConfig(), 0o644);
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /readable by other users/.test(w) && /chmod 600/.test(w)), r.warnings.join('\n'));
}));

test('a 0600 config raises no permission warning', { skip: !posix }, () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: {}, root });
  assert.deepEqual(r.warnings, []);
}));

test('a call with no root checks the install defaults without throwing', () => withRoot((root) => {
  const r = checkConfig({ env: { AIDR_CONFIG_PATH: path.join(root, 'absent.json') } });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /config not found/);
}));
