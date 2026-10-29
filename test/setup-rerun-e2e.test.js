/**
 * test/setup-rerun-e2e.test.js
 *
 * End to end through the real wizard (child process, scripted answers on piped
 * stdin, everything under a temp dir via AIDR_CONFIG_PATH / AIDR_STATE_PATH /
 * HOME). Every y/n question is answered "n", so nothing is scheduled and no
 * browser is opened.
 *
 * CFG-1: re-running setup and pressing Enter must leave a multi-person config
 *        with SMTP, relay and allowlist exactly as it was, at mode 0600.
 * CFG-2: the new passphrase is asked twice, must match, and is the whole
 *        string - the encrypted file opens with it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const secrets = require('../lib/secrets');

const ROOT = path.join(__dirname, '..');

function runWizard(dir, respond) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['setup.js'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        AIDR_CONFIG_PATH: path.join(dir, 'config.json'),
        AIDR_STATE_PATH: path.join(dir, 'state.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

const GRACE = {
  firstName: 'Grace', lastName: 'Hopper', fullName: 'Grace Hopper', aliases: ['G Hopper'],
  city: 'Arlington', country: 'US', state: 'VA', zip: '22201',
  email: 'grace@hopper-labs.org', phone: '7035550111', phoneFormatted: '(703) 555-0111',
};
const TWIN = { ...GRACE, firstName: 'Gregory', fullName: 'Gregory Hopper', email: 'gregory@hopper-labs.org' };

test('re-running setup with Enter at every prompt leaves a rich config intact and private', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-e2e-'));
  const configPath = path.join(dir, 'config.json');
  const existing = {
    persons: [GRACE, TWIN],
    capsolver: { apiKey: 'CAP-real-key' },
    accounts: { spokeo: { email: GRACE.email, password: 'pw1' } },
    notify: { textTo: '+17035550111', emailReportTo: GRACE.email },
    profileDir: path.join(dir, 'profile'),
    email: { smtp: { host: 'smtp.hopper-labs.org', port: 587, user: 'grace', pass: 'smtp-secret', from: GRACE.email } },
    relay: { provider: 'simplelogin', apiKey: 'SL-KEY' },
    hibp: { apiKey: 'HIBP-KEY' },
    allowlist: ['Whitepages'],
  };
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), { mode: 0o644 });
  fs.chmodSync(configPath, 0o644);

  const res = await runWizard(dir, (prompt) => (/\(y\/n\)/.test(prompt) ? 'n' : ''));

  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  assert.match(res.out, /persons\[0\]/, 'says it edits persons[0] in place');
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // Declining an account still records a blank placeholder entry (existing
  // wizard behaviour); the stored credentials and everything else must survive.
  const { accounts, ...rest } = after;
  const { accounts: existingAccounts, ...existingRest } = existing;
  assert.deepEqual(rest, existingRest);
  assert.deepEqual(accounts.spokeo, existingAccounts.spokeo);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh install can encrypt: passphrase typed twice, mismatch retried, the whole string is the key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-e2e-'));
  const answers = [
    [/^First name/, 'Ada'], [/^Last name/, 'Lovelace'], [/^Aliases/, ''], [/^City/, 'London'],
    [/^Country/, 'GB'], [/^Province/, 'LND'], [/^Postal code/, 'SW1A 1AA'], [/^Email address/, 'ada@lovelace-notes.org'],
    [/^Phone/, '2075550100'], [/^CapSolver/, ''], [/^iMessage/, ''], [/^Notification webhook/, ''],
    [/^Browser profile/, ''],
  ];
  const secretsTyped = ['first-try-aaa', 'second-try-bbb', 'correct horse battery', 'correct horse battery'];
  let secretIdx = 0;

  const res = await runWizard(dir, (prompt) => {
    if (/passphrase|Type it again/.test(prompt)) return secretsTyped[secretIdx++];
    if (/Encrypt config\.json now\?/.test(prompt)) return 'y';
    if (/\(y\/n\)/.test(prompt)) return 'n';
    const hit = answers.find(([re]) => re.test(prompt));
    return hit ? hit[1] : '';
  });

  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  assert.equal(secretIdx, 4, 'asked twice, mismatched, asked twice again');
  assert.match(res.out, /did not match/);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'plaintext shredded');
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'config.json.enc'), 'utf8'));
  const cfg = secrets.decryptConfig(env, 'correct horse battery');
  assert.equal(cfg.person.lastName, 'Lovelace');
  assert.equal(cfg.person.zip, 'SW1A 1AA');
  assert.throws(() => secrets.decryptConfig(env, 'c'), /failed to decrypt/, 'not a one-character key');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a blank required answer is asked again, not written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-e2e-'));
  let firstNameAsks = 0;
  const res = await runWizard(dir, (prompt) => {
    if (/\(y\/n\)/.test(prompt)) return 'n';
    if (/^First name/.test(prompt)) { firstNameAsks += 1; return firstNameAsks === 1 ? '' : 'Ada'; }
    if (/^Last name/.test(prompt)) return 'Lovelace';
    if (/^Postal code|^ZIP/.test(prompt)) return '10001';
    if (/^Email address/.test(prompt)) return 'ada@lovelace-notes.org';
    if (/^Country/.test(prompt)) return 'US';
    return '';
  });
  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  assert.equal(firstNameAsks, 2);
  assert.match(res.out, /required/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).person.firstName, 'Ada');
  fs.rmSync(dir, { recursive: true, force: true });
});
