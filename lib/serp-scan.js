/**
 * lib/serp-scan.js
 *
 * Search-engine self-scan: checks whether data broker sites appear in
 * DuckDuckGo, Bing, and Google results for a person's name + location.
 *
 * Exported helpers (pure, no I/O - fully unit-testable):
 *   parseSerp(engine, html)          Parse result URLs from SERP HTML
 *   hostnameOf(url)                  Extract bare hostname (strips www.)
 *   matchBrokers(serpHosts, brokerHosts) Intersection
 *   buildQuery(person)               Build quoted search query string
 *   hashPerson(fullName, email)      sha256 hex to avoid writing PII
 *
 * Orchestrator (requires live Playwright context):
 *   runSerpScan(context, persons, brokers, opts)
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { jitterSleep } = require('./timing');

// ── HTML mini-parser helpers ─────────────────────────────────────────────────
// We use simple regex-based extraction instead of a real HTML parser to avoid
// new npm dependencies. These are deliberately conservative - false negatives
// are preferred over false positives.

/**
 * Extract all href values from anchor tags matching a CSS-style selector
 * pattern (simplified: we support class-based and element+class selectors).
 *
 * Returns an array of { href } objects in document order.
 *
 * @param {string} html
 * @param {string} selector  e.g. 'a.result__a' or 'li.b_algo h2 a' or 'div.g a'
 */
function extractLinks(html, selector) {
  const links = [];

  if (selector === 'a.result__a') {
    // Match <a class="result__a" href="..."> or <a href="..." class="result__a">
    const re = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>|<a\b[^>]*\bhref="([^"]+)"[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      links.push({ href: m[1] || m[2] });
    }
    return links;
  }

  if (selector === 'li.b_algo h2 a') {
    // Find all <li class="b_algo"> blocks, then extract first <h2><a href>
    const liRe = /<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let liM;
    while ((liM = liRe.exec(html)) !== null) {
      const liContent = liM[1];
      const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
      let h2M;
      while ((h2M = h2Re.exec(liContent)) !== null) {
        const h2Content = h2M[1];
        const aRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/i;
        const aM = aRe.exec(h2Content);
        if (aM) links.push({ href: aM[1] });
      }
    }
    return links;
  }

  if (selector === 'div.g a') {
    // Find all <div class="g"> blocks, extract first <a href>
    const divRe = /<div\b[^>]*\bclass="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bg\b[^"]*"|$)/gi;
    let divM;
    while ((divM = divRe.exec(html)) !== null) {
      const block = divM[1];
      const aRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/i;
      const aM = aRe.exec(block);
      if (aM) links.push({ href: aM[1] });
    }
    return links;
  }

  return links;
}

/**
 * Decode a DuckDuckGo redirect URL to get the real destination URL.
 * DDG wraps results as: https://duckduckgo.com/?uddg=<encoded_url>&...
 * Falls back to the raw href if uddg param is absent.
 *
 * @param {string} href
 * @returns {string}
 */
function decodeDdgUrl(href) {
  try {
    const u = new URL(href);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch (_) {}
  return href;
}

/**
 * Filter Google result URLs to remove internal Google links.
 * Keeps only direct https:// links that are not google.com itself.
 *
 * @param {string} href
 * @returns {string|null}  cleaned URL or null if it should be skipped
 */
function cleanGoogleHref(href) {
  if (!href) return null;
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (host.includes('google.com') || host.includes('googleadservices.com')) return null;
    return href;
  } catch (_) {}
  // Relative links - ignore
  return null;
}

// ── Exported pure helpers ────────────────────────────────────────────────────

/**
 * Parse result URLs from SERP HTML for the given engine.
 *
 * @param {'ddg'|'bing'|'google'} engine
 * @param {string} html
 * @returns {Array<{ rank: number, engine: string, url: string }>}
 */
function parseSerp(engine, html) {
  const SELECTORS = {
    ddg:    'a.result__a',
    bing:   'li.b_algo h2 a',
    google: 'div.g a',
  };

  if (!SELECTORS[engine]) {
    throw new Error(`Unknown engine: "${engine}". Supported: ddg, bing, google`);
  }

  const rawLinks = extractLinks(html, SELECTORS[engine]);
  const results = [];

  for (const { href } of rawLinks) {
    let url;
    if (engine === 'ddg') {
      url = decodeDdgUrl(href);
    } else if (engine === 'google') {
      url = cleanGoogleHref(href);
      if (!url) continue;
    } else {
      url = href;
    }
    results.push({ rank: results.length + 1, engine, url });
  }

  return results;
}

