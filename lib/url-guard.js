/**
 * lib/url-guard.js
 *
 * One address-range table and one set of URL checks for everything that points a
 * browser at a URL the user did not type: the generic runner (registry and dataset
 * rows) and the confirmation-email clicker (links from a mailbox).
 *
 * Before this existed each had its own table and they disagreed: the generic
 * runner allowed 192.0.0.192 (Oracle Cloud metadata), 198.18.0.0/15 and Teredo,
 * which the mail clicker blocked, and it let a failed or timed-out DNS lookup
 * through (BRK2-12, codex #3).
 *
 * Rules:
 *   - Anything that is not clearly a public address is refused. A lookup that
 *     errors, times out or returns nothing is a refusal, never a pass.
 *   - A verdict is never cached across requests: Chrome resolves the name itself,
 *     so a cached "public" answer says nothing about where the next request goes
 *     (DNS rebinding). installNavigationGuard() re-checks every navigation and, once
 *     the response is in, compares the address the browser actually connected to.
 *   - Only navigations are intercepted (the page, frames, a form post). Scripts and
 *     images carry no PII from this tool and a page needs its CDNs.
 */

'use strict';

const net = require('net');
const dns = require('dns');

const DNS_LOOKUP_TIMEOUT_MS = 5000;

// Names that are never a public site. A single label ("intranet", "printer") never
// is one either: the browser would hand it to the local resolver search path.
const INTERNAL_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'lan', 'intranet', 'corp'];

// RFC 2606 / 6761 names never resolve to a real site. With the system resolver they
// are not worth a DNS query (the navigation fails on its own), which keeps tests and
// docs that use them off the network. Ignored whenever a lookup is injected.
const RESERVED_NAME_SUFFIXES = ['example', 'invalid', 'test', 'example.com', 'example.net', 'example.org'];

// ─── Address ranges ───────────────────────────────────────────────────────────

// [base, prefix bits]. The union of what the generic runner and the mail clicker
// used to block separately.
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8],        // "this network", unspecified
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT (includes Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (AWS/GCP/Azure metadata)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments (Oracle Cloud metadata 192.0.0.192)
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, broadcast
];

function ipv4ToInt(octets) {
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([base, bits]) => ({
  base: ipv4ToInt(base.split('.').map(Number)),
  mask: bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0),
}));

function parseIPv4(str) {
  const m = String(str).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

function isBlockedIPv4(octets) {
  const value = ipv4ToInt(octets);
  return BLOCKED_IPV4_RANGES.some(({ base, mask }) => ((value & mask) >>> 0) === base);
}

// Expand an IPv6 literal into its 8 16-bit groups, or null when it is not one.
function parseIPv6(str) {
  let s = String(str).split('%')[0];
  if (!net.isIPv6(s)) return null;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const groupsOf = (part) => (part === '' ? [] : part.split(':'));
  let groups;
  if (s.includes('::')) {
    const [head, tail] = s.split('::');
    const h = groupsOf(head);
    const t = groupsOf(tail);
    const missing = 8 - h.length - t.length;
    if (missing < 0) return null;
    groups = [...h, ...Array(missing).fill('0'), ...t];
  } else {
    groups = groupsOf(s);
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function isBlockedIPv6(g) {
  const allZero = (from, to) => g.slice(from, to).every((n) => n === 0);
  const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (allZero(0, 8)) return true;                                 // ::  unspecified
  if (allZero(0, 7) && g[7] === 1) return true;                   // ::1 loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                    // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique-local (AWS fd00:ec2::254)
  if ((g[0] & 0xff00) === 0xff00) return true;                    // ff00::/8 multicast
  if (g[0] === 0x100 && allZero(1, 4)) return true;               // 100::/64 discard-only
  if (g[0] === 0x2001 && g[1] === 0) return true;                 // 2001::/32 Teredo
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  // Addresses that carry an IPv4 address: judge them by the IPv4 inside.
  if (allZero(0, 5) && g[5] === 0xffff) return isBlockedIPv4(v4Of(g[6], g[7]));   // ::ffff:a.b.c.d mapped
  if (allZero(0, 4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(v4Of(g[6], g[7])); // ::ffff:0:a.b.c.d SIIT
  if (allZero(0, 6)) return isBlockedIPv4(v4Of(g[6], g[7]));                       // ::a.b.c.d compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return isBlockedIPv4(v4Of(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(v4Of(g[1], g[2]));                     // 2002::/16 6to4
  return false;
}

/**
 * True when an address must never be a target. Anything that is not recognisably an
 * IP address is refused rather than trusted.
 * @param {string} address
 * @returns {boolean}
 */
function isBlockedAddress(address) {
  const text = String(address || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(text);
  if (family === 4) return isBlockedIPv4(parseIPv4(text));
  if (family === 6) {
    const groups = parseIPv6(text);
    return groups ? isBlockedIPv6(groups) : true;
  }
  return true;
}

// ─── Host names ───────────────────────────────────────────────────────────────

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** localhost, *.local, *.internal ... and single-label names. */
function isInternalHostName(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (net.isIP(host.split('%')[0])) return false;
  if (!host.includes('.')) return true;
  return INTERNAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isReservedName(host) {
  return RESERVED_NAME_SUFFIXES.some((r) => host === r || host.endsWith(`.${r}`));
}

async function resolveAddresses(host, lookup, timeoutMs) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('dns lookup timed out');
      err.code = 'ETIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    const found = await Promise.race([lookup(host, { all: true }), timedOut]);
    const list = Array.isArray(found) ? found : [found];
    return list.map((entry) => (entry && typeof entry === 'object' ? entry.address : entry));
  } finally {
    clearTimeout(timer);
  }
}

// "No such host" is a definite answer (the broker is gone). Everything else a
// resolver can say (timeout, SERVFAIL, no network) leaves the address unknown.
const NXDOMAIN_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Judge a host name: internal names and names that resolve to a blocked address are
 * refused, and so is a name whose address cannot be learned.
 *
 * @param {string} hostname
 * @param {{ lookup?: Function, timeoutMs?: number }} [opts] lookup is dns.promises.lookup-shaped
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, unresolvable?: boolean }>}
 */
async function checkHost(hostname, opts = {}) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, reason: 'url has no host' };
  if (net.isIP(host.split('%')[0])) {
    return isBlockedAddress(host) ? { ok: false, reason: `ip literal ${host}` } : { ok: true };
  }
  if (isInternalHostName(host)) return { ok: false, reason: `internal host name ${host}` };

  const lookup = opts.lookup || dns.promises.lookup;
  const timeoutMs = opts.timeoutMs || DNS_LOOKUP_TIMEOUT_MS;
  let addresses;
  try {
    addresses = await resolveAddresses(host, lookup, timeoutMs);
  } catch (err) {
    if (err && NXDOMAIN_CODES.has(err.code)) return { ok: false, reason: `${host} does not resolve`, unresolvable: true };
    return { ok: false, reason: `dns lookup for ${host} failed (${(err && (err.code || err.message)) || 'error'})` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} resolves to no address` };
  for (const address of addresses) {
    if (isBlockedAddress(address)) return { ok: false, reason: `${host} resolves to ${address}` };
  }
  return { ok: true };
}

/**
 * Judge a whole URL: http(s) only, no embedded credentials, and checkHost().
 * An IP literal is refused here even when public (a broker row is a name); pass
 * allowIpLiteral to judge a literal by its range instead.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: Function, timeoutMs?: number, allowIpLiteral?: boolean }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, unresolvable?: boolean }>}
 */
async function checkUrl(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return { ok: false, reason: 'unparseable url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol.replace(/:$/, '')} is not http(s)` };
  }
  if (url.username || url.password) return { ok: false, reason: 'url embeds credentials' };

  const host = normalizeHost(url.hostname);
  if (!host) return { ok: false, reason: 'url has no host' };
  if (net.isIP(host.split('%')[0]) && !opts.allowIpLiteral) return { ok: false, reason: `ip literal ${host}` };
  if (!opts.lookup && isReservedName(host)) return { ok: true };
  return checkHost(host, opts);
}

