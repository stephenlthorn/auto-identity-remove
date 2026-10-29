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
 *
 * A scan only counts as evidence when an engine was USABLE: it answered
 * without a bot wall and parsed at least one result (or showed a known
 * "no results" page). The summary says which engines were usable and whether
 * the scan is `inconclusive`, so a blocked or unreadable engine can never pass
 * for "your name is not in the results" (NET-5).
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { jitterSleep } = require('./timing');
const { resolvePaths } = require('./paths');

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
 * True when `host` is exactly `base` or a dot-anchored subdomain of `base`.
 * Full hosts are compared (not naive two-label registrable domains) so that a
 * lookalike sharing a multi-part TLD such as attacker.co.uk vs broker.co.uk is
 * rejected rather than collapsed to a shared 'co.uk'.
 *
 * @param {string} host
 * @param {string} base
 * @returns {boolean}
 */
function hostMatchesBase(host, base) {
  if (!host || !base) return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  const b = base.toLowerCase().replace(/^www\./, '');
  return h === b || h.endsWith('.' + b);
}

/**
 * Return the intersection of two hostname arrays (deduplicated).
 * A SERP host matches a broker host when it is exactly that host or a
 * dot-anchored subdomain of it, so subdomains like privacy.spokeo.com match
 * broker entry spokeo.com while lookalikes that only share a suffix
 * (attacker.co.uk vs broker.co.uk) do not.
 *
 * @param {string[]} serpHostnames
 * @param {string[]} brokerHostnames
 * @returns {string[]}
 */
