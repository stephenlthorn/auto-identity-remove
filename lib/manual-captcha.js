/**
 * lib/manual-captcha.js
 *
 * Let a person at the keyboard solve a CAPTCHA (issue #16, roadmap R1).
 *
 * Without a CapSolver key, a CAPTCHA broker used to end as `captcha_failed` the
 * moment the form was filled, so the browser moved on before anyone could do
 * anything. handleCaptcha() now:
 *
 *   1. leaves a page with no CAPTCHA alone              -> 'none'
 *   2. tries the paid solver first when a key is usable -> 'solved' or falls through
 *   3. otherwise, when a person can be asked (`manual`), brings the window to the
 *      front, announces the wait, and polls until the widget reports a token or
 *      the challenge goes away                          -> 'solved' | 'timeout'
 *   4. otherwise                                        -> 'failed' | 'skipped'
 *
 * Anything but 'none' / 'solved' means "do not submit": the caller records
 * `captcha_failed` and points at `aidr captchas`, which re-runs only those brokers
 * headed with manual solving on.
 *
 * Time and sleeping are injectable (`now`, `sleep`) so a 3-minute wait is a
 * millisecond test, and the poll count is bounded as well as the clock, so a
 * stuck clock cannot hang a run.
 */

'use strict';

const {
  isPlaceholderKey,
  detectAndSolveCaptcha,
  detectCaptchaType,
  detectUnsupportedChallenge,
  SOLVER_TYPES,
} = require('./captcha');

const DEFAULT_MANUAL_TIMEOUT_SEC = 180;
const MAX_MANUAL_TIMEOUT_SEC = 3600;
const POLL_MS = 1000;
// A widget must be gone on this many polls in a row before "the challenge went
// away" counts: a page that is mid-navigation briefly shows no widget at all.
const GONE_POLLS_REQUIRED = 2;
const RETRY_COMMAND = 'aidr captchas';

// One look at the page may take at most this long (BRK2-4). page.evaluate has no
// timeout of its own: a page stuck in a busy loop or a crashed renderer never
// answers, and an unanswered read used to hold the whole run (and its lock) forever.
const READ_CAP_MS = 5000;
// Beyond the person's own time, how long the solver and the page probes may take in
// total before the page is declared unusable and closed.
const HARD_TIMEOUT_GRACE_MS = 300000;
// How long closing an unusable page may take before it is abandoned.
const CLOSE_CAP_MS = 5000;

const realSleep = ms => new Promise(r => setTimeout(r, ms));

const TIMED_OUT = Symbol('timed out');

/**
 * `promise`'s value, or TIMED_OUT once `ms` of REAL time have passed. The promise is
 * not cancelled (a hung page.evaluate cannot be), it is just no longer waited for.
 */
