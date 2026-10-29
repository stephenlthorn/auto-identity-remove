/**
 * test/run-sh-config.test.js
 *
 * CORE-8: run.sh exited unless config.json existed, but encryption removes
 * config.json (it leaves config.json.enc), and a scheduled job never has a
 * passphrase. Every scheduled run on an encrypted install exited 1.
 *
 * CORE-6 (run.sh part): run.sh dropped every argument, so `./run.sh --dry-run`
 * was a REAL run.
 *
 * run.sh is exercised for real, in a temp copy of the project, with a stub
 * `node` first on PATH. The stub records its argv and the config env it was
 * given; watcher.js is never run.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN_SH = path.resolve(__dirname, '..', 'run.sh');

function makeProject({ files = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-runsh-'));
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  fs.copyFileSync(RUN_SH, path.join(project, 'run.sh'));
  fs.writeFileSync(path.join(project, 'watcher.js'), '// never run: node is stubbed\n');
  for (const f of files) fs.writeFileSync(path.join(project, f), '{}');

  const record = path.join(root, 'node-call.txt');
  fs.writeFileSync(
    path.join(bin, 'node'),
    [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > '${record}'`,
      `printf 'CONFIG=%s\\nENC=%s\\nPASSFILE=%s\\nPWD=%s\\n' "$AIDR_CONFIG_PATH" "$AIDR_CONFIG_ENC_PATH" "$AIDR_PASSPHRASE_FILE" "$PWD" > '${record}.env'`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    root,
    project,
    bin,
    record,
    calls: () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : null),
    seen: () => fs.readFileSync(`${record}.env`, 'utf8'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runSh(p, { args = [], env = {}, cwd = p.project } = {}) {
  return spawnSync('/bin/bash', [path.join(p.project, 'run.sh'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${p.bin}:/usr/bin:/bin`, HOME: p.root, ...env },
  });
}

test('run.sh runs watcher.js when only config.json.enc exists and AIDR_PASSPHRASE is set', () => {
  const p = makeProject({ files: ['config.json.enc'] });
  try {
    const r = runSh(p, { env: { AIDR_PASSPHRASE: 'pw' } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js']);
  } finally { p.cleanup(); }
});

test('run.sh accepts AIDR_PASSPHRASE_FILE in place of AIDR_PASSPHRASE for an encrypted config', () => {
  const p = makeProject({ files: ['config.json.enc'] });
  try {
    const passFile = path.join(p.root, 'pass');
    fs.writeFileSync(passFile, 'pw\n', { mode: 0o600 });
    const r = runSh(p, { env: { AIDR_PASSPHRASE_FILE: passFile } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js']);
  } finally { p.cleanup(); }
});

test('run.sh fails clearly, without starting node, when the config is encrypted and no passphrase is available', () => {
  const p = makeProject({ files: ['config.json.enc'] });
  try {
    const r = runSh(p);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /encrypted/i);
    assert.match(r.stderr, /AIDR_PASSPHRASE\b/);
    assert.match(r.stderr, /AIDR_PASSPHRASE_FILE/);
    assert.equal(p.calls(), null, 'node must not be started');
  } finally { p.cleanup(); }
});

test('run.sh fails clearly when AIDR_PASSPHRASE_FILE points at a missing file', () => {
  const p = makeProject({ files: ['config.json.enc'] });
  try {
    const r = runSh(p, { env: { AIDR_PASSPHRASE_FILE: path.join(p.root, 'gone') } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AIDR_PASSPHRASE_FILE/);
    assert.match(r.stderr, /gone/);
    assert.equal(p.calls(), null);
  } finally { p.cleanup(); }
});

test('run.sh runs a plaintext config.json with no passphrase', () => {
  const p = makeProject({ files: ['config.json'] });
  try {
    const r = runSh(p);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js']);
  } finally { p.cleanup(); }
});

test('run.sh treats a config.json that is an in-place encrypted envelope as encrypted', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.project, 'config.json'), JSON.stringify({ v: 1, salt: 'a', iv: 'b', tag: 'c', ciphertext: 'd' }));
    const r = runSh(p);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AIDR_PASSPHRASE/);
    assert.equal(p.calls(), null);
  } finally { p.cleanup(); }
});

test('run.sh with no config at all says to run setup and does not start node', () => {
  const p = makeProject();
  try {
    const r = runSh(p);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /config/i);
    assert.match(r.stderr, /setup/);
    assert.equal(p.calls(), null);
  } finally { p.cleanup(); }
});

test('run.sh passes every argument through to watcher.js unchanged', () => {
  const p = makeProject({ files: ['config.json'] });
  try {
    const r = runSh(p, { args: ['--dry-run', '--only', 'Spokeo, Radaris', '--skip=Two Words'] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js', '--dry-run', '--only', 'Spokeo, Radaris', '--skip=Two Words']);
  } finally { p.cleanup(); }
});

test('run.sh passes --help through instead of starting a run of its own', () => {
  const p = makeProject({ files: ['config.json'] });
  try {
    const r = runSh(p, { args: ['--help'] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js', '--help']);
  } finally { p.cleanup(); }
});

test('run.sh propagates the exit status of watcher.js', () => {
  const p = makeProject({ files: ['config.json'] });
  try {
    fs.writeFileSync(path.join(p.bin, 'node'), '#!/bin/bash\nexit 7\n', { mode: 0o755 });
    assert.equal(runSh(p).status, 7);
  } finally { p.cleanup(); }
});

test('run.sh honours AIDR_CONFIG_PATH for a plaintext config kept elsewhere', () => {
  const p = makeProject();
  try {
    const elsewhere = path.join(p.root, 'cfg', 'mine.json');
    fs.mkdirSync(path.dirname(elsewhere));
    fs.writeFileSync(elsewhere, '{}');
    const r = runSh(p, { env: { AIDR_CONFIG_PATH: elsewhere } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(p.calls(), ['watcher.js']);
  } finally { p.cleanup(); }
});

test('run.sh honours AIDR_CONFIG_ENC_PATH and still demands a passphrase for it', () => {
  const p = makeProject();
  try {
    const enc = path.join(p.root, 'cfg', 'mine.enc');
    fs.mkdirSync(path.dirname(enc));
    fs.writeFileSync(enc, '{}');

    const refused = runSh(p, { env: { AIDR_CONFIG_ENC_PATH: enc } });
    assert.notEqual(refused.status, 0);
    assert.equal(p.calls(), null);

    const ok = runSh(p, { env: { AIDR_CONFIG_ENC_PATH: enc, AIDR_PASSPHRASE: 'pw' } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(p.calls(), ['watcher.js']);
  } finally { p.cleanup(); }
});

test('run.sh resolves a relative AIDR_CONFIG_PATH against where it was launched, not the project dir', () => {
  const p = makeProject();
  try {
    const launchDir = path.join(p.root, 'launch');
    fs.mkdirSync(launchDir);
    fs.writeFileSync(path.join(launchDir, 'mine.json'), '{}');
    const r = runSh(p, { cwd: launchDir, env: { AIDR_CONFIG_PATH: 'mine.json' } });
    assert.equal(r.status, 0, r.stderr);
    const seen = p.seen();
    assert.ok(seen.includes(`CONFIG=${fs.realpathSync(launchDir)}/mine.json`) || seen.includes(`CONFIG=${launchDir}/mine.json`), seen);
    assert.match(seen, new RegExp(`PWD=.*project`), 'node still runs from the project directory');
  } finally { p.cleanup(); }
});