function matchBrokers(serpHostnames, brokerHostnames) {
  const seen = new Set();
  const result = [];
  for (const h of serpHostnames) {
    // Return the canonical broker hostname (the one in brokerHostnames) rather than
    // the SERP subdomain so downstream lookups still work with the broker index.
    const brokerHostname = brokerHostnames.find(bh => hostMatchesBase(h, bh));
    if (brokerHostname && !seen.has(brokerHostname)) {
      seen.add(brokerHostname);
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
 * Build a list of { host, name } entries from the brokers array.
 * Uses optOutUrl first, falls back to searchUrl. The FULL broker host is kept
 * (not a naive two-label registrable domain) so that dot-anchored matching can
 * accept subdomains in SERP results (privacy.spokeo.com -> spokeo.com) while
 * rejecting lookalikes on multi-part TLDs (attacker.co.uk vs broker.co.uk).
 *
 * @param {object[]} brokers
 * @returns {Array<{ host: string, name: string }>}
 */
function buildBrokerHostnameIndex(brokers) {
  const index = [];
  for (const b of brokers) {
    const rawUrl = b.optOutUrl || b.searchUrl || '';
    const host = hostnameOf(rawUrl);
    if (host) {
      index.push({ host: host.toLowerCase(), name: b.name });
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

// ── Bot-wall detection ───────────────────────────────────────────────────────
// The old check grepped the raw HTML for "blocked" and "captcha", so a single
// result snippet containing either word discarded an engine's real hits (and a
// <script> mentioning captcha did the same). Now: markup that only a challenge
// page carries, plus phrases that only a challenge page says, matched against
// VISIBLE text. runSerpScan additionally only treats a page as blocked when it
// parsed no results at all.

// Drop script/style blocks and comments; what is left is what a visitor could
// see plus tags.
function stripNonContent(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function visibleText(html) {
  return stripNonContent(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const BLOCK_MARKUP = [
  'g-recaptcha',
  'h-captcha',
  'cf-turnstile',
  'id="captcha-form"',
  '/sorry/index',
  'anomaly-modal',
  'challenge-form',
  'cf-challenge',
];

const BLOCK_PHRASES = [
  'unusual traffic',
  'detected unusual',
  'please verify you',
  'verify you are a human',
  'verify that you are a human',
  'confirm this search was made by a human',
  'bots use duckduckgo',
  'are you a robot',
  'not a robot',
  'one last step',
  'solve the challenge',
  'sorry, we can',
  'enable javascript',
  'access denied',
  'you have been blocked',
  'request blocked',
];

/**
 * True when the page looks like a bot-detection interstitial rather than a
 * results page. Checks known interstitial markup and phrases in visible text,
 * never a bare "blocked" or "captcha".
 * @param {string} html
 * @returns {boolean}
 */
function isBlocked(html) {
  const content = stripNonContent(html).toLowerCase();
  if (BLOCK_MARKUP.some(m => content.includes(m))) return true;
  const text = visibleText(html);
  return BLOCK_PHRASES.some(p => text.includes(p));
}

// "Nothing matched" pages an engine serves for a genuinely quiet name. Such a
// page is a real answer, so the engine counts as usable with zero results.
const NO_RESULTS = {
  ddg:    { markup: ['class="no-results"'], phrases: ['no results.'] },
  bing:   { markup: [], phrases: ['there are no results for', 'no results found for'] },
  google: { markup: [], phrases: ['did not match any documents', 'no results found for'] },
};

function hasNoResultsMarker(engineId, html) {
  const spec = NO_RESULTS[engineId];
  if (!spec) return false;
  const content = stripNonContent(html).toLowerCase();
  if (spec.markup.some(m => content.includes(m))) return true;
  const text = visibleText(html);
  return spec.phrases.some(p => text.includes(p));
}

const USABLE_STATUSES = new Set(['parsed', 'empty']);

/**
 * Classify one engine response.
 *   blocked  - HTTP error status or a bot wall (with no parsed results)
 *   parsed   - at least one result link parsed
 *   empty    - no results, but a known "no results" page (a real answer)
 *   unparsed - answered, but nothing could be read (layout change, blank page)
 * Usable = parsed | empty.
 *
 * @param {string} engineId
 * @param {string} html
 * @param {number} resultCount  parseSerp(...).length
 * @param {number|null} httpStatus
 * @returns {'blocked'|'parsed'|'empty'|'unparsed'}
 */
function classifyEngineResponse(engineId, html, resultCount, httpStatus) {
  if (typeof httpStatus === 'number' && httpStatus >= 400) return 'blocked';
  if (resultCount > 0) return 'parsed';
  if (isBlocked(html)) return 'blocked';
  if (hasNoResultsMarker(engineId, html)) return 'empty';
  return 'unparsed';
}

// ── Main orchestrator ────────────────────────────────────────────────────────

const DATA_DIR     = resolvePaths().data;
const HISTORY_PATH = path.join(DATA_DIR, 'serp-history.json');

/**
 * Run a SERP scan for each person against DDG, Bing, and Google.
 * Compares result hostnames against broker optOutUrl hostnames.
 *
 * The summary also says how far the scan can be trusted: `enginesUsable` lists
 * the engines that answered without a bot wall and parsed results for EVERY
 * person, and `inconclusive` is true when some person got no usable engine at
 * all (then "no brokers found" means nothing).
 *
 * @param {import('playwright').BrowserContext} context   Live Playwright context
 * @param {object[]} persons    Array of person objects (firstName, lastName, city, state, email)
 * @param {object[]} brokers    Array of broker definitions from brokers.js
 * @param {{ _skipWrite?: boolean, _historyPath?: string }} [opts]
 *   _skipWrite suppresses disk I/O (for tests); _historyPath redirects the history file.
 * @returns {Promise<SerpScanSummary>}
 */
async function runSerpScan(context, persons, brokers, opts) {
  const skipWrite = (opts && opts._skipWrite === true);
  const historyPath = (opts && opts._historyPath) || HISTORY_PATH;

  const brokerIndex = buildBrokerHostnameIndex(brokers);
  const scanId = `${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`;

  // Accumulate broker appearances across all persons and engines
  // Map: brokerName -> { ddg: rank|null, bing: rank|null, google: rank|null }
  const appearances = new Map();
  const blockedEngines = new Set();
  const unparsedEngines = new Set();

  // Per engine: the outcome for each scanned person. Per person: the engines
  // that gave a usable answer.
  const outcomes = new Map(ENGINES.map(e => [e.id, []]));
  const usablePerPerson = [];

  // Collect all history records for a single batched write at end of scan.
  const pendingHistoryRecords = [];

  for (const person of persons) {
    const name     = person.fullName || `${person.firstName} ${person.lastName}`;
    const query    = buildQuery(person);
    const personId = hashPerson(name, person.email || '');
    const usableHere = new Set();
    usablePerPerson.push(usableHere);

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
      let httpStatus = null;
      try {
        const response = await page.goto(searchUrl);
        if (response && typeof response.status === 'function') httpStatus = response.status();
        html = await page.content();
      } catch (err) {
        console.log(`   [${eng.id}] navigation error: ${err.message}`);
        blockedEngines.add(eng.id);
        outcomes.get(eng.id).push('blocked');
        continue;
      } finally {
        await page.close().catch(() => {});
      }

      const serpResults = parseSerp(eng.id, html);
      const status = classifyEngineResponse(eng.id, html, serpResults.length, httpStatus);
      outcomes.get(eng.id).push(status);

      if (status === 'blocked') {
        console.log(`   [${eng.id}] BLOCKED by bot-detection`);
        blockedEngines.add(eng.id);
        continue;
      }
      if (status === 'unparsed') {
        console.log(`   [${eng.id}] answered but no results could be read - not counted as a clean scan`);
        unparsedEngines.add(eng.id);
        continue;
      }
      usableHere.add(eng.id);

      console.log(`   [${eng.id}] ${serpResults.length} results parsed`);

      // Map each result URL to a broker, record the first (lowest) rank
      for (const result of serpResults) {
        const host = hostnameOf(result.url);
        if (!host) continue;
        // Dot-anchored host matching so subdomains (privacy.spokeo.com) match
        // spokeo.com while lookalikes on multi-part TLDs are rejected.
        const brokerEntry = brokerIndex.find(e => hostMatchesBase(host, e.host));
        if (!brokerEntry) continue;
        const brokerName = brokerEntry.name;

        if (!appearances.has(brokerName)) {
          appearances.set(brokerName, { hostname: brokerEntry.host, ranks: { ddg: null, bing: null, google: null } });
        }
        const entry = appearances.get(brokerName);
        const ranks = entry.ranks;
        // Keep the best (lowest) rank if seen multiple times on same engine
        if (ranks[eng.id] === null || result.rank < ranks[eng.id]) {
          ranks[eng.id] = result.rank;
        }

        // Collect the record for a batched write.
        // Store only privacy-safe fields: personId (hashed), broker name,
        // engine, rank, and the bare hostname. Do NOT store the raw query
        // (contains plaintext name) or the full URL (may contain name/city).
        if (!skipWrite) {
          pendingHistoryRecords.push({
            scanId,
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

  const engineIds = ENGINES.map(e => e.id);
  const enginesUsable = engineIds.filter(id => {
    const seen = outcomes.get(id);
    return seen.length > 0 && seen.every(st => USABLE_STATUSES.has(st));
  });
  // Worst outcome per engine across persons (for the "why" in the CLI message).
  const engines = {};
  for (const id of engineIds) {
    const seen = outcomes.get(id);
    engines[id] = seen.find(st => !USABLE_STATUSES.has(st)) || seen[seen.length - 1] || 'skipped';
  }
  // Conclusive only if every scanned person had at least one usable engine.
  const inconclusive = usablePerPerson.length === 0 || usablePerPerson.some(set => set.size === 0);

  // Batch-write all collected records in a single atomic file operation. The
  // marker row lets a later reader tell "latest scan, nothing found" from "no
  // scan since" (NET-13), and flags a scan that proves nothing.
  if (!skipWrite) {
    pendingHistoryRecords.push({
      scanId,
      scannedAt: new Date().toISOString(),
      scan: true,
      conclusive: !inconclusive,
      enginesUsable,
    });
    appendManyToHistory(pendingHistoryRecords, historyPath);
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
    unparsed: [...unparsedEngines],
    engines,
    enginesUsable,
    enginesAttempted: ENGINES.length,
    inconclusive,
    scanId,
  };

  return summary;
}

/**
 * Console lines describing what a scan found - or could not find. Pure.
 * "Your opt-outs appear to be effective" is only ever said when every engine
 * was usable; a blocked or unreadable engine is named, and a scan with no
 * usable engine is INCONCLUSIVE.
 *
 * @param {SerpScanSummary} summary
 * @returns {string[]}
 */
function describeScanOutcome(summary) {
  const usable = Array.isArray(summary.enginesUsable) ? summary.enginesUsable : [];
  const attempted = summary.enginesAttempted || ENGINES.length;
  const unusable = ENGINES.map(e => e.id).filter(id => !usable.includes(id));
  const why = unusable
    .map(id => `${id}: ${(summary.engines && summary.engines[id]) || 'unavailable'}`)
    .join(', ');

  if (summary.inconclusive) {
    return [
      usable.length === 0
        ? `INCONCLUSIVE: no search engine returned usable results (${why}).`
        : `INCONCLUSIVE: at least one person got no usable search engine (${why}).`,
      'This is NOT evidence that your opt-outs worked. Try again later or from a different network.',
    ];
  }
  if (summary.total_brokers_appearing > 0) {
    return unusable.length === 0
      ? []
      : [`${usable.length} of ${attempted} search engines were usable; ${unusable.join(', ')} could not be checked (${why}).`];
  }
  if (unusable.length === 0) {
    return [
      'No broker domains found in the top search results.',
      'Your opt-outs appear to be effective at the SERP level.',
    ];
  }
  return [
    `No broker domains found in the top results of the ${usable.length} of ${attempted} search engines that responded (${usable.join(', ')}).`,
    `${unusable.join(', ')} could not be checked (${why}), so this is only partial evidence that your opt-outs are effective.`,
  ];
}

// ── History file helpers ─────────────────────────────────────────────────────

/**
 * Maximum number of entries to retain in serp-history.json.
 * Older entries (earliest scannedAt) are dropped when the cap is exceeded.
 */
const HISTORY_MAX = 5000;

/**
 * Atomically append an array of scan entries to data/serp-history.json.
 * Reads the existing file once, appends all new entries, caps at HISTORY_MAX
 * (keeping the most recent entries), then writes once via tmp->rename.
 *
 * @param {object[]} entries
 * @param {string} [historyPath]  defaults to HISTORY_PATH (tests inject a temp file)
 */
function appendManyToHistory(entries, historyPath = HISTORY_PATH) {
  if (!entries || entries.length === 0) return;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  const tmp = historyPath + '.tmp';

  let existing = [];
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch (_) {}

  const combined = existing.concat(entries);
  // Cap: keep the most recent HISTORY_MAX entries
  const capped = combined.length > HISTORY_MAX
    ? combined.slice(combined.length - HISTORY_MAX)
    : combined;

  fs.writeFileSync(tmp, JSON.stringify(capped, null, 2));
  fs.renameSync(tmp, historyPath);
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
  registrableDomain,
  matchBrokers,
  buildQuery,
  hashPerson,
  runSerpScan,
  describeScanOutcome,
  isBlocked,
  classifyEngineResponse,
  readHistory,
  HISTORY_PATH,
  HISTORY_MAX,
};

/**
 * @typedef {{
 *   total_brokers_appearing: number,
 *   results: Array<{ broker: string, hostname: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>,
 *   blocked: string[],
 *   unparsed: string[],
 *   engines: Record<string, string>,
 *   enginesUsable: string[],
 *   enginesAttempted: number,
 *   inconclusive: boolean,
 *   scanId: string,
 * }} SerpScanSummary
 */
