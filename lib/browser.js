/**
 * lib/browser.js - one place that decides how Chromium is launched.
 *
 * watcher.js launches a browser from four separate places (main opt-out run,
 * complaint-PDF rendering, --confirm-emails, HTML/PDF report rendering). Only
 * the main run used to pass any args, so the other three ran without the
 * anti-automation flags and without the container hardening below.
 *
 * The container flags matter more than they look. Docker gives a container 64MB
 * of /dev/shm. Chromium keeps renderer shared memory there and its tabs die
 * ("Target closed", SIGBUS) once it is exhausted, which on a small NAS shows up
 * as random per-broker failures rather than an obvious crash.
 * --disable-dev-shm-usage moves that allocation to /tmp, so a plain
 * `docker run` with no --shm-size works. docker-compose.yml additionally raises
 * shm_size, which is the faster of the two remedies when it is available.
 */

// Applied everywhere: strips the two most obvious automation tells. Broker
// sites fingerprint on these, so they are not optional.
const BASE_ARGS = [
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];

// Linux-only. macOS/Windows have no 64MB /dev/shm to work around and the flag
// costs page-load performance there.
const LINUX_ARGS = [
  '--disable-dev-shm-usage',
];

// Opt-in via AIDR_LOW_MEMORY=1 or opts.lowMemory. Trades render fidelity for
// resident memory on boxes with ~2GB of RAM (Synology DS720+, Raspberry Pi,
// small VPS). Every flag here is verified to still launch and load a page:
// notably absent is --single-process, which Playwright does not support.
const LOW_MEMORY_ARGS = [
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--no-zygote',
];

const VIEWPORT = { width: 1280, height: 900 };

/**
 * Decide headless vs headed.
 *
 * Explicit HEADLESS wins. Otherwise headless when we look like a Linux box with
 * no X display, which is the container and NAS case.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [platform]
 * @returns {boolean}
 */
function resolveHeadless(env = process.env, platform = process.platform) {
  const v = env.HEADLESS;
  if (v !== undefined) {
    const s = String(v).toLowerCase();
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
  }
  return platform === 'linux' && !env.DISPLAY;
}

/**
 * @param {{ platform?: string, lowMemory?: boolean, env?: Record<string,string|undefined>, extraArgs?: string[] }} [opts]
 * @returns {string[]} a fresh array, safe for the caller to mutate
 */
function buildLaunchArgs(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const lowMemory = opts.lowMemory !== undefined
    ? !!opts.lowMemory
    : env.AIDR_LOW_MEMORY === '1' || env.AIDR_LOW_MEMORY === 'true';

  const args = [...BASE_ARGS];
  if (platform === 'linux') args.push(...LINUX_ARGS);
  if (lowMemory) {
    for (const flag of LOW_MEMORY_ARGS) {
      if (!args.includes(flag)) args.push(flag);
    }
  }
  for (const flag of opts.extraArgs || []) {
    if (!args.includes(flag)) args.push(flag);
  }
  return args;
}

/**
 * Full options object for chromium.launchPersistentContext().
 *
 * @param {{ headless?: boolean, platform?: string, lowMemory?: boolean, env?: object, extraArgs?: string[], viewport?: object }} [opts]
 */
function buildLaunchOptions(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  return {
    headless: opts.headless !== undefined ? !!opts.headless : resolveHeadless(env, platform),
    viewport: opts.viewport || { ...VIEWPORT },
    args: buildLaunchArgs({ platform, lowMemory: opts.lowMemory, env, extraArgs: opts.extraArgs }),
    ignoreDefaultArgs: ['--enable-automation'],
  };
}

// Dialog types that are safe to accept during an opt-out. prompt() is left out:
// the runner has nothing sensible to type, and dismissing it is the safe answer.
const ACCEPTED_DIALOG_TYPES = new Set(['confirm', 'alert', 'beforeunload']);

/**
 * Accept confirm()/alert()/beforeunload dialogs on `page`, log that it did, and
 * dismiss prompt().
 *
 * Playwright auto-DISMISSES every dialog when no listener is attached. An
 * "Are you sure you want to opt out?" confirm() therefore resolves to false and
 * the opt-out silently aborts while the runner goes on to read the page. Call
 * this on pages that drive an opt-out flow only.
 *
 * The dialog text is never logged: a confirm often repeats the user's name or
 * address ("Remove Jane Doe at 12 Elm St?").
 *
 * @param {import('playwright').Page} page
 * @param {{ log?: (line: string) => void }} [opts]
 */
function acceptOptOutDialogs(page, opts = {}) {
  if (!page || typeof page.on !== 'function') return;
  const log = opts.log || ((line) => console.log(line));
  page.on('dialog', async (dialog) => {
    try {
      const type = dialog.type();
      if (ACCEPTED_DIALOG_TYPES.has(type)) {
        await dialog.accept();
        log(`     dialog accepted (${type})`);
      } else {
        await dialog.dismiss();
        log(`     dialog dismissed (${type})`);
      }
    } catch (_) {
      // Already handled elsewhere or the page closed mid-dialog: nothing to do.
    }
  });
}

/** True when the low-memory profile is active, for logging. */
function isLowMemory(env = process.env) {
  return env.AIDR_LOW_MEMORY === '1' || env.AIDR_LOW_MEMORY === 'true';
}

module.exports = {
  acceptOptOutDialogs,
  buildLaunchArgs,
  buildLaunchOptions,
  resolveHeadless,
  isLowMemory,
  BASE_ARGS,
  LINUX_ARGS,
  LOW_MEMORY_ARGS,
  VIEWPORT,
};
