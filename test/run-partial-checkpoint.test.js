/**
 * test/run-partial-checkpoint.test.js
 *
 * CLI2-10: a filtered run (--only, --skip, --retry-failed, --captchas) wrote and
 * then CLEARED the resume checkpoint, so a killed full run lost its resume point to
 * the next `aidr run --only Spokeo`; and it replaced last-run.json with its own "ok",
 * which hid a failed monthly run from `aidr schedule status`.
 *
 * A filtered run now leaves the checkpoint alone, tells the runners it is partial
 * (broker-runner.configure({ partial: true }), and runGenericBrokers gets no
 * saveCheckpoint), and writes a heartbeat tagged partial that carries the last full
 * run's record forward. --resume is NOT a filtered run: it finishes the interrupted
 * full run, so it keeps writing and then clears the checkpoint.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');
const { buildPlist, buildSystemdUnits } = require('../lib/scheduler');

const PRELOAD = path.join(__dirname, 'helpers', 'cli2-preload.js');
const posix = process.platform !== 'win32';
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

async function inSandbox(fn) {
  const sandbox = createSandbox();
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

function spying(sandbox) {
  const log = path.join(sandbox.dir, 'cli2.log');
  return {
    env: { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`, AIDR_TEST_LOG: log, AIDR_TEST_SPY: '1' },
    events: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  };
}

const checkpointOf = (sandbox) => `${sandbox.state}.checkpoint`;
const seedCheckpoint = (sandbox, content) => fs.writeFileSync(checkpointOf(sandbox), content, { mode: 0o600 });
const heartbeatOf = (sandbox) => JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));

// ── the checkpoint ───────────────────────────────────────────────────────────

test('--only leaves a killed run\'s checkpoint where it was', async () => {
  await inSandbox(async (sandbox) => {
    const record = JSON.stringify({ phase: 'generic', personIndex: 0, key: 'Some Broker|Ada Lovelace', index: 120 }) + '\n';
    seedCheckpoint(sandbox, record);
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(checkpointOf(sandbox), 'utf8'), record, 'the resume point of the interrupted run is untouched');
  });
});

test('--skip and --retry-failed leave it too', async () => {
  await inSandbox(async (sandbox) => {
    const record = 'Radaris|Ada Lovelace\n';
    seedCheckpoint(sandbox, record);
    // Everything but one broker would run the whole generic pass: skip nearly all by also naming only.
    for (const args of [['--only', 'zzz-no-such-broker', '--skip', 'Spokeo'], ['--only', 'zzz-no-such-broker', '--retry-failed']]) {
      const r = await runWatcher(sandbox, args);
      assert.ok(r.code === 0 || r.code === 1, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(fs.readFileSync(checkpointOf(sandbox), 'utf8'), record, args.join(' '));
    }
  });
});

test('a filtered run tells the runners it is partial and gives the generic pass no checkpoint writer', async () => {
  await inSandbox(async (sandbox) => {
    const spy = spying(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], { env: spy.env });
    assert.equal(r.code, 0, r.stderr);
    const events = spy.events();
    const partials = events.filter(e => e.event === 'configure').map(e => e.partial);
    assert.ok(partials.length > 0, 'the explicit runner was configured with an explicit partial flag');
    assert.deepEqual([...new Set(partials)], [true]);
    const generic = events.filter(e => e.event === 'generic-opts');
    assert.equal(generic.length, 2, 'one generic pass per person');
    assert.deepEqual(generic.map(g => g.hasSaveCheckpoint), [false, false], 'a partial run must not write the full run\'s resume point');
    assert.deepEqual(generic.map(g => g.hasGetContext), [true, true], 'but it can still ask for a live browser');
  });
});

test('a full run (no filter) still writes checkpoints and says it is not partial', async () => {
  await inSandbox(async (sandbox) => {
    const spy = spying(sandbox);
    const r = await runWatcher(sandbox, [], { env: spy.env, timeoutMs: 120000 });
    assert.equal(r.code, 1, 'every broker errors against the fake browser');
    const events = spy.events();
    assert.deepEqual([...new Set(events.filter(e => e.event === 'configure').map(e => e.partial))], [false]);
    assert.deepEqual(events.filter(e => e.event === 'generic-opts').map(g => g.hasSaveCheckpoint), [true, true]);
    assert.equal(fs.existsSync(checkpointOf(sandbox)), false, 'and clears it once the run completes');
  });
});

test('--resume is not a filtered run: it keeps the checkpoint going and clears it at the end', async () => {
  await inSandbox(async (sandbox) => {
    const spy = spying(sandbox);
    seedCheckpoint(sandbox, JSON.stringify({ phase: 'generic', personIndex: 0, key: 'Whatever|Ada Lovelace', index: 3 }) + '\n');
    const r = await runWatcher(sandbox, ['--resume'], { env: spy.env, timeoutMs: 120000 });
    assert.equal(r.code, 1);
    const events = spy.events();
    assert.deepEqual([...new Set(events.filter(e => e.event === 'configure').map(e => e.partial))], [false]);
    assert.ok(events.filter(e => e.event === 'generic-opts').every(g => g.hasSaveCheckpoint));
    assert.equal(fs.existsSync(checkpointOf(sandbox)), false, 'the resumed run completed the interrupted one');
  });
});

// ── the heartbeat ────────────────────────────────────────────────────────────

test('a filtered run writes a partial heartbeat and keeps the failed monthly run beside it', async () => {
  await inSandbox(async (sandbox) => {
    const monthly = { startedAt: daysAgo(3), finishedAt: new Date(Date.now() - 3 * day + 600000).toISOString(), outcome: 'failed', counts: { errors: 40 } };
    fs.writeFileSync(path.join(sandbox.home, 'last-run.json'), JSON.stringify(monthly), { mode: 0o600 });

    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assert.equal(r.code, 0, r.stderr);

    const beat = heartbeatOf(sandbox);
    assert.equal(beat.partial, true);
    assert.equal(beat.outcome, 'ok');
    assert.deepEqual(beat.lastFull, monthly, 'the failed monthly run is carried, not replaced');
  });
});

test('a full run writes no partial marker', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--resume'], { timeoutMs: 120000 });
    assert.equal(r.code, 1);
    assert.equal('partial' in heartbeatOf(sandbox), false, '--resume completes the full run, so it is one');
  });
});

function installJob(sandbox) {
  const scriptPath = path.join(sandbox.repo, 'run.sh');
  const logDir = path.join(sandbox.repo, 'logs');
  let answers;
  if (process.platform === 'darwin') {
    const dir = path.join(sandbox.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'com.auto-identity-remove.plist'), buildPlist(scriptPath, logDir, { env: {} }));
    answers = { 'launchctl list com.auto-identity-remove': { status: 0 } };
  } else {
    const dir = path.join(sandbox.home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const units = buildSystemdUnits(scriptPath, logDir, { env: {} });
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.service'), units.service);
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.timer'), units.timer);
    answers = { 'systemctl --user is-enabled auto-identity-remove.timer': { status: 0, stdout: 'enabled\n' } };
  }
  const file = path.join(sandbox.dir, 'scheduler.json');
  fs.writeFileSync(file, JSON.stringify(answers));
  return { AIDR_FAKE_SCHEDULER: file };
}

test('schedule status still says the monthly run failed after a clean filtered run (exit 3)', { skip: !posix }, async () => {
  await inSandbox(async (sandbox) => {
    const env = installJob(sandbox);
    const monthly = { startedAt: daysAgo(3), finishedAt: new Date(Date.now() - 3 * day + 600000).toISOString(), outcome: 'failed', counts: { errors: 40 } };
    fs.writeFileSync(path.join(sandbox.home, 'last-run.json'), JSON.stringify(monthly), { mode: 0o600 });
    const run = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assert.equal(run.code, 0, run.stderr);

    const r = await runWatcher(sandbox, ['--schedule-status', '--json'], { env });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const status = JSON.parse(r.stdout);
    assert.equal(status.lastRun.outcome, 'failed', 'the last FULL run');
    assert.equal(status.lastPartialRun.outcome, 'ok');

    const text = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.match(text.stdout, /Last run: .*failed/);
    assert.match(text.stdout, /Partial:/);
  });
});
