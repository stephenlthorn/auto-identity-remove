/**
 * test/scheduler-payloads.test.js
 *
 * CORE-13: the scheduled-job payloads broke on any path with a space or an
 * ampersand, and did not pin the node that installed them:
 *   - Windows `schtasks /TR "node.exe" "watcher.js"` is two arguments; schtasks
 *     needs ONE value with the inner quotes escaped.
 *   - cron and systemd lines interpolated unquoted paths.
 *   - plist values were not XML-escaped, so `&` produced an invalid plist.
 *   - no job pinned PATH to the installing node (cron/launchd/systemd PATH
 *     rarely contains a version-managed node), and cron had no log redirect.
 *
 * CORE-8: a job on an encrypted install needs AIDR_PASSPHRASE_FILE (never the
 * passphrase itself) in its environment.
 *
 * Tests use the hostile path `.../My Docs & 100% 'x'/...` throughout, and the
 * cron line is executed through a real /bin/sh the way cron would run it.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const scheduler = require('../lib/scheduler');
const {
  buildPlist,
  buildSystemdUnits,
  buildCronLine,
  buildCrontabUpdate,
  buildCrontabPayload,
  buildWindowsSchtasksCmd,
  buildWindowsSchtasksArgs,
  installScheduleForPlatform,
} = scheduler;

const HOSTILE_DIR = "/Users/me/My Docs & 100% 'x'/aidr";
const HOSTILE_SCRIPT = `${HOSTILE_DIR}/run.sh`;
const HOSTILE_LOGS = `${HOSTILE_DIR}/logs`;
const NODE_BIN = '/opt/node versions/v22 & co/bin';

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-sched-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function bareAmpersands(xml) {
  return xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/g) || [];
}

// ─── launchd plist ───────────────────────────────────────────────────────────

test('buildPlist XML-escapes every value, so an ampersand in a path does not break the plist', () => {
  const xml = buildPlist(HOSTILE_SCRIPT, HOSTILE_LOGS, { nodeBinDir: NODE_BIN, env: {} });
  assert.deepEqual(bareAmpersands(xml), [], 'no raw & may survive');
  assert.ok(xml.includes("My Docs &amp; 100% 'x'/aidr/run.sh") || xml.includes('My Docs &amp; 100% &apos;x&apos;/aidr/run.sh'));
  assert.ok(xml.includes('/aidr/logs/launchd.log'));
});

test('buildPlist escapes angle brackets too', () => {
  const xml = buildPlist('/tmp/a<b>"c"/run.sh', '/tmp/logs', { env: {} });
  assert.ok(!xml.includes('<b>'), 'a literal <b> would be parsed as a tag');
  assert.ok(xml.includes('a&lt;b&gt;'));
});

test('buildPlist produces a plist that plutil accepts (macOS only)', { skip: process.platform !== 'darwin' }, () => {
  const xml = buildPlist(HOSTILE_SCRIPT, HOSTILE_LOGS, { nodeBinDir: NODE_BIN, env: { AIDR_PASSPHRASE_FILE: '/tmp/a & b/pass' } });
  const file = path.join(tmpDir, 'job.plist');
  fs.writeFileSync(file, xml);
  const r = childProcess.spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('buildPlist pins PATH to the installing node first', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { nodeBinDir: '/opt/nvm/v22/bin', env: {} });
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/nvm\/v22\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
});

test('buildPlist defaults the pinned node to the one running the installer', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: {} });
  assert.ok(xml.includes(`<string>${path.dirname(process.execPath)}:`), xml);
});

test('buildPlist does not repeat the node dir when it is already a default PATH entry', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { nodeBinDir: '/usr/local/bin', env: {} });
  assert.match(xml, /<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
});

test('buildPlist carries AIDR_PASSPHRASE_FILE into the job environment, as an absolute path', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: { AIDR_PASSPHRASE_FILE: '/home/me/.aidr-pass' } });
  assert.match(xml, /<key>AIDR_PASSPHRASE_FILE<\/key>\s*<string>\/home\/me\/\.aidr-pass<\/string>/);

  const rel = buildPlist('/s/run.sh', '/s/logs', { env: { AIDR_PASSPHRASE_FILE: 'pass.txt' } });
  assert.ok(rel.includes(`<string>${path.resolve('pass.txt')}</string>`), 'a relative path is anchored at install time');
});

test('buildPlist carries the config and state path overrides too', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', {
    env: { AIDR_CONFIG_PATH: '/c/config.json', AIDR_CONFIG_ENC_PATH: '/c/config.json.enc', AIDR_STATE_PATH: '/c/state.json' },
  });
  for (const name of ['AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH']) {
    assert.ok(xml.includes(`<key>${name}</key>`), `${name} should be carried`);
  }
});

test('buildPlist never writes the passphrase itself', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: { AIDR_PASSPHRASE: 'hunter2-secret', AIDR_PASSPHRASE_FILE: '/p' } });
  assert.ok(!xml.includes('hunter2-secret'));
  assert.ok(!xml.includes('<key>AIDR_PASSPHRASE</key>'));
});

test('buildPlist omits the passphrase-file key when none was set at install time', () => {
  const xml = buildPlist('/s/run.sh', '/s/logs', { env: {} });
  assert.ok(!xml.includes('AIDR_PASSPHRASE_FILE'));
});

// ─── systemd ─────────────────────────────────────────────────────────────────

test('buildSystemdUnits quotes ExecStart for a path with spaces and an ampersand', () => {
  const { service } = buildSystemdUnits(HOSTILE_SCRIPT, HOSTILE_LOGS, { nodeBinDir: NODE_BIN, env: {} });
  assert.ok(service.includes(`ExecStart=/bin/bash "/Users/me/My Docs & 100%% 'x'/aidr/run.sh"`), service);
});

test('buildSystemdUnits escapes %, $, quotes and backslashes in the ExecStart argument', () => {
  const { service } = buildSystemdUnits('/a/$HOME/"q"/b\\c/run.sh', '/a/logs', { env: {} });
  assert.ok(service.includes('ExecStart=/bin/bash "/a/$$HOME/\\"q\\"/b\\\\c/run.sh"'), service);
});

test('buildSystemdUnits leaves a plain path unquoted', () => {
  const { service } = buildSystemdUnits('/path/run.sh', '/path/logs', { env: {} });
  assert.match(service, /ExecStart=\/bin\/bash \/path\/run\.sh\n/);
});

test('buildSystemdUnits escapes % in the log paths', () => {
  const { service } = buildSystemdUnits('/a/run.sh', '/a/100%/logs', { env: {} });
  assert.ok(service.includes('StandardOutput=append:/a/100%%/logs/systemd.log'));
});

test('buildSystemdUnits pins PATH to the installing node', () => {
  const { service } = buildSystemdUnits('/s/run.sh', '/s/logs', { nodeBinDir: NODE_BIN, env: {} });
  assert.ok(service.includes(`Environment="PATH=${NODE_BIN}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`), service);
});

test('buildSystemdUnits carries AIDR_PASSPHRASE_FILE but never the passphrase', () => {
  const { service } = buildSystemdUnits('/s/run.sh', '/s/logs', {
    env: { AIDR_PASSPHRASE: 'hunter2-secret', AIDR_PASSPHRASE_FILE: '/home/me/my pass' },
  });
  assert.ok(service.includes('Environment="AIDR_PASSPHRASE_FILE=/home/me/my pass"'), service);
  assert.ok(!service.includes('hunter2-secret'));
});

// ─── cron ────────────────────────────────────────────────────────────────────

test('buildCronLine single-quotes the script and log paths and escapes % for cron', () => {
  const line = buildCronLine(HOSTILE_SCRIPT, HOSTILE_LOGS, { nodeBinDir: NODE_BIN, env: {} });
  assert.ok(line.startsWith('0 9 1 * * '), line);
  assert.ok(line.includes(`/bin/bash '/Users/me/My Docs & 100\\% '\\''x'\\''/aidr/run.sh'`), line);
  assert.ok(line.includes(` >> '/Users/me/My Docs & 100\\% '\\''x'\\''/aidr/logs/cron.log' 2>&1`), line);
  assert.ok(!/[^\\]%/.test(line), 'a bare % would be turned into a newline by cron');
});

test('buildCronLine redirects output to a log file', () => {
  const line = buildCronLine('/s/run.sh', '/s/logs', { env: {} });
  assert.ok(line.includes('>> /s/logs/cron.log 2>&1'), line);
});

test('buildCronLine pins PATH to the installing node', () => {
  const line = buildCronLine('/s/run.sh', '/s/logs', { nodeBinDir: '/opt/nvm/v22/bin', env: {} });
  assert.ok(line.includes('PATH=/opt/nvm/v22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /bin/bash'), line);
});

test('buildCronLine carries AIDR_PASSPHRASE_FILE but never the passphrase', () => {
  const line = buildCronLine('/s/run.sh', '/s/logs', { env: { AIDR_PASSPHRASE: 'hunter2-secret', AIDR_PASSPHRASE_FILE: '/home/me/my pass' } });
  assert.ok(line.includes("AIDR_PASSPHRASE_FILE='/home/me/my pass'"), line);
  assert.ok(!line.includes('hunter2-secret'));
});

test('buildCronLine refuses a path that would split the crontab line', () => {
  assert.throws(() => buildCronLine('/s/a\nb/run.sh', '/s/logs', { env: {} }), /newline/i);
});

test('the cron line really runs the script when executed by a shell, whatever the path contains', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmpDir, "My Docs & 100% 'x'");
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const script = path.join(dir, 'run.sh');
  fs.writeFileSync(script, '#!/bin/bash\nprintf "%s" "$PATH" > "$(dirname "$0")/ran.txt"\necho from-script\n', { mode: 0o755 });

  const line = buildCronLine(script, logs, { nodeBinDir: '/opt/pinned node/bin', env: {} });
  // cron: five schedule fields, then the command; an escaped \% is a literal %.
  const command = line.split(' ').slice(5).join(' ').replace(/\\%/g, '%');

  const r = childProcess.spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'ran.txt'), 'utf8').split(':')[0], '/opt/pinned node/bin', 'PATH is pinned');
  assert.equal(fs.readFileSync(path.join(logs, 'cron.log'), 'utf8').trim(), 'from-script', 'output is logged');
});

// ─── crontab round trip ──────────────────────────────────────────────────────

const HOSTILE_CRONTAB = [
  '# m h dom mon dow command',
  '0 3 * * * /usr/bin/backup --tag=$(date +\\%F)',
  '30 4 * * * /usr/bin/report --home=$HOME --host=`hostname`',
  '15 5 * * * /usr/bin/sync --path="/mnt/My Files" && echo done',
  'MAILTO=""',
].join('\n') + '\n';

function installCronWith(existing, { script = '/home/u/aidr/run.sh', env = {} } = {}) {
  const writes = [];
  scheduler._setStdinRunner((cmd, args, input) => { writes.push({ cmd, args, input }); return { status: 0, stderr: '' }; });
  const realExec = childProcess.execSync;
  childProcess.execSync = cmd => {
    if (cmd === 'which systemctl') throw new Error('no systemd');
    if (String(cmd).includes('crontab -l')) return existing;
    return '';
  };
  let result;
  try {
    result = installScheduleForPlatform({ platform: 'linux', scriptPath: script, logDir: path.join(tmpDir, 'logs'), env, nodeBinDir: '/new/node/bin' });
  } finally {
    childProcess.execSync = realExec;
    scheduler._setStdinRunner(null);
  }
  return { result, writes };
}

test('installing into a crontab full of % and $(...) lines leaves every existing line byte for byte', () => {
  const { writes, result } = installCronWith(HOSTILE_CRONTAB);
  assert.equal(result.method, 'crontab');
  assert.equal(writes.length, 1);
  const out = writes[0].input;
  assert.ok(out.startsWith(HOSTILE_CRONTAB), 'the existing crontab must come back unchanged, in order');
  const ours = out.slice(HOSTILE_CRONTAB.length).trim().split('\n');
  assert.equal(ours.length, 1, 'exactly one new line');
  assert.match(ours[0], /^0 9 1 \* \* .*\/bin\/bash \/home\/u\/aidr\/run\.sh >> .*cron\.log 2>&1/);
});

test('re-running the installer on an up-to-date crontab changes nothing', () => {
  const first = installCronWith(HOSTILE_CRONTAB);
  const second = installCronWith(first.writes[0].input);
  assert.equal(second.writes.length, 0, 'no write when our line is already there');
  assert.match(second.result.detail, /already present/);
});

test('an older aidr line for the same script is replaced, never duplicated', () => {
  const legacy = HOSTILE_CRONTAB + '0 9 1 * * /bin/bash /home/u/aidr/run.sh\n';
  const { writes, result } = installCronWith(legacy);
  assert.equal(writes.length, 1);
  const out = writes[0].input;
  assert.ok(out.startsWith(HOSTILE_CRONTAB));
  assert.ok(!out.includes('\n0 9 1 * * /bin/bash /home/u/aidr/run.sh\n'), 'the legacy line is gone');
  assert.equal(out.split('\n').filter(l => l.includes('/home/u/aidr/run.sh')).length, 1, 'one aidr line only');
  assert.match(result.detail, /updated/i);
});

test('an aidr line from an earlier install with a different PATH is replaced, not duplicated', () => {
  const stale = installCronWith(HOSTILE_CRONTAB, { env: {} }).writes[0].input.replace(/PATH=\S+/, 'PATH=/old/node/bin');
  const { writes } = installCronWith(stale);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.split('\n').filter(l => l.includes('/home/u/aidr/run.sh')).length, 1);
  assert.ok(!writes[0].input.includes('/old/node/bin'));
});

test("a user's own line that merely mentions the script is left alone", () => {
  const mine = '0 3 * * 0 /bin/bash /home/u/aidr/run.sh --dry-run\n';
  const { writes } = installCronWith(HOSTILE_CRONTAB + mine);
  assert.ok(writes[0].input.includes(mine), 'a hand-written weekly preview must survive');
});

test('buildCrontabUpdate reports unchanged, updated and added correctly', () => {
  const line = buildCronLine('/s/run.sh', '/s/logs', { env: {} });
  assert.equal(buildCrontabUpdate('', line, '/s/run.sh').status, 'added');
  assert.equal(buildCrontabUpdate(line + '\n', line, '/s/run.sh').status, 'unchanged');
  assert.equal(buildCrontabUpdate('0 9 1 * * /bin/bash /s/run.sh\n', line, '/s/run.sh').status, 'updated');
  assert.equal(buildCrontabPayload('', 'x'), 'x\n', 'the old helper keeps working');
});

// ─── installers pass the environment through ─────────────────────────────────

test('the crontab installer carries AIDR_PASSPHRASE_FILE into the written line', () => {
  const { writes } = installCronWith('', { env: { AIDR_PASSPHRASE_FILE: '/home/u/.pass' } });
  assert.ok(writes[0].input.includes('AIDR_PASSPHRASE_FILE=/home/u/.pass'), writes[0].input);
});

test('the systemd installer writes the passphrase-file env and a quoted ExecStart', () => {
  const realExec = childProcess.execSync;
  const realHome = os.homedir;
  childProcess.execSync = () => '';
  os.homedir = () => tmpDir;
  try {
    const result = installScheduleForPlatform({
      platform: 'linux',
      scriptPath: HOSTILE_SCRIPT,
      logDir: path.join(tmpDir, 'logs'),
      env: { AIDR_PASSPHRASE_FILE: '/home/u/.pass' },
    });
    assert.equal(result.method, 'systemd');
  } finally {
    childProcess.execSync = realExec;
    os.homedir = realHome;
  }
  const unit = fs.readFileSync(path.join(tmpDir, '.config', 'systemd', 'user', 'auto-identity-remove.service'), 'utf8');
  assert.ok(unit.includes('Environment="AIDR_PASSPHRASE_FILE=/home/u/.pass"'));
  assert.ok(unit.includes(`ExecStart=/bin/bash "/Users/me/My Docs & 100%% 'x'/aidr/run.sh"`));
});

test('the macOS installer writes an escaped plist and quotes the launchctl paths', () => {
  const home = path.join(tmpDir, 'home with space');
  fs.mkdirSync(home);
  const realExec = childProcess.execSync;
  const realHome = os.homedir;
  const executed = [];
  childProcess.execSync = cmd => { executed.push(String(cmd)); return ''; };
  os.homedir = () => home;
  try {
    installScheduleForPlatform({
      platform: 'macos',
      scriptPath: HOSTILE_SCRIPT,
      logDir: path.join(tmpDir, 'logs'),
      env: { AIDR_PASSPHRASE_FILE: '/p/pass' },
    });
  } finally {
    childProcess.execSync = realExec;
    os.homedir = realHome;
  }
  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.auto-identity-remove.plist');
  const xml = fs.readFileSync(plistPath, 'utf8');
  assert.deepEqual(bareAmpersands(xml), []);
  assert.ok(xml.includes('AIDR_PASSPHRASE_FILE'));
  const load = executed.find(c => c.includes('launchctl load'));
  assert.ok(load.includes(`'${plistPath}'`), `launchctl must get the quoted plist path: ${load}`);
});

test('the installers create the log directory the job redirects into', () => {
  const realExec = childProcess.execSync;
  const realHome = os.homedir;
  childProcess.execSync = () => '';
  os.homedir = () => tmpDir;
  const logDir = path.join(tmpDir, 'fresh', 'logs');
  try {
    installScheduleForPlatform({ platform: 'linux', scriptPath: '/s/run.sh', logDir, env: {} });
  } finally {
    childProcess.execSync = realExec;
    os.homedir = realHome;
  }
  assert.ok(fs.existsSync(logDir), 'systemd append: and cron >> both fail if the directory is missing');
});

// ─── Windows ─────────────────────────────────────────────────────────────────

const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_WATCHER = 'C:\\My Docs & Stuff\\aidr\\watcher.js';

test('buildWindowsSchtasksArgs gives /TR as ONE value with both paths quoted', () => {
  const args = buildWindowsSchtasksArgs(WIN_NODE, WIN_WATCHER);
  const at = args.indexOf('/TR');
  assert.ok(at !== -1);
  assert.equal(args[at + 1], `"${WIN_NODE}" "${WIN_WATCHER}"`);
  assert.equal(args.filter(a => a === '/TR').length, 1);
  assert.deepEqual(args.slice(0, 9), ['/Create', '/F', '/SC', 'MONTHLY', '/D', '1', '/ST', '09:00', '/TN']);
  assert.equal(args[args.indexOf('/TN') + 1], 'auto-identity-remove');
});

test('buildWindowsSchtasksCmd escapes the inner quotes so /TR stays one argument', () => {
  const cmd = buildWindowsSchtasksCmd(WIN_NODE, WIN_WATCHER);
  assert.ok(cmd.includes(`/TR "\\"${WIN_NODE}\\" \\"${WIN_WATCHER}\\""`), cmd);
  assert.ok(!cmd.includes(`/TR "${WIN_NODE}" "${WIN_WATCHER}"`), 'the old two-argument form must be gone');
});

test('buildWindowsSchtasksCmd still honours a custom time', () => {
  assert.match(buildWindowsSchtasksCmd('node.exe', 'watcher.js', { hour: 3, minute: 30 }), /\/ST 03:30/);
});

test('the Windows installer hands schtasks an argv array, so & in a path never reaches a shell', () => {
  const realExecFile = childProcess.execFileSync;
  const realExec = childProcess.execSync;
  const calls = [];
  childProcess.execFileSync = (file, args) => { calls.push({ file, args }); return ''; };
  childProcess.execSync = () => { throw new Error('execSync must not be used for schtasks'); };
  let result;
  try {
    result = installScheduleForPlatform({
      platform: 'windows',
      scriptPath: 'C:\\My Docs & Stuff\\aidr\\run.sh',
      logDir: path.join(tmpDir, 'logs'),
      env: {},
    });
  } finally {
    childProcess.execFileSync = realExecFile;
    childProcess.execSync = realExec;
  }
  assert.equal(result.method, 'schtasks');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'schtasks');
  const tr = calls[0].args[calls[0].args.indexOf('/TR') + 1];
  assert.ok(tr.includes('C:\\My Docs & Stuff\\aidr\\watcher.js'), tr);
  assert.ok(/^".*" ".*"$/.test(tr), 'node and watcher are each quoted inside the single /TR value');
});

test('the Windows installer says how to give the task a passphrase file, since schtasks has no environment', () => {
  const realExecFile = childProcess.execFileSync;
  childProcess.execFileSync = () => '';
  let result;
  try {
    result = installScheduleForPlatform({
      platform: 'windows',
      scriptPath: 'C:\\aidr\\run.sh',
      logDir: path.join(tmpDir, 'logs'),
      env: { AIDR_PASSPHRASE_FILE: 'C:\\aidr\\pass.txt' },
    });
  } finally {
    childProcess.execFileSync = realExecFile;
  }
  assert.match(result.detail, /AIDR_PASSPHRASE_FILE/);
  assert.match(result.detail, /setx/i);
});
