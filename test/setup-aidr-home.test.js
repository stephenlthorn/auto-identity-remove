/**
 * test/setup-aidr-home.test.js
 *
 * R0: with AIDR_HOME pointing at a directory that does not exist yet (a new Docker
 * volume path, a fresh NAS share), the wizard died with ENOENT on its first write.
 * The home directory is now created owner-only, the config and the state land in
 * it, and the monthly job is told to log inside it too (it used to log under the
 * app directory whatever AIDR_HOME said).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { scheduleJobOptions } = require('../setup');

const ROOT = path.join(__dirname, '..');
const mode = (p) => fs.statSync(p).mode & 0o777;

function runWizard(env, respond) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['setup.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let all = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`wizard timed out. Output so far:\n${all}\n${stderr}`)); }, 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      all += d.toString();
      if (!buf.endsWith(': ')) return;
      const prompt = buf.split('\n').pop();
      buf = '';
      child.stdin.write(`${respond(prompt)}\n`);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: all, err: stderr }); });
  });
}

test('setup into an AIDR_HOME that does not exist yet creates it 0700 and puts config and state in it', { skip: process.platform === 'win32' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-home-')));
  try {
    const home = path.join(root, 'new', 'aidr-home');
    const res = await runWizard({ HOME: root, AIDR_HOME: home }, (prompt) => {
      if (/\(y\/n\)/.test(prompt)) return 'n';
      if (/^First name/.test(prompt)) return 'Ada';
      if (/^Last name/.test(prompt)) return 'Lovelace';
      if (/^Postal code|^ZIP/.test(prompt)) return '10001';
      if (/^Email address/.test(prompt)) return 'ada@lovelace-notes.org';
      if (/^Country/.test(prompt)) return 'US';
      return '';
    });
    assert.equal(res.code, 0, `${res.out}\n${res.err}`);
    assert.equal(mode(home), 0o700, 'the home directory holds PII, so it is owner-only');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).person.lastName, 'Lovelace');
    assert.equal(mode(path.join(home, 'config.json')), 0o600);
    assert.ok(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).optOuts);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the monthly job logs where the runtime logs live', () => {
  const home = path.resolve('/srv/aidr-home');
  assert.equal(scheduleJobOptions({ AIDR_HOME: home }).logDir, path.join(home, 'logs'));
  assert.equal(scheduleJobOptions({ AIDR_HOME: home, AIDR_LOG_DIR: '/srv/elsewhere' }).logDir, path.resolve('/srv/elsewhere'));
  assert.equal(scheduleJobOptions({}).logDir, path.join(ROOT, 'logs'), 'with nothing set, nothing moved');
});

test('the monthly job runs this install\'s run.sh', () => {
  assert.equal(scheduleJobOptions({}).scriptPath, path.join(ROOT, 'run.sh'));
});
