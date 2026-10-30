/**
 * lib/hibp.js
 *
 * Have I Been Pwned (HIBP) v3 breach integration.
 *
 * Pure, fully unit-testable helpers (no I/O):
 *   severityOf(dataClasses)              -> 'high' | 'medium' | 'low'
 *   crossReferenceBrokers(breaches, bk)  -> [{ breach, broker }]
 *   recommendFreeze(breaches)            -> boolean
 *   breachCount(breaches)                -> number   (consumed by exposure-score)
 *   formatBreachReport({...})            -> string   (printable report)
 *
 * Networked client (injectable fetchImpl, defaults to global fetch):
 *   checkBreaches(email, { apiKey, fetchImpl })
 *
 * Orchestrator (composes the above; used by the watcher --breach-check mode):
 *   runBreachCheck({ emails, apiKey, brokers, fetchImpl })
 *
 * Tests MUST inject fetchImpl and never hit the network. Between live HIBP
 * calls we sleep ~1.5s via lib/timing.jitterSleep, which fast-paths to a no-op
 * under NODE_ENV=test / TURBO=1 so the suite stays fast.
 */

'use strict';

const { jitterSleep } = require('./timing');

const HIBP_BASE = 'https://haveibeenpwned.com/api/v3/breachedaccount/';
const USER_AGENT = 'auto-identity-remove';

// A hung connection must not hang the whole --breach-check run.
const DEFAULT_TIMEOUT_MS = 15000;
// Longest Retry-After we will sit through. HIBP's own limit is seconds; a
// larger value means "come back later", which a CLI run should report, not wait out.
const DEFAULT_MAX_RETRY_AFTER_MS = 30000;
const MAX_RATE_LIMIT_RETRIES = 1;

// Second-level public suffixes common enough among breached sites and brokers
// that collapsing to the last two labels would merge unrelated sites
// ("victim.co.uk" and "unrelated.co.uk" both became "co.uk"). Deliberately a
// short list, not a full public-suffix database: no new dependency.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.ph', 'com.vn',
  'co.kr', 'or.kr', 'ac.kr', 'co.id', 'co.th', 'co.il', 'org.il', 'ac.il',
  'com.tr', 'com.ua', 'com.pl', 'com.ru', 'com.eg', 'com.sa', 'com.pk', 'com.ng',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'co.ke', 'co.zw',
]);

/**
 * Reduce a hostname to its registrable domain: the last two labels, or the
 * last three when the final two form a known two-level suffix such as co.uk.
 * Pure. Lowercases and drops a leading "www.".
 *
 * @param {string} host
 * @returns {string}
 */
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function _defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Seconds (HIBP's form) or an HTTP date, as milliseconds; null when absent or
 * unparseable.
 */
function _retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// Race the request against a timer (and abort it) so a stubbed or hung fetch
// that ignores the signal still ends.
function _fetchWithTimeout(doFetch, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error(`HIBP: request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = doFetch(url, controller ? { ...init, signal: controller.signal } : init);
  return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}

// Data classes that escalate a breach to high severity. Matched
// case-insensitively against the breach's dataClasses array. HIBP uses
// "Social security numbers"; this tool also documents "SSN" as a synonym.
const HIGH_SEVERITY_CLASSES = new Set([
  'ssn',
  'social security numbers',
  'passwords',
  'physical addresses',
]);

// Data classes that are sensitive enough to warrant medium severity.
const MEDIUM_SEVERITY_CLASSES = new Set([
  'phone numbers',
  'dates of birth',
  'credit cards',
  'bank account numbers',
  'security questions and answers',
]);

/**
 * Classify the severity of a breach from its dataClasses.
 * Pure. Case-insensitive. high > medium > low.
 *
 * @param {string[]|null|undefined} dataClasses
 * @returns {'high'|'medium'|'low'}
 */
function severityOf(dataClasses) {
  if (!Array.isArray(dataClasses) || dataClasses.length === 0) return 'low';
  const lowered = dataClasses.map(c => String(c).toLowerCase().trim());
  if (lowered.some(c => HIGH_SEVERITY_CLASSES.has(c))) return 'high';
  if (lowered.some(c => MEDIUM_SEVERITY_CLASSES.has(c))) return 'medium';
  return 'low';
}

/**
 * Query HIBP v3 for breaches affecting a single email address.
 *
 * @param {string} email
 * @param {object} opts
 * @param {string} opts.apiKey          HIBP API key (required by HIBP).
 * @param {function} [opts.fetchImpl]   Injected fetch (defaults to global fetch).
 * @param {number} [opts.timeoutMs]     Per-request timeout (default 15s).
 * @param {number} [opts.maxRetryAfterMs] Longest Retry-After to wait out (default 30s).
 * @param {function} [opts.sleepImpl]   Injected sleep(ms) (tests).
 * @returns {Promise<Array<{name,domain,breachDate,dataClasses,severity}>>}
 *
 * Status handling:
 *   200 -> map breaches to result shape (severity computed per breach).
 *   404 -> account not found in any breach -> [] (this is the happy "clean" case).
 *   401 -> throw Error('HIBP: invalid API key (401)').
 *   429 -> wait Retry-After (bounded) and retry once; still limited ->
 *          throw Error('HIBP: rate limited (429)').
 *   timeout / network failure -> throw Error('HIBP: ...').
 *   other -> throw Error('HIBP: unexpected status <code>').
 */
async function checkBreaches(email, opts = {}) {
  const {
    apiKey,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    sleepImpl = _defaultSleep,
  } = opts;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('HIBP: no fetch implementation available');
  if (!apiKey) throw new Error('HIBP: missing API key');

  const url = `${HIBP_BASE}${encodeURIComponent(email)}?truncateResponse=false`;
  const init = {
    method: 'GET',
    headers: {
      'hibp-api-key': apiKey,
      'User-Agent': USER_AGENT,
    },
  };

  let res;
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await _fetchWithTimeout(doFetch, url, init, timeoutMs);
    } catch (err) {
      if (/^HIBP: /.test(err.message)) throw err;
      throw new Error(`HIBP: network error (${String(err.message).slice(0, 80)})`);
    }
    if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) break;
    const waitMs = _retryAfterMs(res);
    if (waitMs == null || waitMs > maxRetryAfterMs) break;
    await sleepImpl(waitMs);
  }

  if (res.status === 404) return [];
  if (res.status === 401) throw new Error('HIBP: invalid API key (401)');
  if (res.status === 429) throw new Error('HIBP: rate limited (429)');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HIBP: unexpected status ${res.status}`);
  }

  const body = await res.json();
  const breaches = Array.isArray(body) ? body : [];
  return breaches.map(b => {
    const dataClasses = Array.isArray(b.DataClasses) ? b.DataClasses : [];
    return {
      name: b.Name || b.Title || '',
      domain: b.Domain || '',
      breachDate: b.BreachDate || '',
      dataClasses,
      severity: severityOf(dataClasses),
    };
  });
}

