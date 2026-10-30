/**
 * test/run-lock-and-state.test.js
 *
 * Two things the run loop did around its lock:
 *
 *   - Nothing refreshed the lock while a run was alive, so a run longer than the max
 *     age (default 6 hours) lost its lock to the next one. A live run now re-stamps it.
 *   - state.json was loaded when the process started, BEFORE the lock was taken. A run
 *     that waited on (or was started right behind) another one then worked from, and
 *     saved over, a state that run had already moved on. The state is now read again
 *     once the lock is ours.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const PRELOAD = path.join(__dirname, 'helpers', 'cli2-preload.js');
const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

test('a live run keeps refreshing its lock (so it can outlast the max age), and the lock records how often', async () => {
  await inSandbox({ state: null }, async (sandbox) => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(sandbox.repo, 'watcher.js'), '--only', 'zzz-no-such-broker'], {
      cwd: sandbox.repo,
      env: { ...sandbox.env, AIDR_FAKE_HANG: 'init', AIDR_LOCK_REFRESH_MS: '100' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    try {
      const deadline = Date.now() + 15000;
      while (!/FAKE_BROWSER_HANGING/.test(stderr) && Date.now() < deadline) await sleep(50);
      assert.match(stderr, /FAKE_BROWSER_HANGING/, 'the run parked inside the browser launch');

      const first = JSON.parse(fs.readFileSync(sandbox.lock, 'utf8'));
      assert.equal(first.refreshMs, 100, 'the lock says how often its holder refreshes it');
      assert.equal(first.pid, child.pid);
      // Backdate it as if the run had been going for seven hours without a refresh.
      fs.writeFileSync(sandbox.lock, JSON.stringify({ ...first, ts: new Date(Date.now() - 7 * 3600 * 1000).toISOString() }));

      let refreshed = false;
      for (let i = 0; i < 60 && !refreshed; i++) {
        await sleep(50);
        try { refreshed = Date.now() - Date.parse(JSON.parse(fs.readFileSync(sandbox.lock, 'utf8')).ts) < 60000; } catch (_) { /* mid-rename */ }
      }
      assert.equal(refreshed, true, 'the running watcher re-stamped its own lock');
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => child.on('close', resolve));
    }
    assert.equal(fs.existsSync(sandbox.lock), false, 'and still released it on the way out');
  });
});

test('state.json is read again after the lock is taken, so a run that just finished is not overwritten', async () => {
  const fresh = { lastSuccess: daysAgo(2), lastAttempt: daysAgo(2) };
  await inSandbox({ state: { optOuts: {} } }, async (sandbox) => {
    // What another run saved between this one's start-up and its lock.
    const newer = path.join(sandbox.dir, 'newer-state.json');
    fs.writeFileSync(newer, JSON.stringify({ optOuts: { Spokeo: fresh, 'Spokeo|Alan Turing': fresh } }));
    const log = path.join(sandbox.dir, 'cli2.log');

    const r = await runWatcher(sandbox, ['--only', 'Spokeo'], {
      env: {
        NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`,
        AIDR_TEST_LOG: log,
        AIDR_TEST_STATE_ON_LOCK: newer,
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(fs.readFileSync(log, 'utf8'), /state-replaced/, 'the other run really did save in between');
    assert.match(r.stdout, /Spokeo\] skipped - Last removed 2d ago/, 'the fresh success was seen');
    assert.equal(sandbox.fakeEvents().some(e => e.event === 'goto'), false, 'so nothing was submitted a second time');
    const saved = sandbox.readState();
    assert.ok(saved.optOuts.Spokeo, 'and the other run\'s entry is still in state.json after this run saved');
  });
});