/**
 * Extract the bare hostname from a URL, stripping the www. prefix.
 *
 * @param {string} url
 * @returns {string}  hostname without www., or '' on parse error
 */
function hostnameOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/**
 * Reduce a hostname to its registrable domain (last two labels).
 * e.g. 'privacy.spokeo.com' -> 'spokeo.com'
 *      'spokeo.com'         -> 'spokeo.com'
 *
 * @param {string} hostname
 * @returns {string}
 */
function registrableDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

/**
 * Return the intersection of two hostname arrays (deduplicated).
 * Matches by registrable domain so that subdomains like privacy.spokeo.com
 * correctly match broker entry spokeo.com (L6 fix).
 *
 * @param {string[]} serpHostnames
 * @param {string[]} brokerHostnames
 * @returns {string[]}
 */
function matchBrokers(serpHostnames, brokerHostnames) {
  // Build a set of broker registrable domains (two-label key)
  const brokerSet = new Set(brokerHostnames.map(h => registrableDomain(h)));
  const seen = new Set();
  const result = [];
  for (const h of serpHostnames) {
    const rd = registrableDomain(h);
    if (brokerSet.has(rd) && !seen.has(rd)) {
      seen.add(rd);
      // Return the canonical broker hostname (the one in brokerHostnames) rather than
      // the SERP subdomain so downstream lookups still work with the broker index.
      const brokerHostname = brokerHostnames.find(bh => registrableDomain(bh) === rd) || h;
      result.push(brokerHostname);
    }
  }
  return result;
}

/**
 * Build the quoted search query string for a person.
 *
 * @param {{ fullName?: string, firstName?: string, lastName?: string, city: string, state: string }} person
 * @returns {string}
 */
function buildQuery(person) {
  const name = person.fullName || `${person.firstName} ${person.lastName}`;
  return `"${name}" "${person.city}, ${person.state}"`;
}

/**
 * Return a stable sha256 hex digest of fullName + email.
 * Used as the privacy-safe identifier written to serp-history.json.
 *
 * @param {string} fullName
 * @param {string} email
 * @returns {string}  64-char lowercase hex
 */
function hashPerson(fullName, email) {
  return crypto.createHash('sha256').update(`${fullName}|${email}`).digest('hex');
}

// ── Broker hostname index ────────────────────────────────────────────────────

/**
 * Build a map from registrable domain -> broker name from the brokers array.
 * Uses optOutUrl first, falls back to searchUrl.
 * Keyed by registrable domain (last two labels) so that subdomains in SERP
 * results (e.g. privacy.spokeo.com) match the entry for spokeo.com.
 *
 * @param {object[]} brokers
 * @returns {Map<string, string>}  registrable-domain -> broker name
 */
function buildBrokerHostnameIndex(brokers) {
  const index = new Map();
  for (const b of brokers) {
    const rawUrl = b.optOutUrl || b.searchUrl || '';
    const host = hostnameOf(rawUrl);
    if (host) {
      const rd = registrableDomain(host);
      index.set(rd, b.name);
    }
  }
  return index;
}

// ── SERP page fetcher ────────────────────────────────────────────────────────

const ENGINES = [
  {
    id:  'ddg',
    url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  {
    id:  'bing',
    url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=50`,
  },
  {
    id:  'google',
    url: q => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=50`,
  },
];

// Signals that an engine has blocked the request
const BLOCK_SIGNALS = [
  'unusual traffic',
  'captcha',
  'detected unusual',
  'please verify you',
  'sorry, we can',
  'enable javascript',
  'blocked',
];

function isBlocked(html) {
  const lower = html.toLowerCase();
  return BLOCK_SIGNALS.some(s => lower.includes(s));
}

// ── Main orchestrator ────────────────────────────────────────────────────────

const DATA_DIR     = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'serp-history.json');

/**
 * Run a SERP scan for each person against DDG, Bing, and Google.
 * Compares result hostnames against broker optOutUrl hostnames.
 *
 * @param {import('playwright').BrowserContext} context   Live Playwright context
 * @param {object[]} persons    Array of person objects (firstName, lastName, city, state, email)
 * @param {object[]} brokers    Array of broker definitions from brokers.js
 * @param {{ _skipWrite?: boolean }} [opts]  _skipWrite suppresses disk I/O (for tests)
 * @returns {Promise<SerpScanSummary>}
 */