function withDeadline(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// ─── Deciding whether a person may be asked ──────────────────────────────────

function manualSetting(config) {
  const raw = config && config.captcha && config.captcha.manual;
  if (raw === true || raw === false) return raw;
  const word = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (word === 'true') return true;
  if (word === 'false') return false;
  // "auto", missing, or something we do not recognise: a typo must not silently
  // turn the feature off (which is the bug in issue #16) or on (a hung run).
  return 'auto';
}

/**
 * Whether a person may be asked to solve a CAPTCHA this run. Decided once, by the
 * caller, and handed to handleCaptcha as `manual`.
 *
 *   headless                  never: nobody can see the window, and waiting would
 *                             only stall the run
 *   force (--solve-captchas)  yes, when headed
 *   captcha.manual true       yes, when headed (a desktop notification still
 *                             reaches a person without a terminal)
 *   captcha.manual false      no
 *   captcha.manual "auto"     yes when someone is at an interactive terminal
 *
 * `hasSolverKey` does not change the answer: a usable key does not switch manual
 * off, because handleCaptcha tries the solver first and only waits for a person
 * after it fails ("no usable key OR the solver failed"). It is accepted so callers
 * can state what they know.
 *
 * @param {{ config?: object|null, headless?: boolean, isTTY?: boolean, hasSolverKey?: boolean, force?: boolean }} [opts]
 * @returns {boolean}
 */
function resolveManualMode({ config, headless, isTTY, force } = {}) {
  if (headless) return false;
  if (force === true) return true;
  const setting = manualSetting(config);
  if (setting === true) return true;
  if (setting === false) return false;
  return Boolean(isTTY);
}

/**
 * Seconds a person gets per CAPTCHA: `captcha.manualTimeoutSec`, default 180,
 * clamped to 1..3600 so a typo cannot park a run for a day.
 *
 * @param {object|null} [config]
 * @returns {number}
 */
function manualTimeoutSec(config) {
  const given = config && config.captcha && config.captcha.manualTimeoutSec;
  // A number or a numeric string. Number(true) is 1: a flag typed where seconds
  // belong must not become a one-second wait.
  const raw = typeof given === 'number' || typeof given === 'string' ? Number(given) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MANUAL_TIMEOUT_SEC;
  return Math.min(Math.max(1, Math.round(raw)), MAX_MANUAL_TIMEOUT_SEC);
}

const MANUAL_WORDS = new Set(['auto', 'true', 'false']);
const shown = value => {
  let text;
  try { text = JSON.stringify(value); } catch (_) { text = String(value); }
  return text === undefined ? String(value) : text.slice(0, 40);
};

/**
 * What is wrong with the `captcha` section, as warnings. Nothing here stops a run:
 * manualSetting() reads an unknown captcha.manual as "auto" and manualTimeoutSec()
 * falls back to the default, so a typo does not fail, it quietly does something
 * else. Each line says what is used instead. Shared by `aidr config check` and the
 * start of a run.
 *
 * @param {object|null} [config]
 * @returns {string[]}
 */
function captchaConfigWarnings(config) {
  const section = config && config.captcha;
  if (section === undefined || section === null) return [];
  if (typeof section !== 'object' || Array.isArray(section)) {
    return ['captcha must be an object like { "manual": "auto", "manualTimeoutSec": 180 }; it is ignored'];
  }
  const warnings = [];

  const manual = section.manual;
  if (manual !== undefined && manual !== null && manual !== true && manual !== false) {
    const word = typeof manual === 'string' ? manual.trim().toLowerCase() : '';
    if (!MANUAL_WORDS.has(word)) {
      warnings.push(`captcha.manual must be "auto", true or false (got ${shown(manual)}); it is treated as "auto"`);
    }
  }

  const seconds = section.manualTimeoutSec;
  if (seconds !== undefined && seconds !== null && seconds !== '') {
    const n = typeof seconds === 'number' || typeof seconds === 'string' ? Number(seconds) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`captcha.manualTimeoutSec must be a number of seconds above 0 (got ${shown(seconds)}); the default of ${DEFAULT_MANUAL_TIMEOUT_SEC} is used`);
    } else if (n > MAX_MANUAL_TIMEOUT_SEC) {
      warnings.push(`captcha.manualTimeoutSec ${shown(seconds)} is above the limit; ${MAX_MANUAL_TIMEOUT_SEC} seconds is used`);
    }
  }
  return warnings;
}

// ─── Reading the page ────────────────────────────────────────────────────────

/**
 * Page-side: what the page says about a CAPTCHA right now. Runs INSIDE the page
 * (page.evaluate serializes it), so it must stay self-contained: no closure
 * variables, no requires. It is a named function so a test can run it against a
 * fake `document`.
 *
 *   ready      the document finished loading
 *   token      a reCAPTCHA / hCaptcha / Turnstile response field holds a value
 *   frame      a DataDome or Arkose challenge frame is on screen
 *   humanText  the page asks the visitor to prove they are human
 *
 * @returns {{ ready: boolean, token: boolean, frame: boolean, humanText: boolean }}
 */
