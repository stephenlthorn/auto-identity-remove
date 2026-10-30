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
const { execFileSync } = require('child_process');
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

// With a proxy configured: WebRTC may only use the proxied route (BRK2 review).
const WEBRTC_PROXY_GUARD = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

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

// ── Headless user agent ──────────────────────────────────────────────────────
//
// Headless Chromium sends "HeadlessChrome/<ver>" in its user agent, a one-token
// bot check for any broker behind a WAF. When we launch headless and the user
// has not configured a user agent, we send the regular Chrome string for the
// SAME major version and platform. The same major matters as much as the
// missing word: the Sec-CH-UA header still comes from the real browser, and a
// UA that disagrees with it is a better tell than the one we removed.
//
// Chrome's own "reduced" UA freezes everything but the major version, which is
// why the result is Chrome/<major>.0.0.0 and a frozen macOS token.
//
// Client hints: Playwright's `userAgent` option keeps navigator.userAgentData
// and Sec-CH-UA intact (verified on Chrome 156 new headless: brands stay
// "Chromium" and "Google Chrome", only the UA string changes). The old headless
// shell is the one build that is documented to put a "HeadlessChrome" brand
// there. extraHTTPHeaders CAN override Sec-CH-UA, but the right value (the
// per-version GREASE brand and its ordering) cannot be derived before launch,
// so we do not forge the header. lib/stealth.js renames a HeadlessChrome brand
// on the JavaScript side, using the browser's own list so the rest stays real.
const PLATFORM_TOKENS = {
  darwin: () => 'Macintosh; Intel Mac OS X 10_15_7',
  win32: () => 'Windows NT 10.0; Win64; x64',
  linux: (arch) => (arch === 'arm64' || arch === 'arm' ? 'X11; Linux aarch64' : 'X11; Linux x86_64'),
};

function majorVersionOf(version) {
  const text = String(version == null ? '' : version);
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(text) || /^\s*(\d+)\s*$/.exec(text) || /(?:Chrome|Chromium)[/ ](\d+)/i.exec(text);
  return match ? match[1] : null;
}

/**
 * The regular Chrome user agent for `browserVersion` on `platform`, or null
 * when no version can be read from `browserVersion`.
 *
 * @param {string|number} browserVersion "148.0.7778.96", "148", "HeadlessChrome/148.0.7778.96"
 * @param {{ platform?: string, arch?: string }} [opts]
 * @returns {string|null}
 */