async function runSerpScan(context, persons, brokers, opts) {
  const skipWrite = (opts && opts._skipWrite === true);

  const brokerIndex = buildBrokerHostnameIndex(brokers);

  // Accumulate broker appearances across all persons and engines
  // Map: brokerName -> { ddg: rank|null, bing: rank|null, google: rank|null }
  const appearances = new Map();
  const blockedEngines = new Set();

  for (const person of persons) {
    const name     = person.fullName || `${person.firstName} ${person.lastName}`;
    const query    = buildQuery(person);
    const personId = hashPerson(name, person.email || '');

    console.log(`\n-- SERP scan: ${name} (${person.city}, ${person.state})`);
    console.log(`   Query: ${query}`);

    for (let engineIdx = 0; engineIdx < ENGINES.length; engineIdx++) {
      const eng = ENGINES[engineIdx];

      // Rate-limit between queries: 5-15 seconds (instant in test/turbo envs)
      if (engineIdx > 0) {
        await jitterSleep(5000, 15000);
      }

      const searchUrl = eng.url(query);
      const page = await context.newPage();

      let html = '';
      try {
        await page.goto(searchUrl);
        html = await page.content();
      } catch (err) {
        console.log(`   [${eng.id}] navigation error: ${err.message}`);
        blockedEngines.add(eng.id);
        continue;
      } finally {
        await page.close().catch(() => {});
      }

      if (isBlocked(html)) {
        console.log(`   [${eng.id}] BLOCKED by bot-detection`);
        blockedEngines.add(eng.id);
        continue;
      }

      const serpResults = parseSerp(eng.id, html);
      console.log(`   [${eng.id}] ${serpResults.length} results parsed`);

      // Map each result URL to a broker, record the first (lowest) rank
      for (const result of serpResults) {
        const host = hostnameOf(result.url);
        if (!host) continue;
        // Use registrable domain for lookup so subdomains (privacy.spokeo.com) match spokeo.com
        const brokerName = brokerIndex.get(registrableDomain(host));
        if (!brokerName) continue;

        if (!appearances.has(brokerName)) {
          appearances.set(brokerName, { hostname: registrableDomain(host), ranks: { ddg: null, bing: null, google: null } });
        }
        const entry = appearances.get(brokerName);
        const ranks = entry.ranks;
        // Keep the best (lowest) rank if seen multiple times on same engine
        if (ranks[eng.id] === null || result.rank < ranks[eng.id]) {
          ranks[eng.id] = result.rank;
        }

        // Record to history (atomic append).
        // Store only privacy-safe fields: personId (hashed), broker name,
        // engine, rank, and the bare hostname. Do NOT store the raw query
        // (contains plaintext name) or the full URL (may contain name/city).
        if (!skipWrite) {
          appendToHistory({
            personId,
            broker: brokerName,
            engine: eng.id,
            rank: result.rank,
            hostname: hostnameOf(result.url),
            scannedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  const resultEntries = [...appearances.entries()].map(([broker, entry]) => ({
    broker,
    hostname: entry.hostname,
    ranks: entry.ranks,
  }));

  /** @type {SerpScanSummary} */
  const summary = {
    total_brokers_appearing: resultEntries.length,
    results: resultEntries,
    blocked: [...blockedEngines],
  };

  return summary;
}

// ── History file helpers ─────────────────────────────────────────────────────

/**
 * Atomically append a single scan entry to data/serp-history.json.
 *
 * @param {object} entry
 */
function appendToHistory(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HISTORY_PATH + '.tmp';

  let existing = [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch (_) {}

  existing.push(entry);
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, HISTORY_PATH);
}

/**
 * Safely read and parse data/serp-history.json.
 * Returns an array of history entries, or [] on any error (missing file,
 * malformed JSON, or a non-array top-level value).
 *
 * @returns {Array<{ personId: string, broker: string, engine: string, rank: number, hostname: string, scannedAt: string }>}
 */
function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  parseSerp,
  hostnameOf,
  matchBrokers,
  buildQuery,
  hashPerson,
  runSerpScan,
  readHistory,
  HISTORY_PATH,
};

/**
 * @typedef {{
 *   total_brokers_appearing: number,
 *   results: Array<{ broker: string, hostname: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>,
 *   blocked: string[],
 * }} SerpScanSummary
 */