function readCaptchaState() {
  var filled = function (selector) {
    var fields = document.querySelectorAll(selector);
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].value && String(fields[i].value).trim()) return true;
    }
    return false;
  };
  var text = (document.body && document.body.innerText) || '';
  return {
    ready: document.readyState === 'complete',
    token: filled('textarea[name="g-recaptcha-response"]') ||
           filled('textarea[name="h-captcha-response"]') ||
           filled('input[name="cf-turnstile-response"]'),
    frame: !!document.querySelector(
      'iframe[src*="captcha-delivery.com"],iframe[src*="arkoselabs.com"],iframe[src*="funcaptcha"]'
    ),
    humanText: /verify (that )?you(?:'|’)?(?:re| are) (a )?human|are you a robot|(?:not|n't) a robot|prove (?:that )?you(?:'|’)?(?:re| are) (?:a )?human/i.test(text),
  };
}

/**
 * Page-side: does the page still hold something to fill in? A CAPTCHA that is gone
 * from a page with no form on it (a 502, a thank-you page) was not solved, the page
 * was replaced. The CAPTCHA widget's own response field does not count. Runs INSIDE
 * the page, so it stays self-contained.
 *
 * @returns {{ controls: number }}
 */
function readPageShape() {
  var controls = document.querySelectorAll(
    'form, input:not([type="hidden"]), select, textarea:not([name$="-response"])'
  );
  return { controls: controls.length };
}

function isUsableState(state) {
  return !!state && typeof state === 'object' && !Array.isArray(state) && typeof state.ready === 'boolean';
}

/** The page's CAPTCHA state, or null when it cannot answer (mid-navigation, closed, a minimal stub). */
async function readState(page) {
  try {
    const state = await page.evaluate(readCaptchaState);
    return isUsableState(state) ? state : null;
  } catch (_) {
    return null;
  }
}

/** The page shape, or null when the page cannot say (mid-navigation, closed, a minimal stub). */
async function readShape(page) {
  try {
    const shape = await page.evaluate(readPageShape);
    return shape && typeof shape === 'object' && Number.isInteger(shape.controls) ? shape : null;
  } catch (_) {
    return null;
  }
}

function pageUrlOf(page) {
  try {
    return typeof page.url === 'function' ? page.url() : undefined;
  } catch (_) {
    return undefined;
  }
}

function pageIsClosed(page) {
  try {
    return typeof page.isClosed === 'function' && page.isClosed() === true;
  } catch (_) {
    return false;
  }
}

/**
 * What the page is showing: a solver-supported type, a detect-only challenge, a
 * plain "verify you are human" page, or null for no CAPTCHA at all.
 */
async function detectKind(page, state) {
  const type = await detectCaptchaType(page);
  if (type) return type;
  const unsupported = await detectUnsupportedChallenge(page);
  if (unsupported) return unsupported;
  return state.humanText ? 'challenge-text' : null;
}

// Can a person do something about it right now? Invisible reCAPTCHA v3 has
// nothing to click, and a DataDome/PerimeterX/Akamai script with no challenge
// frame on screen is only a bot manager watching the page.
function personCanSolve(kind, state) {
  if (kind === 'recaptcha-v3') return false;
  if (kind === 'perimeterx' || kind === 'akamai') return false;
  if (kind === 'datadome' || kind === 'arkose') return state.frame === true;
  return true;
}

function hasUsableKey(capsolver) {
  const key = capsolver && capsolver.apiKey;
  return Boolean(key) && !isPlaceholderKey(key);
}

async function safely(fn) {
  try {
    await fn();
  } catch (_) {
    // A broken notifier or a window manager without bringToFront must not end the wait.
  }
}

// ─── Waiting for a person ────────────────────────────────────────────────────

async function stillShowingChallenge(page, state) {
  let type;
  try {
    type = await detectCaptchaType(page);
  } catch (_) {
    return true; // could not tell: assume it is still there
  }
  return Boolean(type) || state.frame === true || state.humanText === true;
}

