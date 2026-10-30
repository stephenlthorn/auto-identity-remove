/**
 * test/shutdown-repeat-signal.test.js
 *
 * CLI2-7: Ctrl-C through the `aidr` dispatcher reached the watcher TWICE. The terminal
 * signals the whole foreground process group (dispatcher and watcher both), and the
 * dispatcher then forwards the SIGINT it got to the child as well. The watcher took
 * the second one for the user pressing Ctrl-C again ("send it again to quit
 * immediately"), exited at once, and skipped the cleanups that had only just started:
 * the heartbeat was left unfinished, so the run read as crashed later.
 *
 * The same signal arriving again within a second of the first is the same Ctrl-C and
 * is ignored. A real second press (outside that window) and a DIFFERENT signal still
 * force the immediate exit.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { installShutdownHandlers, REPEAT_GRACE_MS } = require('../lib/shutdown');
const { createSandbox } = require('./helpers/watcher-sandbox');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = code => { proc.exits.push(code); };
  return proc;
}

function fakeClock(start = 1000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function stuckCleanup(sd) {
  const calls = { runs: 0, release: null };
  sd.register(() => { calls.runs += 1; return new Promise(resolve => { calls.release = resolve; }); });
  return calls;
}

test('the grace window is one second', () => {
  assert.equal(REPEAT_GRACE_MS, 1000);
});

test('the same signal again within the window is the same Ctrl-C: ignored, not an immediate exit', async () => {
  const proc = fakeProcess();
  const now = fakeClock();
  const lines = [];
  const sd = installShutdownHandlers({ proc, now, log: m => lines.push(m), timeoutMs: 5000 });
  const cleanup = stuckCleanup(sd);

  proc.emit('SIGINT');
  now.advance(15); // the dispatcher's forwarded copy
  proc.emit('SIGINT');
  assert.deepEqual(proc.exits, [], 'the cleanups are still running: no exit yet');
  assert.equal(cleanup.runs, 1, 'and they ran once');
  assert.ok(!lines.some(l => /received again/.test(l)), 'no "received again" line for a duplicate');

  cleanup.release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(proc.exits, [130], 'the exit comes from the finished cleanups');
});

test('a second Ctrl-C after the window still quits immediately, as the first message promises', () => {
  const proc = fakeProcess();
  const now = fakeClock();
  const lines = [];
  const sd = installShutdownHandlers({ proc, now, log: m => lines.push(m), timeoutMs: 5000 });
  const cleanup = stuckCleanup(sd);

  proc.emit('SIGINT');
  now.advance(REPEAT_GRACE_MS + 1);
  proc.emit('SIGINT');
  assert.deepEqual(proc.exits, [130], 'a stuck cleanup cannot trap the user');
  assert.equal(cleanup.runs, 1);
  assert.ok(lines.some(l => /received again, exiting now/.test(l)));
});

test('a different signal inside the window is a new request and quits immediately', () => {
  const proc = fakeProcess();
  const now = fakeClock();
  const sd = installShutdownHandlers({ proc, now, log: () => {}, timeoutMs: 5000 });
  stuckCleanup(sd);

  proc.emit('SIGINT');
  now.advance(10);
  proc.emit('SIGTERM');
  assert.deepEqual(proc.exits, [143]);
});

test('repeating inside the window does not extend it: the window runs from the FIRST signal', () => {
  const proc = fakeProcess();
  const now = fakeClock();
  const sd = installShutdownHandlers({ proc, now, log: () => {}, timeoutMs: 5000 });
  stuckCleanup(sd);

  proc.emit('SIGINT');
  now.advance(600);
  proc.emit('SIGINT'); // ignored
  now.advance(600); // 1200 ms after the first
  proc.emit('SIGINT');
  assert.deepEqual(proc.exits, [130]);
});

test('a real watcher given two SIGINTs back to back finishes its cleanups: heartbeat written, exit 130', async () => {
  const sandbox = createSandbox({ state: null });
  try {
    const child = spawn(process.execPath, [path.join(sandbox.repo, 'watcher.js'), '--only', 'zzz-no-such-broker'], {
      cwd: sandbox.repo,
      env: {
        ...sandbox.env,
        NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${path.join(__dirname, 'helpers', 'cli2-preload.js')}`,
        AIDR_FAKE_HANG: 'init',
        // Closing the browser takes a while, as it does for real: the second signal
        // lands while the cleanups are still running.
        AIDR_TEST_SLOW_CLOSE: '400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));

    const deadline = Date.now() + 15000;
    while (!/FAKE_BROWSER_HANGING/.test(stderr) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.match(stderr, /FAKE_BROWSER_HANGING/);

    // The terminal's copy and the dispatcher's forwarded copy: two deliveries a few
    // milliseconds apart (sent back to back, the kernel would merge them into one).
    child.kill('SIGINT');
    await new Promise(r => setTimeout(r, 40));
    child.kill('SIGINT');
    const { code, signal } = await closed;

    assert.equal(signal, null);
    assert.equal(code, 130, stderr);
    assert.doesNotMatch(stderr, /received again/);
    const beat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
    assert.equal(beat.outcome, 'failed', 'the interrupted run says so: it did not exit mid-cleanup and read as crashed');
    assert.notEqual(beat.finishedAt, null);
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock was released by the cleanups');
  } finally {
    sandbox.cleanup();
  }
});