// ─── Guarding a live page ─────────────────────────────────────────────────────

const isNavigation = (request) => typeof request.isNavigationRequest === 'function' && request.isNavigationRequest();

/** A URL reduced to its origin and path: the query can carry a name, a token. */
function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return 'unparseable url';
  }
}

/**
 * Watch which address the browser really connected to for each navigation.
 * `response.serverAddr()` is the browser's own answer, so a name that Node saw as
 * public but Chrome resolved to a private address (rebinding, split-horizon DNS)
 * is caught here before anything is typed into the page it returned.
 *
 * @param {import('playwright').Page} page
 * @param {(entry: { url: string, reason: string }) => void} onBlock
 * @returns {{ settle: () => Promise<void> }}
 */
function watchServerAddresses(page, onBlock) {
  let pending = [];
  if (!page || typeof page.on !== 'function') return { settle: async () => {} };
  page.on('response', (response) => {
    const work = (async () => {
      try {
        if (!isNavigation(response.request())) return;
        const addr = typeof response.serverAddr === 'function' ? await response.serverAddr() : null;
        if (addr && addr.ipAddress && isBlockedAddress(addr.ipAddress)) {
          onBlock({ url: describeUrl(response.url()), reason: `connected to ${normalizeHost(addr.ipAddress)}` });
        }
      } catch (_) {
        // A response with no address (cache, service worker, closed page): the DNS check stands.
      }
    })();
    pending.push(work);
  });
  return {
    settle: async () => {
      const work = pending;
      pending = [];
      await Promise.all(work);
    },
  };
}

/**
 * Re-check every navigation the page makes (the first load, each redirect hop, a
 * link or a form post) and remember what was refused. Nothing is cached: each
 * request is judged by `check` when it happens.
 *
 * @param {import('playwright').Page} page
 * @param {{ check: (url: string) => Promise<{ ok: boolean, reason?: string }> }} opts
 * @returns {Promise<{ blocked: Array<{ url: string, reason: string }>, reset: () => void, settle: () => Promise<void> } | null>}
 *   null when the page cannot intercept (a minimal stub): callers fall back to checking URLs by hand.
 */
async function installNavigationGuard(page, { check }) {
  if (!page || typeof page.route !== 'function') return null;
  const blocked = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!isNavigation(request)) return route.continue();
    let verdict;
    try {
      verdict = await check(request.url());
    } catch (_) {
      verdict = { ok: false, reason: 'guard error' };
    }
    if (!verdict.ok) {
      blocked.push({ url: describeUrl(request.url()), reason: verdict.reason });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const addresses = watchServerAddresses(page, (entry) => blocked.push(entry));
  return {
    blocked,
    reset: () => { blocked.length = 0; },
    settle: () => addresses.settle(),
  };
}

module.exports = {
  isBlockedAddress,
  isInternalHostName,
  checkHost,
  checkUrl,
  installNavigationGuard,
  watchServerAddresses,
  describeUrl,
  parseIPv4,
  parseIPv6,
  BLOCKED_IPV4,
  INTERNAL_HOST_SUFFIXES,
  DNS_LOOKUP_TIMEOUT_MS,
};
