/**
 * test/integration-roadmap-run.test.js
 *
 * What the roadmap changed about an actual run, seen from outside: the real
 * watcher.js in a sandbox (temp repo copy, temp config and state, a fake playwright
 * that records every launch and refuses to navigate, notifiers stubbed, the OS
 * scheduler fenced off).
 *
 *   R0  AIDR_HOME relocates logs, heartbeat, state and the confirmation inbox
 *   R1  the CAPTCHA mode line says who solves what
 *   R2  --resume after a kill in the middle of the generic pass
 *   R3  the journal, and --retry-failed reading a crashed run's journal
 *   R4  the heartbeat, for real runs only
 *   R6  retention.days at the end of a run
 *   R7  one browser profile and context per person; the utility profile; the proxy
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const { seedArtifacts, writeLog } = require('./helpers/pii-artifacts');

const posix = process.platform !== 'win32';
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
const fresh = (n = 3) => ({ lastSuccess: daysAgo(n), lastAttempt: daysAgo(n) });
const freshSpokeo = { optOuts: { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(3) } };

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

const mode = (p) => fs.statSync(p).mode & 0o777;
const launches = (sandbox) => sandbox.fakeEvents().filter(e => e.event === 'launch');
const heartbeatOf = (sandbox) => JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
const jsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const journalsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^run-.*\.jsonl$/.test(f)).sort() : []);
const summaryOf = (dir) => {
  const file = fs.readdirSync(dir).filter(f => /^run-.*\.json$/.test(f)).sort().pop();
  return { file: path.join(dir, file), body: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) };
};

// ── R3 + R4: the journal and the heartbeat ───────────────────────────────────

test('a real run leaves a journal that matches its summary, and a heartbeat beside the state', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);

    const [journalName] = journalsIn(sandbox.logs);
    assert.ok(journalName, 'a journal was written next to the summary');
    const { file: summaryFile, body } = summaryOf(sandbox.logs);
    assert.equal(journalName, `${path.basename(summaryFile)}l`, 'run-<ts>.json is paired with run-<ts>.jsonl');
    if (posix) assert.equal(mode(path.join(sandbox.logs, journalName)), 0o600, 'it holds the names of the brokers that hold your data');

    const lines = jsonl(path.join(sandbox.logs, journalName));
    assert.equal(lines[0].type, 'run');
    assert.equal(lines[0].partial, true);
    assert.equal(lines[0].filter.only, 'Spokeo');
    const results = lines.filter(l => !l.type);
    assert.deepEqual(results.map(l => [l.broker, l.status, l.person]), [['Spokeo', 'skipped', 'Ada Lovelace'], ['Spokeo', 'skipped', 'Alan Turing']],
      'every result was appended as it happened, tagged with its person');
    const end = lines[lines.length - 1];
    assert.equal(end.type, 'end');
    assert.equal(end.interrupted, undefined);
    assert.equal(end.counts.skipped, 2);
    assert.equal(body.skipped.length, 2, 'the summary agrees with the journal');

    const beat = heartbeatOf(sandbox);
    assert.equal(beat.outcome, 'ok');
    assert.ok(Date.parse(beat.finishedAt) >= Date.parse(beat.startedAt));
    assert.equal(beat.counts.skipped, 2);
    if (posix) assert.equal(mode(path.join(sandbox.home, 'last-run.json')), 0o600);
    const raw = fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8');
    for (const secret of ['Ada', 'Lovelace', 'Spokeo', '@']) assert.ok(!raw.includes(secret), `the heartbeat holds numbers only, not ${secret}`);
  });
});

test('a dry run, a preview and --verify leave neither a journal nor a heartbeat', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    for (const args of [['--only', 'Spokeo', '--dry-run'], ['--only', 'Spokeo', '--preview'], ['--verify']]) {
      const r = await runWatcher(sandbox, args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.equal(fs.existsSync(sandbox.logs), false, 'no logs directory, so no journal');
    assert.equal(fs.existsSync(path.join(sandbox.home, 'last-run.json')), false, 'a rehearsal is not a run');
  });
});

test('a run that errored is a partial heartbeat, not an ok one', async () => {
  // The fake browser refuses every navigation, so every explicit form errors.
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    const beat = heartbeatOf(sandbox);
    assert.equal(beat.outcome, 'failed', 'nothing but errors happened');
    assert.ok(beat.counts.errors >= 1);
  });
});

test('SIGTERM mid-run closes the journal as interrupted and writes a failed heartbeat', async () => {
  await inSandbox({ state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], {
      env: { AIDR_FAKE_HANG: 'init' },
      signalWhen: { match: /FAKE_BROWSER_HANGING/, signal: 'SIGTERM' },
      timeoutMs: 30000,
    });
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 143);

    const [journalName] = journalsIn(sandbox.logs);
    assert.ok(journalName, 'the journal exists although the run never wrote its summary');
    const lines = jsonl(path.join(sandbox.logs, journalName));
    assert.equal(lines[lines.length - 1].type, 'end');
    assert.equal(lines[lines.length - 1].interrupted, true, 'the end line says the run was cut short');
    assert.equal(heartbeatOf(sandbox).outcome, 'failed');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('--retry-failed reads a crashed run\'s journal and says where the list came from', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const lines = [
      { type: 'run', startedAt: '2026-01-01T00:00:00.000Z', mode: 'run', partial: false, filter: null },
      { broker: 'Spokeo', status: 'error', detail: 'Timeout', time: '2026-01-01T00:00:05.000Z', person: 'Ada Lovelace' },
      { broker: 'Radaris', status: 'success', detail: 'ok', time: '2026-01-01T00:00:09.000Z', person: 'Ada Lovelace' },
    ];
    writeLog(sandbox, 'run-2026-01-01T00-00-00.jsonl', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const r = await runWatcher(sandbox, ['--retry-failed']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--retry-failed: 1 broker\(s\) from last log/);
    assert.match(r.stdout, /crashed before it wrote its log/);
    assert.match(r.stdout, /--resume/);
    const { body } = summaryOf(sandbox.logs);
    assert.deepEqual([...new Set(body.skipped.map(e => e.broker))], ['Spokeo']);
  });
});

test('the run in progress is never its own --retry-failed source', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--retry-failed']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no previous log found/);
  });
});

// ── R2: --resume after a kill in the middle of the generic pass ──────────────

test('--resume after a SIGTERM mid-generic skips the finished explicit passes and carries on in the generic pass', async () => {
  await inSandbox({}, async (sandbox) => {
    const genericRows = (out) => (out.match(/\n  \[[^\]\n]{1,80}\]… /g) || []).length;
    const first = await runWatcher(sandbox, [], {
      env: { AIDR_FAKE_SLOW_MS: '25' },
      signalWhen: { match: (out) => genericRows(out) >= 70, signal: 'SIGTERM' },
      timeoutMs: 90000,
    });
    assert.equal(first.timedOut, false, 'the shutdown must not hang');
    assert.equal(first.code, 143, first.stderr);
    assert.equal(fs.existsSync(sandbox.lock), false);

    const checkpointFile = `${sandbox.state}.checkpoint`;
    assert.ok(fs.existsSync(checkpointFile), 'the generic pass left a resume point');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    assert.equal(checkpoint.phase, 'generic');
    assert.equal(checkpoint.personIndex, 0);
    assert.ok(checkpoint.index > 0, `the checkpoint is part-way through the pass (index ${checkpoint.index})`);

    const second = await runWatcher(sandbox, ['--resume'], { timeoutMs: 90000 });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /--resume: the explicit pass for Ada Lovelace is already done, skipping/);
    assert.match(second.stdout, /--resume: the explicit pass for Alan Turing is already done, skipping/);
    assert.match(second.stdout, new RegExp(`--resume: skipping ${checkpoint.index} generic broker\\(s\\) already covered`));
    assert.doesNotMatch(second.stdout, /generic pass for Ada Lovelace is already done/, 'Ada was mid-pass, not finished');
    assert.doesNotMatch(second.stdout, /generic pass for Alan Turing is already done/);

    const queue = Number(second.stdout.match(/Generic brokers \((\d+) from Markup/)[1]);
    const { body } = summaryOf(sandbox.logs);
    assert.equal(body.genericStats.attempted, 2 * queue - checkpoint.index, 'Ada resumed where she stopped; Alan, who had not started, ran in full');
    assert.equal(body.partial, true);
    assert.equal(body.filter.resume, true);
    assert.equal(fs.existsSync(checkpointFile), false, 'a completed run clears its checkpoint');
  });
});

test('--resume with no checkpoint says so and runs everything it was asked to', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--resume', '--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--resume: no checkpoint found, running all brokers/);
  });
});

// ── R7: one browser profile per person ───────────────────────────────────────

test('each person gets their own profile directory, and only one Chromium is ever open', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);

    const steps = sandbox.fakeEvents().filter(e => e.event === 'launch' || e.event === 'close');
    assert.deepEqual(steps.map(e => e.event), ['launch', 'close', 'launch', 'close', 'launch', 'close', 'launch', 'close'],
      'the previous browser is closed before the next one starts: a small NAS stays at one Chromium');
    const profiles = launches(sandbox).map(e => e.profile);
    for (const profile of profiles) assert.match(profile, /^person-[01]-[0-9a-f]{10}$/);
    assert.notEqual(profiles[0], profiles[1], 'Ada and Alan do not share cookies');
    assert.deepEqual(profiles, [profiles[0], profiles[1], profiles[0], profiles[1]], 'each person comes back to their own profile for the generic pass');
    assert.ok(!profiles.join(' ').match(/ada|alan|lovelace|turing/i), 'a name never appears in a path');

    const base = path.join(sandbox.home, '.config', 'auto-identity-remove');
    for (const profile of new Set(profiles)) {
      assert.ok(fs.existsSync(path.join(base, profile)), `${profile} exists`);
      if (posix) assert.equal(mode(path.join(base, profile)), 0o700);
    }
  });
});

test('one person means one launch per pass, on a profile that is that person\'s', async () => {
  const config = runnableConfig();
  config.persons = [config.persons[0]];
  await inSandbox({ config, state: { optOuts: { Spokeo: fresh(3) } } }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(launches(sandbox).map(e => e.profile.replace(/-[0-9a-f]{10}$/, '')), ['person-0'], 'one person: one browser for the explicit and generic passes together');
  });
});

test('--report, --confirm-emails and --complaints launch on the utility profile, not a person\'s', async () => {
  await inSandbox({}, async (sandbox) => {
    const report = await runWatcher(sandbox, ['--report']);
    assert.equal(report.code, 0, report.stderr);
    const empty = path.join(sandbox.dir, 'inbox');
    fs.mkdirSync(empty);
    const confirm = await runWatcher(sandbox, ['--confirm-emails', empty]);
    assert.equal(confirm.code, 0, confirm.stderr);

    assert.deepEqual(launches(sandbox).map(e => e.profile), ['utility', 'utility']);
    const base = path.join(sandbox.home, '.config', 'auto-identity-remove');
    assert.ok(fs.existsSync(path.join(base, 'utility')));
    assert.deepEqual(fs.readdirSync(base).filter(n => n.startsWith('person-')), [], 'nothing was left in a person\'s directory');
    if (posix) assert.equal(mode(path.join(base, 'utility')), 0o700);
  });
});

test('browser.proxy and browser.userAgent reach every launch, and the credentials stay out of the output', async () => {
  const config = runnableConfig({
    browser: { userAgent: 'Mozilla/5.0 (Test) Chrome/130.0.0.0 Safari/537.36', proxy: { server: 'http://proxy.example.test:8080', username: 'proxy-user-5521', password: 'proxy-pass-7731' } },
  });
  await inSandbox({ config, state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    for (const e of launches(sandbox)) {
      assert.equal(e.proxy, 'http://proxy.example.test:8080');
      assert.equal(e.userAgent, 'Mozilla/5.0 (Test) Chrome/130.0.0.0 Safari/537.36');
    }
    assert.match(r.stdout, /proxy http:\/\/proxy\.example\.test:8080 \(authenticated\)/);
    const everything = r.stdout + r.stderr + fs.readdirSync(sandbox.logs).map(f => fs.readFileSync(path.join(sandbox.logs, f), 'utf8')).join('\n');
    assert.ok(!everything.includes('proxy-pass-7731'), 'the proxy password reaches no output, log or journal');
    assert.ok(!everything.includes('proxy-user-5521'));
  });
});

test('a headless launch announces itself as regular Chrome, never HeadlessChrome', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    await runWatcher(sandbox, ['--only', 'Spokeo']);
    const [first] = launches(sandbox);
    assert.equal(first.headless, true);
    assert.ok(first.userAgent, 'a user agent is set');
    assert.doesNotMatch(first.userAgent, /HeadlessChrome/);
    assert.match(first.userAgent, /Chrome\/148\.0\.0\.0 Safari\/537\.36$/, 'the major version is the pinned browser\'s own');
  });
});

test('a malformed browser section refuses the run, even a dry run, and launches nothing', async () => {
  const config = runnableConfig({ browser: { proxxy: { server: 'http://proxy.example.test:8080' }, proxy: { server: 'ftp://proxy.example.test:21', password: 'proxy-pass-7731' } } });
  await inSandbox({ config }, async (sandbox) => {
    for (const args of [['--only', 'Spokeo'], ['--only', 'Spokeo', '--dry-run']]) {
      const r = await runWatcher(sandbox, args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, /config is not runnable/);
      assert.match(r.stderr, /unknown browser key "proxxy"/);
      assert.ok(!(r.stdout + r.stderr).includes('proxy-pass-7731'));
    }
    assert.deepEqual(launches(sandbox), []);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'last-run.json')), false);
  });
});

// ── R1: who solves the CAPTCHAs ──────────────────────────────────────────────

const headed = { HEADLESS: '0' };

test('headless, the run says no CAPTCHA can be solved by hand and points at aidr captchas', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.match(r.stdout, /CAPTCHAs: no display here, so a CAPTCHA the solver cannot do is listed at the end\. Solve them on a desktop machine with: aidr captchas/);
  });
});

test('--solve-captchas on a headless run says it needs a visible browser', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--solve-captchas']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--solve-captchas needs a visible browser and this run is headless/);
  });
});

test('--solve-captchas on a headed run turns manual solving on, with the configured wait', async () => {
  await inSandbox({ config: runnableConfig({ captcha: { manualTimeoutSec: 45 } }), state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--solve-captchas'], { env: headed });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /CAPTCHAs: you solve them in the browser window \(up to 45s each\)/);
  });
});

test('a usable CapSolver key is tried first, then the person', async () => {
  const config = runnableConfig({ capsolver: { apiKey: 'CAP-0123456789abcdef0123' }, captcha: { manual: true } });
  await inSandbox({ config, state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env: headed });
    assert.match(r.stdout, /CAPTCHAs: CapSolver first, then you solve them in the browser window \(up to 3 min each\)/);
  });
});

test('headed with no terminal and captcha.manual "auto" is solver-only, and says how to solve them later', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env: headed });
    assert.match(r.stdout, /CAPTCHAs: solver only \(no interactive terminal\)\. To solve them yourself afterwards: aidr captchas/);
  });
});

test('captcha.manual: false is solver-only even with --solve-captchas absent', async () => {
  await inSandbox({ config: runnableConfig({ captcha: { manual: false } }), state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env: headed });
    assert.match(r.stdout, /CAPTCHAs: solver only \(.*\)/);
  });
});

test('a mistyped captcha setting is a warning at the start of the run, and the run goes on', async () => {
  await inSandbox({ config: runnableConfig({ captcha: { manual: 'sometimes' } }), state: freshSpokeo }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /config: captcha\.manual must be "auto", true or false \(got "sometimes"\); it is treated as "auto"/);
  });
});

test('a dry run and --verify say nothing about who solves CAPTCHAs, but a mistyped setting still warns', async () => {
  const config = runnableConfig({ captcha: { manual: 'sometimes' } });
  await inSandbox({ config, state: freshSpokeo }, async (sandbox) => {
    const dry = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.doesNotMatch(dry.stdout, /🧩 CAPTCHAs:/, 'a dry run never waits for anyone');
    assert.match(dry.stdout, /config: captcha\.manual must be/);

    const verify = await runWatcher(sandbox, ['--verify']);
    assert.equal(verify.code, 0, verify.stderr);
    assert.doesNotMatch(verify.stdout, /🧩 CAPTCHAs:/);
  });
});

// ── R6: retention at the end of a run ────────────────────────────────────────

test('retention.days purges old PII files at the end of a real run, and never this run\'s own', async () => {
  await inSandbox({ config: runnableConfig({ retention: { days: 30 } }), state: freshSpokeo }, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Retention \(retention\.days=30\):/);
    for (const name of ['oldRun', 'oldJournal', 'oldAudit', 'oldSnapshot', 'oldReport', 'middleRun']) {
      assert.equal(fs.existsSync(files[name]), false, `${name} is past 30 days`);
    }
    assert.equal(fs.existsSync(files.complaint), true, 'complaints are legal records');
    assert.equal(journalsIn(sandbox.logs).length >= 1, true);
    assert.ok(fs.readdirSync(sandbox.logs).some(f => /^audit-2026-10/.test(f) || /^audit-\d{4}-\d{2}-\d{2}T/.test(f)));
    const { body } = summaryOf(sandbox.logs);
    assert.ok(body.skipped.length >= 2, 'this run\'s own summary survived its own retention pass');
  });
});

test('a dry run never purges, whatever retention.days says', async () => {
  await inSandbox({ config: runnableConfig({ retention: { days: 30 } }), state: freshSpokeo }, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Retention/);
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file));
  });
});

test('without retention.days nothing is purged and nothing is said', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.doesNotMatch(r.stdout, /Retention/);
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file));
  });
});

test('an unusable retention.days deletes nothing and says why', async () => {
  await inSandbox({ config: runnableConfig({ retention: { days: 3 } }), state: freshSpokeo }, async (sandbox) => {
    const files = seedArtifacts(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Retention ignored: retention\.days: must be at least 7 days \(got 3\).*No files were purged\./);
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file));
  });
});

// ── R0: AIDR_HOME ────────────────────────────────────────────────────────────

test('AIDR_HOME alone relocates config, state, logs, journal, heartbeat and the confirmation inbox', async () => {
  await inSandbox({ config: null, state: null }, async (sandbox) => {
    const home = path.join(sandbox.dir, 'aidr-home');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(runnableConfig()), { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(freshSpokeo), { mode: 0o600 });
    const env = { AIDR_HOME: home, AIDR_CONFIG_PATH: '', AIDR_CONFIG_ENC_PATH: '', AIDR_STATE_PATH: '' };

    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(journalsIn(path.join(home, 'logs')).length, 1, 'logs and the journal sit under AIDR_HOME/logs');
    assert.ok(fs.readdirSync(path.join(home, 'logs')).some(f => /^audit-/.test(f)));
    assert.ok(fs.existsSync(path.join(home, 'last-run.json')), 'the heartbeat sits beside the state');
    assert.equal(fs.existsSync(sandbox.logs), false, 'nothing went to the app directory');
    assert.ok(fs.existsSync(path.join(home, 'state.json.bak')) || fs.existsSync(path.join(home, 'state.json')));

    const confirm = await runWatcher(sandbox, ['--confirm-emails'], { env });
    assert.equal(confirm.code, 0, confirm.stderr);
    assert.ok(confirm.stdout.includes(`Processing confirmation emails from: ${path.join(home, 'inbox', 'confirms')}`), confirm.stdout);
  });
});

test('AIDR_LOG_DIR moves only the logs', async () => {
  await inSandbox({ state: freshSpokeo }, async (sandbox) => {
    const logs = path.join(sandbox.dir, 'elsewhere');
    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env: { AIDR_LOG_DIR: logs } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(journalsIn(logs).length, 1);
    assert.equal(fs.existsSync(sandbox.logs), false);
    assert.ok(fs.existsSync(path.join(sandbox.home, 'last-run.json')), 'the heartbeat stays beside the state');
  });
});