function normalizeUserAgent(browserVersion, opts = {}) {
  const major = majorVersionOf(browserVersion);
  if (!major) return null;
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const token = (PLATFORM_TOKENS[platform] || PLATFORM_TOKENS.linux)(arch);
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const isHeadlessUserAgent = (ua) => typeof ua === 'string' && /HeadlessChrome/i.test(ua);

let bundledVersionCache;

// Playwright launches exactly the Chromium revision it pins (it refuses any
// other), so its browsers.json is the version of the default browser. The file
// is not in playwright-core's `exports`, hence the path join.
function bundledChromiumVersion() {
  if (bundledVersionCache !== undefined) return bundledVersionCache;
  let version = null;
  try {
    const dir = path.dirname(require.resolve('playwright-core/package.json'));
    const { browsers } = JSON.parse(fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8'));
    const entry = browsers.find((b) => b.name === 'chromium-headless-shell') || browsers.find((b) => b.name === 'chromium');
    version = (entry && entry.browserVersion) || null;
  } catch (_) {
    // No playwright-core next to this file (a fallback install): version unknown.
  }
  bundledVersionCache = version;
  return version;
}

// `<exe> --version` prints "Google Chrome 156.0.8078.48" or "HeadlessChrome
// 148.0.7778.96". Windows chrome.exe ignores --version, so it is not asked.
function probeExecutableVersion(executablePath, platform) {
  if (platform === 'win32') return null;
  const out = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const match = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
  return match ? match[1] : null;
}

/**
 * The version of the browser a launch will start, or null when it is unknown.
 * A custom executable is asked directly and NEVER assumed to be the bundled
 * one: a wrong major in the UA is worse than the HeadlessChrome it replaces.
 *
 * @param {{ browserVersion?: string, executablePath?: string, platform?: string, probe?: Function, bundled?: Function }} [opts]
 * @returns {string|null}
 */
function resolveBrowserVersion(opts = {}) {
  const explicit = opts.browserVersion;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return String(explicit).trim();
  if (opts.executablePath) {
    try {
      return (opts.probe || probeExecutableVersion)(opts.executablePath, opts.platform || process.platform) || null;
    } catch (_) {
      return null;
    }
  }
  try {
    return (opts.bundled || bundledChromiumVersion)() || null;
  } catch (_) {
    return null;
  }
}

// ── Proxy and the browser config section ─────────────────────────────────────
//
// config.json:  "browser": { "proxy": { "server", "username", "password", "bypass" }, "userAgent" }
//
// A proxy exists to keep the user's own address away from the brokers, so a
// malformed one must STOP the launch (the failure to fear is a silent direct
// connection). Messages name the field and the rule, never the value: the
// server string can carry credentials and the password is a secret.
const BROWSER_KEYS = new Set(['proxy', 'userAgent']);
const PROXY_KEYS = ['server', 'username', 'password', 'bypass'];
const PROXY_SCHEME = /^(?:https?|socks5):\/\//i;
// Scheme optional: a mistyped "user:pw@host:port" has no scheme and must still be scrubbed.
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i;

const _isSet = (v) => v !== undefined && v !== null;
const _isBlank = (v) => !_isSet(v) || (typeof v === 'string' && v.trim() === '');

function inspectProxy(proxy) {
  if (!_isSet(proxy)) return { problems: [], proxy: null };
  if (typeof proxy !== 'object' || Array.isArray(proxy)) {
    return { problems: ['browser.proxy must be an object with a server (http://, https:// or socks5://) and optional username, password and bypass'], proxy: null };
  }

  const problems = [];
  for (const key of Object.keys(proxy)) {
    if (!key.startsWith('_') && !PROXY_KEYS.includes(key)) problems.push(`unknown browser.proxy key "${key}"`);
  }
  for (const key of PROXY_KEYS) {
    if (_isSet(proxy[key]) && typeof proxy[key] !== 'string') problems.push(`browser.proxy.${key} must be a string`);
  }
  if (problems.length) return { problems, proxy: null };

  if (PROXY_KEYS.every((key) => _isBlank(proxy[key]))) return { problems: [], proxy: null };

  const server = _isBlank(proxy.server) ? '' : proxy.server.trim();
  const username = _isBlank(proxy.username) ? '' : proxy.username.trim();
  const password = _isBlank(proxy.password) ? '' : proxy.password;
  const bypass = _isBlank(proxy.bypass) ? '' : proxy.bypass.trim();

  if (server === '') {
    problems.push('browser.proxy.server is required when other browser.proxy fields are set');
  } else if (!PROXY_SCHEME.test(server)) {
    problems.push('browser.proxy.server must start with http://, https:// or socks5://');
  } else {
    let url = null;
    try { url = new URL(server); } catch (_) { problems.push('browser.proxy.server is not a valid URL'); }
    if (url && (url.username !== '' || url.password !== '')) {
      problems.push('browser.proxy.server must not embed credentials; use the username and password fields instead');
    }
  }
  if (password !== '' && username === '') problems.push('browser.proxy.password is set but browser.proxy.username is not');
  if (/^socks5:/i.test(server) && (username !== '' || password !== '')) {
    problems.push('Chromium does not support SOCKS5 proxy authentication; use an http:// or https:// proxy, or an unauthenticated socks5:// forwarder');
  }
  if (problems.length) return { problems, proxy: null };

  const resolved = { server };
  if (username) resolved.username = username;
  if (password) resolved.password = password;
  if (bypass) resolved.bypass = bypass;
  return { problems: [], proxy: resolved };
}

function configError(problems) {
  const err = new Error(problems.join('; '));
  err.code = 'EBROWSERCONFIG';
  return err;
}

/**
 * Validate `browser.proxy` and return the object Playwright's `proxy` launch
 * option takes, or null when no proxy is configured (absent, or every field
 * blank as in config.example.json). Throws on anything else that is wrong.
 *
 * @param {object|null|undefined} proxy
 * @returns {{ server: string, username?: string, password?: string, bypass?: string }|null}
 */
function resolveProxy(proxy) {
  const { problems, proxy: resolved } = inspectProxy(proxy);
  if (problems.length) throw configError(problems);
  return resolved;
}

/**
 * Everything wrong with the `browser` config section, as strings that are safe
 * to print. For config validation and `aidr doctor`; empty means fine.
 *
 * @param {object|null|undefined} browser
 * @returns {string[]}
 */
function browserConfigProblems(browser) {
  if (!_isSet(browser)) return [];
  if (typeof browser !== 'object' || Array.isArray(browser)) return ['browser must be an object'];
  const problems = [];
  for (const key of Object.keys(browser)) {
    if (!key.startsWith('_') && !BROWSER_KEYS.has(key)) problems.push(`unknown browser key "${key}"`);
  }
  if (_isSet(browser.userAgent) && typeof browser.userAgent !== 'string') problems.push('browser.userAgent must be a string');
  problems.push(...inspectProxy(browser.proxy).problems);
  return problems;
}

/** The server with any credentials removed, for logs. */
const _stripUserinfo = (server) => String(server).trim().replace(USERINFO, '$1');

/**
 * A copy of `proxy` that is safe to log: credentials replaced by "***", any
 * credentials inside the server URL removed. Never throws, so it can describe a
 * config that failed validation. Null when no proxy is configured.
 *
 * @param {object|null|undefined} proxy
 * @returns {{ server: string, username?: string, password?: string, bypass?: string }|null}
 */
function maskProxy(proxy) {
  if (!proxy || typeof proxy !== 'object' || PROXY_KEYS.every((key) => _isBlank(proxy[key]))) return null;
  const masked = { server: typeof proxy.server === 'string' ? _stripUserinfo(proxy.server) : '(invalid)' };
  if (!_isBlank(proxy.username)) masked.username = '***';
  if (!_isBlank(proxy.password)) masked.password = '***';
  if (typeof proxy.bypass === 'string' && proxy.bypass.trim()) masked.bypass = proxy.bypass.trim();
  return masked;
}

/** One log-safe line for the start-of-run banner. */
function describeProxy(proxy) {
  const masked = maskProxy(proxy);
  if (!masked) return 'no proxy';
  return `proxy ${masked.server}${masked.username || masked.password ? ' (authenticated)' : ''}`;
}

/**
 * Remove the proxy's credentials from free text (an error message, a Playwright
 * call log) before it is printed: userinfo in URLs, the password as typed and
 * URL-encoded, and the Basic token a Proxy-Authorization header would carry.
 *
 * @param {string} text
 * @param {object|null|undefined} proxy
 * @returns {string}
 */
function redactProxySecrets(text, proxy) {
  let out = String(text);
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1');
  if (!proxy || typeof proxy.password !== 'string' || proxy.password === '') return out;
  const forms = new Set([proxy.password, encodeURIComponent(proxy.password), encodeURI(proxy.password)]);
  if (typeof proxy.username === 'string' && proxy.username !== '') {
    forms.add(Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64'));
  }
  for (const form of forms) out = out.split(form).join('***');
  return out;
}

/**
 * Scrub the proxy's credentials from a launch error in place: its message AND its
 * stack. The stack text begins with the message, and that is what gets printed when
 * an error escapes, so fixing only `message` left the password in `err.stack`.
 */
function scrubLaunchError(err, proxy) {
  if (!err) return err;
  if (typeof err.message === 'string') err.message = redactProxySecrets(err.message, proxy);
  if (typeof err.stack === 'string') err.stack = redactProxySecrets(err.stack, proxy);
  return err;
}

/**
 * Validate a whole `browser` section and return what the launch needs from it.
 * Throws (EBROWSERCONFIG) when anything is wrong, including a misspelt key: a
 * typo in "proxy" would otherwise silently launch without one.
 */
function resolveBrowserSection(browser) {
  const problems = browserConfigProblems(browser);
  if (problems.length) throw configError(problems);
  const section = browser || {};
  const userAgent = typeof section.userAgent === 'string' && section.userAgent.trim() ? section.userAgent.trim() : undefined;
  return { proxy: resolveProxy(section.proxy), userAgent };
}

/**
 * Full options object for chromium.launchPersistentContext().
 *
 * Beyond the container flags: a headless launch gets a regular Chrome user
 * agent unless one is configured, and `browser.proxy` becomes Playwright's
 * `proxy` option. A malformed `browser` section throws instead of launching
 * without its proxy.
 *
 * @param {{
 *   headless?: boolean, platform?: string, arch?: string, lowMemory?: boolean, env?: object,
 *   extraArgs?: string[], viewport?: object,
 *   browser?: { proxy?: object, userAgent?: string },
 *   proxy?: object, userAgent?: string, browserVersion?: string, executablePath?: string,
 * }} [opts] `browser` is config.browser; `proxy` and `userAgent` win over it.
 */
function buildLaunchOptions(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const section = resolveBrowserSection(opts.browser);
  const headless = opts.headless !== undefined ? !!opts.headless : resolveHeadless(env, platform);

  const proxy = opts.proxy !== undefined ? resolveProxy(opts.proxy) : section.proxy;
  // A proxy exists to keep the user's own address away from the brokers. WebRTC can
  // open UDP sockets that go around it and reveal the real address to the page, so
  // with a proxy configured WebRTC is limited to the proxied route.
  const extraArgs = proxy ? [...(opts.extraArgs || []), WEBRTC_PROXY_GUARD] : opts.extraArgs;

  const launch = {
    headless,
    viewport: opts.viewport || { ...VIEWPORT },
    args: buildLaunchArgs({ platform, lowMemory: opts.lowMemory, env, extraArgs }),
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (opts.executablePath) launch.executablePath = opts.executablePath;
  if (proxy) launch.proxy = proxy;

  const configured = typeof opts.userAgent === 'string' && opts.userAgent.trim() ? opts.userAgent.trim() : section.userAgent;
  const userAgent = configured || (headless
    ? normalizeUserAgent(
      resolveBrowserVersion({ browserVersion: opts.browserVersion, executablePath: opts.executablePath, platform }),
      { platform, arch: opts.arch },
    )
    : null);
  if (userAgent) launch.userAgent = userAgent;
  return launch;
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
 * @param {{ baseDir: string, person?: object, personIndex?: number, personCount?: number, fs?: object }} opts
 *   personCount: how many persons the install has; above 1 the legacy base profile is not adopted
 * @returns {string}
 */
function profileDirFor({ baseDir, person, personIndex = 0, personCount, fs: impl = fs } = {}) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) throw new TypeError('profileDirFor: baseDir is required');
  if (!Number.isInteger(personIndex) || personIndex < 0) {
    throw new TypeError('profileDirFor: personIndex must be a non-negative integer');
  }
  const base = expandHome(baseDir);
  const hash = identityHash(person);
  const dir = path.join(base, `person-${personIndex}-${hash}`);
  // The base profile of an install from before per-person profiles holds EVERY
  // person's cookies when it was shared by several. It is adopted only by a
  // single-person install; with more than one person nobody takes it (BRK2-10).
  const sharedByMany = Number.isInteger(personCount) && personCount > 1;
  const legacyEligible = personIndex === 0 && !sharedByMany && !impl.existsSync(dir) && holdsChromiumProfile(base, impl);
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

/**
 * One persistent context per person, launched on demand.
 *
 * watcher.js used to launch a single context for the whole run, which is what let
 * cookies cross from one person to the next. This hands out the context for
 * persons[index] and relaunches only when the person changes: the previous context is
 * closed FIRST (one Chromium at a time keeps a small NAS inside its memory), then the next
 * one starts on that person's own profile directory.
 *
 * Register provider.close once as the shutdown cleanup: it closes whichever context is
 * current at that moment, so nothing needs re-registering per person.
 *
 * A launch error is scrubbed of the proxy password before it propagates, because it is
 * the text that ends up on the terminal and in the run log.
 *
 * @param {{
 *   chromium: { launchPersistentContext: Function },
 *   baseDir: string,
 *   persons: object[],
 *   launchOptions: object | (() => object),
 *   prepare?: (context: object) => Promise<void>,
 * }} opts `launchOptions` as a function is called per launch, so each gets a fresh object;
 *   `prepare` is where tuneContext and addInitScript(buildStealthScript()) go.
 * @returns {{ forPerson: (index: number) => Promise<object>, close: () => Promise<void> }}
 */
function createPersonContexts({ chromium, baseDir, persons, launchOptions, prepare }) {
  let current = null;

  async function closeCurrent() {
    const held = current;
    current = null;
    if (!held || held.closed) return;
    try {
      await held.context.close();
    } catch (_) {
      // Already gone (the browser crashed, or the page was closed under it).
    }
  }

  async function forPerson(index) {
    if (!Number.isInteger(index) || index < 0 || index >= persons.length) {
      throw new RangeError(`no person at index ${index}`);
    }
    if (current && current.index === index && !current.closed) return current.context;

    await closeCurrent();
    const options = typeof launchOptions === 'function' ? launchOptions() : { ...launchOptions };
    const dir = profileDirFor({ baseDir, person: persons[index], personIndex: index, personCount: persons.length });

    let context;
    try {
      context = await chromium.launchPersistentContext(dir, options);
    } catch (err) {
      throw scrubLaunchError(err, options.proxy);
    }

    const held = { index, context, closed: false };
    if (typeof context.on === 'function') context.on('close', () => { held.closed = true; });
    // Current from the moment it is launched, not once it is prepared: a shutdown
    // that lands while the init script is still being added must close THIS browser
    // (provider.close is the one hook), not leave a Chromium behind.
    current = held;
    try {
      if (prepare) await prepare(context);
    } catch (err) {
      if (current === held) current = null;
      await context.close().catch(() => {});
      throw err;
    }
    return context;
  }

  return { forPerson, close: closeCurrent };
}

/**
 * A browser context for ONE job, in a profile directory of its own that is removed
 * afterwards (BRK2-11). --confirm-emails opens a link from a mailbox in a broker's
 * site; run in a shared profile, each click inherited the cookies of the one before
 * (and of other persons), which links persons to each other at the broker. Here no
 * click shares anything with another.
 *
 * @param {{
 *   chromium: { launchPersistentContext: Function },
 *   baseDir: string,
 *   launchOptions: object | (() => object),
 *   prepare?: (context: object) => Promise<void>,
 * }} opts `prepare` is where tuneContext and addInitScript(buildStealthScript()) go
 * @returns {{ open: () => Promise<{ context: object, close: () => Promise<void> }> }}
 */
function createThrowawayContexts({ chromium, baseDir, launchOptions, prepare }) {
  async function open() {
    const parent = mkdirPrivate(path.join(expandHome(baseDir), UTILITY_DIR, 'clicks'));
    const dir = fs.mkdtempSync(path.join(parent, 'c-'));
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort off POSIX */ }
    const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a leftover temp dir is harmless */ } };

    const options = typeof launchOptions === 'function' ? launchOptions() : { ...launchOptions };
    let context;
    try {
      context = await chromium.launchPersistentContext(dir, options);
    } catch (err) {
      remove();
      throw scrubLaunchError(err, options.proxy);
    }
    try {
      if (prepare) await prepare(context);
    } catch (err) {
      await context.close().catch(() => {});
      remove();
      throw err;
    }
    return {
      context,
      close: async () => {
        await context.close().catch(() => {});
        remove();
      },
    };
  }
  return { open };
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
  createPersonContexts,
  createThrowawayContexts,
  normalizeUserAgent,
  isHeadlessUserAgent,
  resolveBrowserVersion,
  resolveProxy,
  browserConfigProblems,
  maskProxy,
  describeProxy,
  redactProxySecrets,
  buildLaunchArgs,
  buildLaunchOptions,
  resolveHeadless,
  isLowMemory,
  WEBRTC_PROXY_GUARD,
  BASE_ARGS,
  LINUX_ARGS,
  LOW_MEMORY_ARGS,
  VIEWPORT,
};
