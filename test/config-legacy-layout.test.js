/**
 * test/config-legacy-layout.test.js
 *
 * CFG2-8. The Docker image sets AIDR_HOME=/home/aidr, so the documented
 * pre-AIDR_HOME recipe (-v config.json:/app/config.json -v state.json:/app/state.json)
 * is silently ignored: every scheduled run exited 1 with "Run node setup.js first"
 * and no path, and a setup that moved only the config left the state behind, so
 * every broker was re-submitted without a word.
 *
 * When the files sit at the old app-directory location and the resolved ones do
 * not exist, the failure now says where each file is, where it must go, and why.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function layout({ legacyConfig = false, legacyEnc = false, legacyState = false, homeConfig = false, homeState = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-legacy-'));
  const app = path.join(base, 'app');
  const home = path.join(base, 'home');
  fs.mkdirSync(app);
  fs.mkdirSync(home);
  const put = (dir, name) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ optOuts: {}, person: { firstName: 'A' } }));
  if (legacyConfig) put(app, 'config.json');
  if (legacyEnc) put(app, 'config.json.enc');
  if (legacyState) put(app, 'state.json');
  if (homeConfig) put(home, 'config.json');
  if (homeState) put(home, 'state.json');
  const opts = {
    configPath: path.join(home, 'config.json'),
    encPath: path.join(home, 'config.json.enc'),
    statePath: path.join(home, 'state.json'),
    legacyRoot: app,
  };
  return { base, app, home, opts };
}

// loadConfig prints and exits when there is no config: capture both.
function loadConfigCapturing(opts) {
  const realExit = process.exit;
  const realError = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code }); };
  let exitCode;
  try {
    cfg.loadConfig(opts);
  } catch (err) {
    exitCode = err.exitCode;
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return { exitCode, text: lines.join('\n') };
}

test('root-level config.json + empty AIDR_HOME: loadConfig names both the old and the new location', () => {
  const l = layout({ legacyConfig: true, legacyState: true });
  const r = loadConfigCapturing(l.opts);
  assert.equal(r.exitCode, 1);
  assert.ok(r.text.includes(path.join(l.app, 'config.json')), r.text);
  assert.ok(r.text.includes(path.join(l.home, 'config.json')), r.text);
  assert.ok(r.text.includes(path.join(l.app, 'state.json')), r.text);
  assert.ok(r.text.includes(path.join(l.home, 'state.json')), r.text);
  assert.match(r.text, /AIDR_HOME/);
  assert.match(r.text, /directory/i, 'tells them to mount a directory, not single files');
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('an old encrypted config.json.enc is found too, and points at the .enc destination', () => {
  const l = layout({ legacyEnc: true });
  const r = loadConfigCapturing(l.opts);
  assert.ok(r.text.includes(path.join(l.app, 'config.json.enc')), r.text);
  assert.ok(r.text.includes(path.join(l.home, 'config.json.enc')), r.text);
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('with nothing at the old location the message is the plain one', () => {
  const l = layout();
  const r = loadConfigCapturing(l.opts);
  assert.equal(r.exitCode, 1);
  assert.match(r.text, /config\.json not found\. Run `node setup\.js` first\./);
  assert.doesNotMatch(r.text, /AIDR_HOME/);
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('the thrown ENOCONFIG error carries the same migration hint for doctor and config check', () => {
  const l = layout({ legacyConfig: true });
  assert.throws(
    () => cfg.editConfig((c) => c, l.opts),
    (err) => err.code === 'ENOCONFIG' && err.message.includes(path.join(l.app, 'config.json')) && err.message.includes(path.join(l.home, 'config.json')),
  );
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('a config found in the home but state left at the old location is reported (the AIDR_CONFIG_PATH-only case)', () => {
  const l = layout({ legacyState: true, homeConfig: true });
  const problems = cfg.legacyLayoutProblems(l.opts);
  assert.deepEqual(problems.map((p) => p.kind), ['state']);
  assert.equal(problems[0].legacy, path.join(l.app, 'state.json'));
  assert.equal(problems[0].resolved, path.join(l.home, 'state.json'));
  assert.match(cfg.describeLegacyLayout(problems).join('\n'), /re-?submit/i, 'says what losing the history costs');
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('no problem when the home already has its own state, or when old and new are the same place', () => {
  const l = layout({ legacyState: true, homeConfig: true, homeState: true });
  assert.deepEqual(cfg.legacyLayoutProblems(l.opts), []);
  const same = { configPath: path.join(l.app, 'config.json'), encPath: path.join(l.app, 'config.json.enc'), statePath: path.join(l.app, 'state.json'), legacyRoot: l.app };
  assert.deepEqual(cfg.legacyLayoutProblems(same), []);
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('a config that exists in the home is never reported as missing', () => {
  const l = layout({ legacyConfig: true, homeConfig: true });
  assert.deepEqual(cfg.legacyLayoutProblems(l.opts), []);
  fs.rmSync(l.base, { recursive: true, force: true });
});

// ---- doctor -----------------------------------------------------------------

const doctor = require('../lib/doctor');

test('doctor: a missing config says where the old one is and where it must go', async () => {
  const l = layout({ legacyConfig: true });
  const r = await doctor.checkConfig(undefined, { configPath: l.opts.configPath, encPath: l.opts.encPath, legacyRoot: l.app });
  assert.equal(r.ok, false);
  assert.ok(r.hint.includes(path.join(l.app, 'config.json')), r.hint);
  assert.ok(r.hint.includes(path.join(l.home, 'config.json')), r.hint);
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('doctor: a state left at the old location is a warning, not "fresh install"', async () => {
  const l = layout({ legacyState: true, homeConfig: true });
  const r = await doctor.checkState(undefined, { statePath: l.opts.statePath, legacyRoot: l.app });
  assert.equal(r.ok, true);
  assert.equal(r.warn, true);
  assert.ok(r.hint.includes(path.join(l.app, 'state.json')), r.hint);
  assert.match(r.hint, /re-?submit/i);
  fs.rmSync(l.base, { recursive: true, force: true });
});

test('doctor: a genuinely fresh install is still just fresh', async () => {
  const l = layout();
  const r = await doctor.checkState(undefined, { statePath: l.opts.statePath, legacyRoot: l.app });
  assert.equal(r.warn, undefined);
  assert.match(r.hint, /fresh install/);
  fs.rmSync(l.base, { recursive: true, force: true });
});