/**
 * The widget went away without a token. For a page that holds a form, solved only
 * when it is still the page we were on and still holds a form (an interstitial that
 * passed the visitor through, a widget that collapses once verified). A different
 * URL, or a page with nothing left to fill in, was REPLACED (a 502, a thank-you page,
 * a redirect): 'navigated' (BRK2-5). A page that cannot be read keeps the old answer,
 * solved.
 */
async function widgetGoneVerdict(page, startUrl, hadForm) {
  // A page that never had anything to fill in (a full-page "verify you are human"
  // interstitial) has no form to lose: when its challenge goes away the visitor was
  // let through, wherever that leads.
  if (hadForm === false) return 'solved';
  const url = pageUrlOf(page);
  if (startUrl && url && url !== startUrl) return 'navigated';
  const shape = await withDeadline(readShape(page), READ_CAP_MS);
  if (shape && shape !== TIMED_OUT && shape.controls === 0) return 'navigated';
  return 'solved';
}

async function waitForPerson(page, { broker, onWaiting, timeoutMs, now, sleep, pollMs }) {
  await safely(() => typeof page.bringToFront === 'function' && page.bringToFront());
  await safely(() => typeof onWaiting === 'function' && onWaiting({ broker, timeoutSec: Math.round(timeoutMs / 1000) }));

  const startUrl = pageUrlOf(page);
  const startShape = await withDeadline(readShape(page), Math.min(READ_CAP_MS, timeoutMs));
  const hadForm = startShape && startShape !== TIMED_OUT ? startShape.controls > 0 : undefined;
  const deadline = now() + timeoutMs;
  const maxPolls = Math.ceil(timeoutMs / pollMs) + 2;
  let goneInARow = 0;
  // The read in flight. While a page does not answer, the same read is waited for
  // again instead of queueing another behind it (BRK2-4).
  let reading = null;

  for (let poll = 0; poll < maxPolls; poll++) {
    if (pageIsClosed(page)) return 'failed';

    if (!reading) {
      reading = readState(page).finally(() => { reading = null; });
    }
    const left = Math.max(0, deadline - now());
    const answered = await withDeadline(reading, Math.min(READ_CAP_MS, left));
    const state = answered === TIMED_OUT ? null : answered;
    if (state) {
      if (state.token) return 'solved';
      const stillThere = await withDeadline(stillShowingChallenge(page, state), Math.min(READ_CAP_MS, Math.max(0, deadline - now())));
      // A page that will not say whether the challenge is still there is not gone.
      const gone = state.ready && stillThere !== TIMED_OUT && !stillThere;
      goneInARow = gone ? goneInARow + 1 : 0;
      if (goneInARow >= GONE_POLLS_REQUIRED) return widgetGoneVerdict(page, startUrl, hadForm);
    }

    if (now() >= deadline) return 'timeout';
    await sleep(pollMs);
  }
  return 'timeout';
}

/**
 * Deal with a CAPTCHA on the page the caller is about to submit.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {{ apiKey?: string }|null} [opts.capsolver] solver config; a missing or placeholder key means no solver
 * @param {boolean} [opts.manual] a person may be asked (resolveManualMode)
 * @param {{ name?: string, recaptchaV3Action?: string }} [opts.broker]
 * @param {(info: { broker: object, timeoutSec: number }) => void} [opts.onWaiting] called once before the wait
 * @param {number} [opts.timeoutMs] how long a person gets (default 180000)
 * @param {() => number} [opts.now] clock, for tests
 * @param {(ms: number) => Promise<void>} [opts.sleep] sleeper, for tests
 * @param {number} [opts.pollMs] poll interval (default 1000)
 * @param {(page: object, capsolver: object|null, broker: object) => Promise<boolean>} [opts.solve]
 *   the solver, default detectAndSolveCaptcha; the broker runner passes its own import
 * @param {number} [opts.hardTimeoutMs] ceiling for the whole handling, solver included
 *   (default timeoutMs + 5 min). A page that never answers is closed and reported
 *   as 'timeout' instead of holding the run.
 * @returns {Promise<'none'|'solved'|'failed'|'timeout'|'skipped'|'navigated'>}
 *   none       no CAPTCHA on the page
 *   solved     the solver or a person got through; submit
 *   failed     the solver failed (or the window was closed) and nobody could take over
 *   timeout    a person was asked and the time ran out (or the page stopped answering)
 *   skipped    a CAPTCHA is there but neither a solver nor a person applies
 *   navigated  the CAPTCHA went away because the page was replaced, not because it
 *              was solved: the caller must look at what is there now before it
 *              submits anything
 */
