'use strict';

/**
 * lib/shutdown.js
 *
 * Signal-safe shutdown for watcher.js (CFG-5).
 *
 * `docker stop`, a Synology/DSM kill, a scheduler unload and Ctrl-C all deliver
 * SIGTERM/SIGINT/SIGHUP. With no handler Node dies on the spot: `finally`
 * blocks never run, the Playwright context is left open, the lock file stays on
 * disk and unsaved state is lost.
 *
 * installShutdownHandlers({ onShutdown }) registers one handler for all three.
 * On the first signal it runs the registered cleanups ONCE (last registered
 * first, so the browser closes before the lock is released), each awaited and
 * individually guarded, under a hard timeout, then exits with 128 + signal
 * number: 130 SIGINT, 143 SIGTERM, 129 SIGHUP. A second signal while cleaning up
 * exits immediately, so a stuck cleanup can never trap the user - unless it is the
 * SAME signal within REPEAT_GRACE_MS of the first. Ctrl-C through the `aidr`
 * dispatcher reaches the watcher twice (the terminal signals the whole process
 * group and the dispatcher forwards its own copy), and treating that copy as a
 * second press quit in the middle of the cleanups (CLI2-7).
 *
 * Usage:
 *   const shutdown = installShutdownHandlers({ onShutdown: () => lock.release(LOCK_PATH) });
 *   shutdown.register(() => context.close());
 *   shutdown.register(() => { if (!DRY_RUN) saveState(); });
 */

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const DEFAULT_TIMEOUT_MS = 10000;
// The same signal again this soon after the first is one Ctrl-C delivered twice, not
// the user pressing it again.
const REPEAT_GRACE_MS = 1000;

/**
 * @param {{
 *   onShutdown?: ((signal: string) => any) | Array<(signal: string) => any>,
 *   timeoutMs?: number,
 *   signals?: string[],
 *   proc?: { on: Function, removeListener: Function, exit: (code: number) => void },
 *   log?: (message: string) => void,
 *   now?: () => number,
 * }} [options]
 * @returns {{
 *   register: (fn: (signal: string) => any) => () => void,
 *   shutdown: (signal?: string) => Promise<void>,
 *   uninstall: () => void,
 *   isShuttingDown: () => boolean,
 * }}
 */
function installShutdownHandlers(options = {}) {
  const proc = options.proc || process;
  const signals = options.signals || ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const log = options.log || (message => console.error(message));
  const now = options.now || Date.now;

  const cleanups = [];
  if (options.onShutdown) cleanups.push(...[].concat(options.onShutdown));

  let started = false;
  let firstSignal = null;
  let firstAt = 0;
  let exited = false;
  let timer = null;
  let finished = Promise.resolve();

  function finish(code) {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    proc.exit(code);
  }

  async function runCleanups(signal) {
    for (const fn of [...cleanups].reverse()) {
      try {
        await fn(signal);
      } catch (err) {
        log(`shutdown: a cleanup failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  function shutdown(signal = 'SIGTERM') {
    const code = SIGNAL_EXIT_CODES[signal] || 1;

    if (started) {
      // The same Ctrl-C delivered twice (terminal + the dispatcher's forward): the
      // cleanups are already running, let them.
      if (signal === firstSignal && now() - firstAt < REPEAT_GRACE_MS) return finished;
      log(`shutdown: ${signal} received again, exiting now`);
      finish(code);
      return finished;
    }
    started = true;
    firstSignal = signal;
    firstAt = now();

    log(`shutdown: ${signal} received, cleaning up (send it again to quit immediately)`);
    timer = setTimeout(() => {
      log(`shutdown: cleanup timed out after ${timeoutMs}ms, exiting`);
      finish(code);
    }, timeoutMs);
    finished = runCleanups(signal).then(() => finish(code), () => finish(code));
    return finished;
  }

  const listeners = signals.map(signal => [signal, () => { shutdown(signal); }]);
  for (const [signal, listener] of listeners) proc.on(signal, listener);

  return {
    register(fn) {
      cleanups.push(fn);
      return () => {
        const at = cleanups.indexOf(fn);
        if (at !== -1) cleanups.splice(at, 1);
      };
    },
    shutdown,
    uninstall() {
      for (const [signal, listener] of listeners) proc.removeListener(signal, listener);
    },
    isShuttingDown: () => started,
  };
}

module.exports = { installShutdownHandlers, SIGNAL_EXIT_CODES, DEFAULT_TIMEOUT_MS, REPEAT_GRACE_MS };
