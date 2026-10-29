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

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkdirPrivate, writePrivateFile } = require('./private-fs');

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

// ── Per-person profiles ──────────────────────────────────────────────────────
//
// Cookies, localStorage and cached logins live in the Chromium user-data
// directory. One shared directory carries everything a broker learned about
// person A into person B's removal run (a "welcome back, Jane" session, a
// remembered search), so each person gets their own.
//
// Layout, with <base> = config.profileDir:
//
//   <base>/person-<index>-<hash>   persons[index]; hash = first 10 hex chars of
//                                  a sha256 over the identity fields below
//   <base>/utility                 report/PDF rendering and confirm links
//   <base> itself                  legacy profile of an existing install
//
// The hash is the same identity as the state fingerprint (normalised name, zip,
// email, phone digits), so a person who is replaced at an index, or whose
// details change, starts with a clean browser exactly as they start with a
// clean state entry. The directory name is a hash on purpose: the person's name
// never appears in a path (paths end up in logs, backups and error messages).
//
// Legacy rule: before this change every run used <base> directly, so it already
// holds person 0's logins. Person 0 keeps using <base> when (1) it holds a
// Chromium profile and (2) no per-person directory exists for them. The first
// such use writes <base>/.aidr-profile-owner (0600) with their hash; from then
// on only that identity may use <base>. Without the marker, putting a different
// person first in config.persons would hand them the previous person's cookies.
const DIR_HASH_LENGTH = 10;
const OWNER_MARKER = '.aidr-profile-owner';
const UTILITY_DIR = 'utility';

const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const _digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function identityHash(person) {
  const p = person || {};
  const input = [
    _norm(`${p.firstName || ''} ${p.lastName || ''}`),
    _norm(p.zip).replace(/ /g, ''),
    _norm(p.email),
    _digits(p.phone || p.phoneFormatted),
  ].join('\n');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, DIR_HASH_LENGTH);
}

// `Local State` and `Default/` are what Chromium itself writes at the top of a
// user-data directory. A base that only holds config, state or an empty folder
// is not a profile worth inheriting.
function holdsChromiumProfile(dir, impl) {
  return impl.existsSync(path.join(dir, 'Local State')) || impl.existsSync(path.join(dir, 'Default'));
}

/**
 * May `hash` use the legacy base profile? True for the recorded owner, and for
 * the first claimant when nobody has claimed it yet (an install from before
 * this change). An unreadable marker is not a claim: refusing is the safe side.
 */
function claimLegacyProfile(base, hash, impl) {
  const marker = path.join(base, OWNER_MARKER);
  let owner;
  try {
    owner = impl.readFileSync(marker, 'utf8').trim();
  } catch (err) {
    if (err && err.code !== 'ENOENT') return false;
  }
  if (owner !== undefined) return owner === hash;
  try {
    writePrivateFile(marker, `${hash}\n`, { fs: impl });
  } catch (_) {
    // Read-only mount: the launch still works, the claim is just not recorded.
  }
  return true;
}

/**
 * The persistent-context directory for persons[personIndex], created 0700.
 * See the layout and legacy rule above.
 *
 * @param {{ baseDir: string, person?: object, personIndex?: number, fs?: object }} opts
 * @returns {string}
 */
function profileDirFor({ baseDir, person, personIndex = 0, fs: impl = fs } = {}) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) throw new TypeError('profileDirFor: baseDir is required');
  if (!Number.isInteger(personIndex) || personIndex < 0) {
    throw new TypeError('profileDirFor: personIndex must be a non-negative integer');
  }
  const base = expandHome(baseDir);
  const hash = identityHash(person);
  const dir = path.join(base, `person-${personIndex}-${hash}`);
  const legacyEligible = personIndex === 0 && !impl.existsSync(dir) && holdsChromiumProfile(base, impl);
  if (legacyEligible && claimLegacyProfile(base, hash, impl)) return base;
  return mkdirPrivate(dir, { fs: impl });
}

/**
 * A profile for launches that belong to no person: rendering the report and
 * complaint PDFs from local HTML, and visiting confirmation links. Keeping them
 * out of every person's directory means they cannot leave cookies in one, and
 * cannot make <base> look like a legacy profile.
 *
 * @param {string} baseDir
 * @returns {string}
 */
function utilityProfileDir(baseDir) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) throw new TypeError('utilityProfileDir: baseDir is required');
  return mkdirPrivate(path.join(expandHome(baseDir), UTILITY_DIR));
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
  profileDirFor,
  utilityProfileDir,
  buildLaunchArgs,
  buildLaunchOptions,
  resolveHeadless,
  isLowMemory,
  BASE_ARGS,
  LINUX_ARGS,
  LOW_MEMORY_ARGS,
  VIEWPORT,
};