async function handleCaptcha(page, opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_MANUAL_TIMEOUT_SEC * 1000 : opts.timeoutMs;
  const hardMs = typeof opts.hardTimeoutMs === 'number' ? opts.hardTimeoutMs : timeoutMs + HARD_TIMEOUT_GRACE_MS;
  const result = await withDeadline(handleCaptchaOnce(page, opts), hardMs);
  if (result !== TIMED_OUT) return result;
  // Nothing answered in time: the page is not usable for anything else either.
  await safely(() => withDeadline(Promise.resolve(page.close({ runBeforeUnload: false })), CLOSE_CAP_MS));
  return 'timeout';
}

async function handleCaptchaOnce(page, opts) {
  const {
    capsolver = null,
    manual = false,
    broker,
    onWaiting,
    timeoutMs = DEFAULT_MANUAL_TIMEOUT_SEC * 1000,
    now = Date.now,
    sleep = realSleep,
    pollMs = POLL_MS,
    solve = detectAndSolveCaptcha,
  } = opts;

  const state = await readState(page);
  if (!state) {
    // A page that cannot answer (a minimal stub, a page that is not ready to be
    // read) cannot be waited on either: keep the solver-only behaviour of old.
    return (await solve(page, capsolver, broker)) ? 'solved' : 'failed';
  }

  const kind = await detectKind(page, state);
  if (!kind) return 'none';

  let solverTried = false;
  if (hasUsableKey(capsolver) && SOLVER_TYPES.has(kind)) {
    solverTried = true;
    let solved = false;
    try {
      solved = await solve(page, capsolver, broker);
    } catch (_) {
      // A solver that throws (a page that closed mid-solve) is a failed solver;
      // a person can still take over.
    }
    if (solved) return 'solved';
  }

  if (manual && personCanSolve(kind, state)) {
    return waitForPerson(page, { broker, onWaiting, timeoutMs, now, sleep, pollMs });
  }
  return solverTried ? 'failed' : 'skipped';
}

// ─── What the operator sees ──────────────────────────────────────────────────

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return `${DEFAULT_MANUAL_TIMEOUT_SEC / 60} min`;
  return n % 60 === 0 ? `${n / 60} min` : `${Math.round(n)}s`;
}

/**
 * The `detail` for a broker that ended on a CAPTCHA nobody solved: why, and how to
 * retry. It starts with the opt-out URL because the watcher opens manual URLs from
 * the start of the detail at the end of a run (and `aidr captchas` finds these rows
 * by status, or by the word CAPTCHA on a `manual` row).
 *
 * @param {{ outcome: 'timeout'|'failed'|'skipped'|'navigated', url?: string, timeoutSec?: number, headless?: boolean, isTTY?: boolean, config?: object|null, noSolver?: boolean }} info
 *   `noSolver`: the run was started with --no-capsolver
 * @returns {string}
 */
