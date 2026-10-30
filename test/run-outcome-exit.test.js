/**
 * test/run-outcome-exit.test.js
 *
 * CLI2-3: a run that failed outright (every broker errored) exited 0, so cron,
 * launchd and `docker run` all reported success; `aidr schedule status` exited 0
 * for an installed job whose last run had crashed or failed; and notify.webhook
 * (documented as "POSTs after every run") was never called, at the end of a run
 * or when it crashed. Now:
 *
 *   - a real run whose outcome is `failed` exits 1;
 *   - `schedule status` exits 3 when the last full run failed or crashed (1 and 2
 *     keep priority: nothing installed, installed but not active);
 *   - the end of a real run and the Fatal handler both POST to notify.webhook,
 *     never from a dry run or a preview.
 *
 * Black-box: the real watcher.js in the sandbox (fake playwright, refused network).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const { buildPlist, buildSystemdUnits } = require('../lib/scheduler');

const PRELOAD = path.join(__dirname, 'helpers', 'cli2-preload.js');
const WEBHOOK = 'https://hooks.example.test/aidr';
const posix = process.platform !== 'win32';
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

const withWebhook = () => runnableConfig({ notify: { textTo: '', webhook: WEBHOOK } });

// Extra fault injection layered on the sandbox's fake playwright.
function injected(sandbox, extra = {}) {
  const log = path.join(sandbox.dir, 'cli2.log');
  return {
    env: {
      NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`,
      AIDR_TEST_LOG: log,
      AIDR_TEST_FETCH_BODY: '1',
      ...extra,
    },
    events: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  };
}

const webhookPosts = (events) => events.filter(e => e.event === 'fetch-body' && e.url === WEBHOOK);

// ── the exit status of a run ─────────────────────────────────────────────────

test('a real run in which every broker errored exits 1, and POSTs the webhook once saying so', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox);
    // The fake browser refuses every navigation, so every explicit form errors.
    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], { env: extra.env });
    assert.equal(r.code, 1, r.stdout + r.stderr);

    const beat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
    assert.equal(beat.outcome, 'failed', 'the heartbeat and the exit status agree');

    const posts = webhookPosts(extra.events());
    assert.equal(posts.length, 1, 'one webhook POST per run');
    const body = JSON.parse(posts[0].body);
    assert.match(body.text, /FAILED/, 'a failed run does not read like a finished one');
    assert.match(body.text, /Errors: \d+/);
    assert.equal(posts[0].hasSignal, true, 'the POST has a deadline: a hung webhook must not hang the run');
  });
});

test('the desktop notification of a failed run says it failed too', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 1);
    const calls = sandbox.notificationCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Failed/);
    assert.doesNotMatch(calls[0], /Done - /);
  });
});

test('a run that finished with nothing wrong still exits 0 and still POSTs the webhook', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], { env: extra.env });
    assert.equal(r.code, 0, r.stderr);
    const posts = webhookPosts(extra.events());
    assert.equal(posts.length, 1);
    assert.doesNotMatch(JSON.parse(posts[0].body).text, /FAILED/);
  });
});

test('a dry run exits 0 whatever its brokers did, and never POSTs the webhook', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run'], { env: extra.env });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(webhookPosts(extra.events()), []);
    assert.deepEqual(sandbox.notificationCalls(), []);
  });
});

test('a preview never POSTs the webhook either', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox);
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--preview'], { env: extra.env });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(webhookPosts(extra.events()), []);
  });
});

// ── a crash ──────────────────────────────────────────────────────────────────

test('a crash exits 1 and reaches the webhook, not only iMessage', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox, { AIDR_TEST_JOURNAL_THROWS: '1' });
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], { env: extra.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Fatal: journal disk full/);

    const posts = webhookPosts(extra.events());
    assert.equal(posts.length, 1, 'one POST for the crash');
    assert.match(JSON.parse(posts[0].body).text, /crashed: journal disk full/);

    const beat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
    assert.equal(beat.outcome, 'failed');
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released on the way out');
  });
});

test('a crash in a dry run exits 1 but notifies nobody', async () => {
  await inSandbox({ config: withWebhook() }, async (sandbox) => {
    const extra = injected(sandbox, { AIDR_TEST_GENERIC_THROWS: '1' });
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--dry-run'], { env: extra.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Fatal: generic pass exploded/);
    assert.deepEqual(webhookPosts(extra.events()), [], 'a rehearsal does not page anyone');
    assert.deepEqual(sandbox.notificationCalls(), []);
  });
});

// ── schedule status ──────────────────────────────────────────────────────────

function installJob(sandbox, { active = true } = {}) {
  const scriptPath = path.join(sandbox.repo, 'run.sh');
  const logDir = path.join(sandbox.repo, 'logs');
  let answers;
  if (process.platform === 'darwin') {
    const dir = path.join(sandbox.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'com.auto-identity-remove.plist'), buildPlist(scriptPath, logDir, { env: {} }));
    answers = { 'launchctl list com.auto-identity-remove': { status: active ? 0 : 113 } };
  } else {
    const dir = path.join(sandbox.home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const units = buildSystemdUnits(scriptPath, logDir, { env: {} });
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.service'), units.service);
    fs.writeFileSync(path.join(dir, 'auto-identity-remove.timer'), units.timer);
    answers = { 'systemctl --user is-enabled auto-identity-remove.timer': { status: active ? 0 : 1, stdout: 'enabled\n' } };
  }
  const file = path.join(sandbox.dir, 'scheduler.json');
  fs.writeFileSync(file, JSON.stringify(answers));
  return { AIDR_FAKE_SCHEDULER: file };
}

const writeBeat = (sandbox, beat) => fs.writeFileSync(path.join(sandbox.home, 'last-run.json'), JSON.stringify(beat), { mode: 0o600 });
const finished = (outcome) => ({ startedAt: daysAgo(2), finishedAt: new Date(Date.now() - 2 * day + 600000).toISOString(), outcome, counts: {} });

test('schedule status exits 3 when the last run failed', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox);
    writeBeat(sandbox, finished('failed'));
    const r = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /failed/);
  });
});

test('schedule status exits 3 when the last run crashed (a start with no end)', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox);
    writeBeat(sandbox, { startedAt: daysAgo(3), finishedAt: null, outcome: null, counts: {} });
    const r = await runWatcher(sandbox, ['--schedule-status', '--json'], { env });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stdout).lastRun.outcome, 'crashed');
  });
});

test('schedule status exits 0 for a healthy job: ok and partial runs are not failures', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox);
    for (const outcome of ['ok', 'partial']) {
      writeBeat(sandbox, finished(outcome));
      const r = await runWatcher(sandbox, ['--schedule-status'], { env });
      assert.equal(r.code, 0, `${outcome}: ${r.stdout}`);
    }
  });
});

test('schedule status keeps its older verdicts first: not active is 2 even when the last run failed', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    const env = installJob(sandbox, { active: false });
    writeBeat(sandbox, finished('failed'));
    const r = await runWatcher(sandbox, ['--schedule-status'], { env });
    assert.equal(r.code, 2);
  });
});

test('schedule status with nothing installed is still 1, whatever the last run was', { skip: !posix }, async () => {
  await inSandbox({}, async (sandbox) => {
    writeBeat(sandbox, finished('failed'));
    const r = await runWatcher(sandbox, ['--schedule-status']);
    assert.equal(r.code, 1);
  });
});