/**
 * Cross-reference breach domains against known data-broker entries.
 * A match means the breached site is itself a broker we attempt to opt out of.
 * Pure.
 *
 * @param {Array<{name,domain,...}>} breaches
 * @param {Array<{name,optOutUrl?,searchUrl?}>} brokers
 * @returns {Array<{breach: object, broker: object}>}
 */
function crossReferenceBrokers(breaches, brokers) {
  if (!Array.isArray(breaches) || !Array.isArray(brokers)) return [];

  const registrable = registrableDomain;

  const brokerHostOf = broker => {
    try {
      return registrable(new URL(broker.optOutUrl || broker.searchUrl || '').hostname);
    } catch (_) {
      return '';
    }
  };

  const matches = [];
  for (const breach of breaches) {
    const bd = registrable(breach.domain);
    if (!bd) continue;
    for (const broker of brokers) {
      const bh = brokerHostOf(broker);
      if (bh && bh === bd) matches.push({ breach, broker });
    }
  }
  return matches;
}

/**
 * Recommend a credit freeze when any high-severity breach exists.
 * Pure.
 *
 * @param {Array<{severity:string}>} breaches
 * @returns {boolean}
 */
function recommendFreeze(breaches) {
  if (!Array.isArray(breaches)) return false;
  return breaches.some(b => b && b.severity === 'high');
}

/**
 * Total number of breaches across the supplied list. Consumed by the
 * exposure-score feature.
 * Pure.
 *
 * @param {Array<unknown>} breaches
 * @returns {number}
 */
function breachCount(breaches) {
  return Array.isArray(breaches) ? breaches.length : 0;
}

/**
 * Collect unique, lowercased email addresses from a persons array.
 * Pure. Skips persons without an email. Preserves first-seen order.
 *
 * @param {Array<{email?:string}>} persons
 * @returns {string[]}
 */