function captchaFailureDetail({ outcome, url, timeoutSec, headless, isTTY, config, noSolver } = {}) {
  const lead = url ? `${url} - ` : '';
  const retry = `retry with: ${RETRY_COMMAND}`;
  if (outcome === 'timeout') {
    return `${lead}CAPTCHA not solved within ${formatDuration(timeoutSec)}; ${retry}`;
  }
  if (outcome === 'failed') {
    return `${lead}CAPTCHA could not be solved (the solver failed or the window was closed); ${retry}`;
  }
  if (outcome === 'navigated') {
    return `${lead}the page was replaced while the CAPTCHA was open and nothing confirmed a submission; ${retry}`;
  }
  if (headless) {
    return `${lead}CAPTCHA needs a person at a screen and this run has no display; run ${RETRY_COMMAND} on a desktop machine`;
  }
  if (noSolver) {
    return `${lead}CAPTCHA not attempted: the solver is off (--no-capsolver); ${retry}`;
  }
  if (manualSetting(config) === false) {
    return `${lead}CAPTCHA not attempted: no solver is available and captcha.manual is false; ${retry}`;
  }
  if (isTTY === false) {
    return `${lead}CAPTCHA needs a person and this run has no interactive terminal; ${retry} from a terminal`;
  }
  return `${lead}CAPTCHA not solved: no solver is available; ${retry}`;
}

function defaultBell() {
  // A BEL in a piped log is just a stray control character.
  if (process.stdout.isTTY) process.stdout.write('\x07');
}

/**
 * Tell the person a CAPTCHA is waiting: a clear terminal line, the bell, and a
 * desktop notification. Only the broker name is shown; never anything about the
 * person. Best effort: a notifier that throws never breaks the wait.
 *
 * @param {{ broker: { name?: string }, timeoutSec: number }} info
 * @param {{ log?: (line: string) => void, bell?: () => void, notify?: (title: string, message: string) => void }} [deps]
 */
function announceCaptchaWait({ broker, timeoutSec }, deps = {}) {
  const { log = console.log, bell = defaultBell } = deps;
  const notify = deps.notify || (() => {});
  const name = (broker && broker.name) || 'a broker';
  const wait = formatDuration(timeoutSec);
  log(`     ✋ CAPTCHA on ${name} - solve it in the browser window (waiting up to ${wait}). The form is submitted for you afterwards; Ctrl+C stops the run.`);
  try { bell(); } catch (_) {}
  try { notify('Privacy Watcher', `${name} needs a CAPTCHA solved - the browser window is waiting (${wait})`); } catch (_) {}
}

// ─── Re-running only what a person still has to do ───────────────────────────

function nameOf(entry) {
  return entry && (entry.broker || entry.name);
}

function endedOnCaptcha(status, detail) {
  if (status === 'captcha_failed') return true;
  return status === 'manual' && /captcha/i.test(String(detail || ''));
}

/**
 * The brokers `aidr captchas` should re-run: those that ended `captcha_failed`, or
 * `manual` with a CAPTCHA in the detail, in a run log. Accepts the end-of-run
 * summary (buckets of entries) or the journal (a flat list of entries, where a
 * later entry for the same broker and person wins, so a broker that was retried
 * and succeeded in the same run is not re-run).
 *
 * @param {object|Array<object>|null|undefined} source
 * @returns {Set<string>} broker names, usable as makeBrokerPredicate's `retryFailedFromLog`
 */
function captchaBrokersFromLog(source) {
  const names = new Set();
  if (!source) return names;

  if (Array.isArray(source)) {
    const last = new Map();
    for (const entry of source) {
      const name = nameOf(entry);
      if (!name) continue;
      last.set(`${name}|${entry.person || ''}`, { name, hit: endedOnCaptcha(entry.status, entry.detail) });
    }
    for (const { name, hit } of last.values()) if (hit) names.add(name);
    return names;
  }

  for (const entry of source.captchaFailed || []) {
    const name = nameOf(entry);
    if (name) names.add(name);
  }
  for (const entry of source.manual || []) {
    const name = nameOf(entry);
    if (name && endedOnCaptcha('manual', entry.detail)) names.add(name);
  }
  return names;
}

module.exports = {
  resolveManualMode,
  manualTimeoutSec,
  captchaConfigWarnings,
  handleCaptcha,
  captchaFailureDetail,
  announceCaptchaWait,
  captchaBrokersFromLog,
  readCaptchaState,
  readPageShape,
  RETRY_COMMAND,
  DEFAULT_MANUAL_TIMEOUT_SEC,
};
