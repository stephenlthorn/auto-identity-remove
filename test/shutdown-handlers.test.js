/**
 * test/shutdown-handlers.test.js
 *
 * CFG-5 / CORE roadmap 1: watcher.js had no SIGINT/SIGTERM handler, so
 * `docker stop`, a DSM kill or Ctrl-C skipped every `finally`: the browser
 * context stayed open, the lock stayed on disk and in-memory state was lost.
 *
 * lib/shutdown.js runs the registered async cleanups once, with a hard timeout,
 * then exits 130 (SIGINT) / 143 (SIGTERM) / 129 (SIGHUP). The unit tests inject
 * a fake `process`; the integration tests signal a real child process.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { installShutdownHandlers, SIGNAL_EXIT_CODES, DEFAULT_TIMEOUT_MS } = require('../lib/shutdown');

const SHUTDOWN_MODULE = path.resolve(__dirname, '..', 'lib', 'shutdown.js');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = code => { proc.exits.push(code); };
  return proc;
}

function fakeLog() {
  const lines = [];
  const log = msg => lines.push(String(msg));
  log.lines = lines;
  return log;
}

function exitedWith(proc, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (proc.exits.length > 0 && predicate()) return resolve(proc.exits.slice());
      if (Date.now() - started > timeoutMs) return reject(new Error('process.exit was never called'));
      setTimeout(poll, 2);
    };
    poll();
  });
}

test('installs a handler for SIGINT, SIGTERM and SIGHUP', () => {
  const proc = fakeProcess();
  const sd = installShutdownHandlers({ proc, log: fakeLog() });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.equal(proc.listenerCount(sig), 1, `${sig} should have a listener`);
  }
  sd.uninstall();
});

test('uninstall removes every listener it added', () => {
  const proc = fakeProcess();
  const sd = installShutdownHandlers({ proc, log: fakeLog() });
  sd.uninstall();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(proc.listenerCount(sig), 0);
});

test('exit codes are 130 for SIGINT, 143 for SIGTERM and 129 for SIGHUP', async () => {
  assert.deepEqual(SIGNAL_EXIT_CODES, { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const proc = fakeProcess();
    installShutdownHandlers({ proc, log: fakeLog() });
    proc.emit(sig);
    assert.deepEqual(await exitedWith(proc), [code], sig);
  }
});

test('runs the cleanups from onShutdown, passing the signal name, then exits', async () => {
  const proc = fakeProcess();
  const seen = [];
  installShutdownHandlers({ proc, log: fakeLog(), onShutdown: sig => { seen.push(sig); } });
  proc.emit('SIGTERM');
  await exitedWith(proc);
  assert.deepEqual(seen, ['SIGTERM']);
});

test('onShutdown may be an array of cleanups', async () => {
  const proc = fakeProcess();
  const ran = [];
  installShutdownHandlers({ proc, log: fakeLog(), onShutdown: [() => ran.push('a'), () => ran.push('b')] });
  proc.emit('SIGINT');
  await exitedWith(proc);
  assert.deepEqual(ran.sort(), ['a', 'b']);
});

test('cleanups run last-registered first, so the browser closes before the lock is released', async () => {
  const proc = fakeProcess();
  const order = [];
  const sd = installShutdownHandlers({ proc, log: fakeLog(), onShutdown: () => order.push('release lock') });
  sd.register(() => order.push('flush state'));
  sd.register(() => order.push('close browser'));
  proc.emit('SIGINT');
  await exitedWith(proc);
  assert.deepEqual(order, ['close browser', 'flush state', 'release lock']);
});

test('async cleanups are awaited one at a time, and exit waits for the last', async () => {
  const proc = fakeProcess();
  const events = [];
  const sd = installShutdownHandlers({ proc, log: fakeLog() });
  sd.register(async () => { events.push('second:start'); await new Promise(r => setTimeout(r, 15)); events.push('second:end'); });
  sd.register(async () => { events.push('first:start'); await new Promise(r => setTimeout(r, 15)); events.push('first:end'); });
  proc.emit('SIGTERM');
  assert.equal(proc.exits.length, 0, 'must not exit before cleanups finish');
  await exitedWith(proc);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a cleanup that throws or rejects does not stop the others or change the exit code', async () => {
  const proc = fakeProcess();
  const log = fakeLog();
  const ran = [];
  const sd = installShutdownHandlers({ proc, log });
  sd.register(() => ran.push('last'));
  sd.register(() => { throw new Error('browser already closed'); });
  sd.register(async () => { throw new Error('flush failed'); });
  proc.emit('SIGINT');
  assert.deepEqual(await exitedWith(proc), [130]);
  assert.deepEqual(ran, ['last']);
  assert.ok(log.lines.some(l => /flush failed/.test(l)), 'failures are reported, not swallowed silently');
});

test('cleanups run once even if the signal arrives repeatedly; the second signal forces an immediate exit', async () => {
  const proc = fakeProcess();
  let runs = 0;
  let release;
  // A second press a moment later (not the same Ctrl-C delivered twice: CLI2-7).
  let clock = 0;
  const sd = installShutdownHandlers({ proc, log: fakeLog(), timeoutMs: 5000, now: () => clock });
  sd.register(() => { runs += 1; return new Promise(r => { release = r; }); });

  proc.emit('SIGINT');
  assert.equal(proc.exits.length, 0);
  clock = 5000;
  proc.emit('SIGINT');
  assert.deepEqual(proc.exits, [130], 'second Ctrl-C must not wait for a stuck cleanup');
  assert.equal(runs, 1, 'cleanups must not run twice');

  release();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(proc.exits, [130], 'exit is called once');
});

test('a cleanup that never finishes is cut off by the hard timeout', async () => {
  const proc = fakeProcess();
  const log = fakeLog();
  const sd = installShutdownHandlers({ proc, log, timeoutMs: 40 });
  sd.register(() => new Promise(() => {}));
  const started = Date.now();
  proc.emit('SIGTERM');
  assert.deepEqual(await exitedWith(proc), [143]);
  assert.ok(Date.now() - started >= 35, 'should wait for the timeout');
  assert.ok(log.lines.some(l => /timed out/i.test(l)));
});

test('the default hard timeout is 10 seconds', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10000);
});

test('register returns a function that removes the cleanup', async () => {
  const proc = fakeProcess();
  const ran = [];
  const sd = installShutdownHandlers({ proc, log: fakeLog() });
  const unregister = sd.register(() => ran.push('removed'));
  sd.register(() => ran.push('kept'));
  unregister();
  proc.emit('SIGINT');
  await exitedWith(proc);
  assert.deepEqual(ran, ['kept']);
});

test('shutdown() can be triggered programmatically and reports isShuttingDown', async () => {
  const proc = fakeProcess();
  const ran = [];
  const sd = installShutdownHandlers({ proc, log: fakeLog(), onShutdown: () => ran.push('x') });
  assert.equal(sd.isShuttingDown(), false);
  const done = sd.shutdown('SIGTERM');
  assert.equal(sd.isShuttingDown(), true);
  await done;
  assert.deepEqual(proc.exits, [143]);
  assert.deepEqual(ran, ['x']);
});

test('with no cleanups registered it still exits with the signal code', async () => {
  const proc = fakeProcess();
  installShutdownHandlers({ proc, log: fakeLog() });
  proc.emit('SIGHUP');
  assert.deepEqual(await exitedWith(proc), [129]);
});

// ─── real process ────────────────────────────────────────────────────────────

function runWithSignal(signal, body) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-shutdown-'));
    const marker = path.join(dir, 'cleanup-ran');
    const source = `
      const fs = require('fs');
      const { installShutdownHandlers } = require(${JSON.stringify(SHUTDOWN_MODULE)});
      const sd = installShutdownHandlers({ log: () => {} });
      ${body}
      sd.register(async () => {
        await new Promise(r => setTimeout(r, 20));
        fs.writeFileSync(${JSON.stringify(marker)}, process.argv[1] || 'ran');
      });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', source, 'cleanup-ok'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.once('data', () => child.kill(signal));
    child.on('exit', (code, sig) => {
      const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, sig, ran });
    });
  });
}

const posix = process.platform !== 'win32';

test('a real SIGTERM runs the async cleanup and exits 143', { skip: !posix }, async () => {
  const r = await runWithSignal('SIGTERM', '');
  assert.equal(r.sig, null, 'it must exit by itself, not be killed by the signal');
  assert.equal(r.code, 143);
  assert.equal(r.ran, 'cleanup-ok');
});

test('a real SIGINT runs the async cleanup and exits 130', { skip: !posix }, async () => {
  const r = await runWithSignal('SIGINT', '');
  assert.equal(r.code, 130);
  assert.equal(r.ran, 'cleanup-ok');
});

test('a real process stuck in a cleanup is still ended by the hard timeout', { skip: !posix }, async () => {
  const r = await new Promise((resolve, reject) => {
    const source = `
      const { installShutdownHandlers } = require(${JSON.stringify(SHUTDOWN_MODULE)});
      const sd = installShutdownHandlers({ log: () => {}, timeoutMs: 100 });
      sd.register(() => new Promise(() => {}));
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.once('data', () => child.kill('SIGTERM'));
    child.on('exit', (code, sig) => resolve({ code, sig }));
  });
  assert.equal(r.code, 143);
});