function collectEmails(persons) {
  if (!Array.isArray(persons)) return [];
  const seen = new Set();
  const out = [];
  for (const p of persons) {
    const email = p && p.email ? String(p.email).trim().toLowerCase() : '';
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

/**
 * Friendly message explaining how to obtain a free HIBP API key.
 * Pure. Printed by the --breach-check watcher mode when hibp.apiKey is absent.
 *
 * @returns {string}
 */
function missingKeyMessage() {
  return [
    'No HIBP API key configured.',
    '',
    'The Have I Been Pwned breach-check feature needs an API key:',
    '  1. Get a key (low-cost, supports the service): https://haveibeenpwned.com/API/Key',
    '  2. Add it to config.json under hibp.apiKey:',
    '       "hibp": { "apiKey": "YOUR_KEY_HERE" }',
    '',
    'Then re-run: node watcher.js --breach-check',
  ].join('\n');
}

/**
 * Render a human-readable breach report.
 * Pure (no console, no I/O) so it is unit-testable.
 *
 * @param {object} args
 * @param {Array<{email,breaches,error?}>} args.perEmail
 * @param {Array<{breach,broker}>} args.brokerMatches
 * @param {boolean} args.freeze
 * @returns {string}
 */
function formatBreachReport({ perEmail, brokerMatches, freeze }) {
  const lines = [];
  lines.push('='.repeat(54));
  lines.push('Have I Been Pwned - breach check');
  lines.push('='.repeat(54));

  for (const entry of perEmail) {
    if (entry.error) {
      lines.push(`\n${entry.email}: error - ${entry.error}`);
      continue;
    }
    if (entry.breaches.length === 0) {
      lines.push(`\n${entry.email}: no breaches found ✅`);
      continue;
    }
    lines.push(`\n${entry.email}: ${entry.breaches.length} breach(es)`);
    for (const b of entry.breaches) {
      const date = b.breachDate ? ` (${b.breachDate})` : '';
      lines.push(`  [${b.severity.toUpperCase()}] ${b.name}${date} - ${b.dataClasses.join(', ')}`);
    }
  }

  if (brokerMatches.length > 0) {
    lines.push('\nBreached sites that are also data brokers we target:');
    for (const m of brokerMatches) {
      lines.push(`  - ${m.breach.name} (${m.breach.domain}) ↔ broker "${m.broker.name}"`);
    }
  }

  lines.push('');
  const failed = perEmail.filter(e => e.error).length;
  if (freeze) {
    lines.push('⚠️  RECOMMENDATION: A high-severity identity breach was found.');
    lines.push('   Consider placing a credit freeze with all three bureaus:');
    lines.push('   Equifax, Experian, and TransUnion (free, reversible).');
    if (failed > 0) {
      lines.push(`   INCONCLUSIVE for the rest: ${failed} of ${perEmail.length} lookup(s) failed, so this list may be incomplete.`);
    }
  } else if (perEmail.length === 0) {
    lines.push('INCONCLUSIVE: no email addresses were checked, so nothing can be said about breaches.');
  } else if (failed > 0) {
    // A failed lookup is not "no breaches": never print the all-clear (NET-12).
    lines.push(`INCONCLUSIVE: ${failed} of ${perEmail.length} breach lookup(s) failed, so this is NOT an all-clear.`);
    lines.push('   Fix the error above (API key, rate limit, or network) and re-run.');
  } else {
    lines.push('No high-severity identity breaches found. No credit freeze needed right now.');
  }
  lines.push('='.repeat(54));
  return lines.join('\n');
}

/**
 * Orchestrator: check every email, cross-reference brokers, decide on freeze.
 * Composes the pure helpers + the networked client. Used by watcher
 * --breach-check mode. Sleeps ~1.5s between live HIBP calls (no-op in tests).
 *
 * @param {object} opts
 * @param {string[]} opts.emails
 * @param {string} opts.apiKey
 * @param {Array} [opts.brokers]
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]    forwarded to checkBreaches
 * @param {function} [opts.sleepImpl]  forwarded to checkBreaches
 * @returns {Promise<{perEmail, allBreaches, brokerMatches, freeze, totalBreaches, errorCount, inconclusive}>}
 *   `inconclusive` is true when any lookup errored (or none ran): the caller
 *   must not present the result as an all-clear.
 */
async function runBreachCheck(opts = {}) {
  const { emails = [], apiKey, brokers = [], fetchImpl, timeoutMs, sleepImpl } = opts;
  const perEmail = [];
  const allBreaches = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      const breaches = await checkBreaches(email, { apiKey, fetchImpl, timeoutMs, sleepImpl });
      perEmail.push({ email, breaches });
      allBreaches.push(...breaches);
    } catch (err) {
      perEmail.push({ email, breaches: [], error: err.message });
    }
    // HIBP requires ~1.5s between requests. No-op under NODE_ENV=test.
    if (i < emails.length - 1) await jitterSleep(1500, 1500);
  }

  const brokerMatches = crossReferenceBrokers(allBreaches, brokers);
  const freeze = recommendFreeze(allBreaches);
  const errorCount = perEmail.filter(e => e.error).length;

  return {
    perEmail,
    allBreaches,
    brokerMatches,
    freeze,
    totalBreaches: breachCount(allBreaches),
    errorCount,
    inconclusive: errorCount > 0 || perEmail.length === 0,
  };
}

module.exports = {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  registrableDomain,
  formatBreachReport,
  runBreachCheck,
  collectEmails,
  missingKeyMessage,
  // constants exported for tests / reuse
  HIBP_BASE,
  USER_AGENT,
};
