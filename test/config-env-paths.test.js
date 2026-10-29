/**
 * test/config-env-paths.test.js
 *
 * CFG-3 (code part): the documented "mount a directory" Docker recipes could not
 * find the config because CONFIG_PATH was fixed at <repo>/config.json. The paths
 * and the passphrase source now have environment overrides:
 *
 *   AIDR_CONFIG_PATH       plaintext (or in-place envelope) config file
 *   AIDR_CONFIG_ENC_PATH   encrypted envelope file (default: <config path>.enc)
 *   AIDR_PASSPHRASE_FILE   file whose first line is the passphrase, used only
 *                          when AIDR_PASSPHRASE is unset; refused when it is
 *                          readable by group/other (POSIX)
 *
 * Plus the two Docker failure modes: shredding the plaintext on a bind mount
 * throws EBUSY (and must neither crash nor claim success), and a uid mismatch
 * surfaces as EACCES (and must say how to fix it).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const secrets = require('../lib/secrets');
const config = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const PLAIN = { person: { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', zip: '10001' } };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-envpaths-'));
}

// Child env: nothing from the developer's shell leaks in, state stays in a temp dir.
function childEnv(dir, extra) {
  return { PATH: process.env.PATH, AIDR_STATE_PATH: path.join(dir, 'state.json'), ...extra };
}

function runChild(dir, env, code) {
  return execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env: childEnv(dir, env), encoding: 'utf8' });
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// -- AIDR_CONFIG_PATH / AIDR_CONFIG_ENC_PATH ---------------------------------

test('AIDR_CONFIG_PATH makes loadConfig read that file', () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'mounted-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(PLAIN));
  const out = runChild(dir, { AIDR_CONFIG_PATH: cfgPath }, `
    const c = require('./lib/config');
    process.stdout.write(JSON.stringify({ cfg: c.loadConfig(), p: c.CONFIG_PATH, e: c.CONFIG_ENC_PATH }));
  `);
  const got = JSON.parse(out);
  assert.deepEqual(got.cfg, PLAIN);
  assert.equal(got.p, cfgPath);
  assert.equal(got.e, cfgPath + '.enc', 'the .enc default follows the config path, not the repo root');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AIDR_CONFIG_ENC_PATH overrides where the envelope is read from', () => {
  const dir = tmpdir();
  const encPath = path.join(dir, 'secret', 'cfg.enc');
  fs.mkdirSync(path.dirname(encPath));
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, 'pw-123')));
  const out = runChild(dir, {
    AIDR_CONFIG_PATH: path.join(dir, 'unused.json'),
    AIDR_CONFIG_ENC_PATH: encPath,
    AIDR_PASSPHRASE: 'pw-123',
  }, `process.stdout.write(JSON.stringify(require('./lib/config').loadConfig()));`);
  assert.deepEqual(JSON.parse(out), PLAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without the env vars the defaults are unchanged', () => {
  const dir = tmpdir();
  const out = runChild(dir, {}, `
    const c = require('./lib/config');
    process.stdout.write(JSON.stringify([c.CONFIG_PATH, c.CONFIG_ENC_PATH]));
  `);
  assert.deepEqual(JSON.parse(out), [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.json.enc')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- AIDR_PASSPHRASE_FILE -----------------------------------------------------

function passFile(dir, content, mode) {
  const p = path.join(dir, 'passphrase');
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

test('getPassphrase reads the first line of AIDR_PASSPHRASE_FILE when AIDR_PASSPHRASE is unset', () => {
  const dir = tmpdir();
  const p = passFile(dir, 'first line pass\nsecond line ignored\n', 0o600);
  withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: p }, () => {
    assert.equal(config.getPassphrase(), 'first line pass');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CRLF-terminated passphrase file does not leak the carriage return into the key', () => {
  const dir = tmpdir();
  const p = passFile(dir, 'windows-pass\r\n', 0o600);
  withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: p }, () => {
    assert.equal(config.getPassphrase(), 'windows-pass');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AIDR_PASSPHRASE wins over AIDR_PASSPHRASE_FILE (and a bad file is then never touched)', () => {
  const dir = tmpdir();
  const p = passFile(dir, 'from-file\n', 0o644);
  withEnv({ AIDR_PASSPHRASE: 'from-env', AIDR_PASSPHRASE_FILE: p }, () => {
    assert.equal(config.getPassphrase(), 'from-env');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit passphrase argument wins over both', () => {
  withEnv({ AIDR_PASSPHRASE: 'from-env', AIDR_PASSPHRASE_FILE: '/nonexistent' }, () => {
    assert.equal(config.getPassphrase('explicit'), 'explicit');
  });
});

test('a group- or world-readable passphrase file is refused with a clear error', { skip: process.platform === 'win32' }, () => {
  const dir = tmpdir();
  for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666]) {
    const p = passFile(dir, 'pw\n', mode);
    fs.chmodSync(p, mode);
    withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: p }, () => {
      assert.throws(
        () => config.getPassphrase(),
        (err) => /AIDR_PASSPHRASE_FILE/.test(err.message) && /chmod 600/.test(err.message),
        `mode ${mode.toString(8)} must be refused`,
      );
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable or empty passphrase file is a clear error, not a silent empty passphrase', () => {
  const dir = tmpdir();
  withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: path.join(dir, 'missing') }, () => {
    assert.throws(() => config.getPassphrase(), /AIDR_PASSPHRASE_FILE.*(missing|ENOENT)/s);
  });
  const empty = passFile(dir, '\n', 0o600);
  withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: empty }, () => {
    assert.throws(() => config.getPassphrase(), /AIDR_PASSPHRASE_FILE.*empty/s);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig decrypts using the passphrase file', () => {
  const dir = tmpdir();
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, 'file-passphrase')));
  const p = passFile(dir, 'file-passphrase\n', 0o600);
  withEnv({ AIDR_PASSPHRASE: undefined, AIDR_PASSPHRASE_FILE: p }, () => {
    assert.deepEqual(config.loadConfig({ configPath: path.join(dir, 'config.json'), encPath }), PLAIN);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- shredding the plaintext under a bind mount --------------------------------

test('EBUSY while shredding the plaintext: the file is emptied and the result says it was NOT removed', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const realRm = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p) === configPath) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
    return realRm(p, ...rest);
  };
  let res;
  try {
    res = config.encryptConfigToDisk({ passphrase: 'pw', shred: true, configPath, encPath });
  } finally {
    fs.rmSync = realRm;
  }

  assert.equal(res.shredded, false, 'must not claim the plaintext was shredded');
  assert.equal(res.plaintextEmptied, true);
  assert.match(res.notice, /delete/i, 'the user is told to remove the leftover file');
  assert.match(res.notice, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(configPath, 'utf8'), '', 'nothing secret is left in the plaintext file');
  assert.deepEqual(secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), 'pw'), PLAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('if the plaintext can neither be removed nor emptied, encryptConfigToDisk throws instead of reporting success', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const realRm = fs.rmSync;
  const realWrite = fs.writeFileSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p) === configPath) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
    return realRm(p, ...rest);
  };
  fs.writeFileSync = (p, ...rest) => {
    if (String(p) === configPath) { const e = new Error('EROFS: read-only file system'); e.code = 'EROFS'; throw e; }
    return realWrite(p, ...rest);
  };
  try {
    assert.throws(
      () => config.encryptConfigToDisk({ passphrase: 'pw', shred: true, configPath, encPath }),
      /plaintext.*(still|could not)/is,
    );
  } finally {
    fs.rmSync = realRm;
    fs.writeFileSync = realWrite;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the encrypted file is read back before the plaintext is shredded', () => {
  // A bind mount or full disk can make the write "succeed" without persisting.
  // Simulate a rename that drops the file: the plaintext must survive.
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === encPath) { fs.unlinkSync(from); return; }
    return realRename(from, to);
  };
  try {
    assert.throws(() => config.encryptConfigToDisk({ passphrase: 'pw', shred: true, configPath, encPath }));
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), PLAIN, 'plaintext must not be shredded');
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- EACCES hint ----------------------------------------------------------------

test('loadConfig EACCES names the container uid and the chown command', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === configPath) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead(p, ...rest);
  };
  try {
    assert.throws(
      () => config.loadConfig({ configPath, encPath: path.join(dir, 'config.json.enc') }),
      (err) => err.code === 'EACCES' && /1001/.test(err.message) && /chown/.test(err.message) && err.message.includes(configPath),
    );
  } finally {
    fs.readFileSync = realRead;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
