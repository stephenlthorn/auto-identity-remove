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
 * @returns {Promise<Array<{name,domain,breachDate,dataClasses,severity}>>}
 *
 * Status handling:
 *   200 -> map breaches to result shape (severity computed per breach).
 *   404 -> account not found in any breach -> [] (this is the happy "clean" case).
 *   401 -> throw Error('HIBP: invalid API key (401)').
 *   429 -> throw Error('HIBP: rate limited (429)').
 *   other -> throw Error('HIBP: unexpected status <code>').
 */
async function checkBreaches(email, opts = {}) {
  const { apiKey, fetchImpl } = opts;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('HIBP: no fetch implementation available');
  if (!apiKey) throw new Error('HIBP: missing API key');

  const url = `${HIBP_BASE}${encodeURIComponent(email)}?truncateResponse=false`;
  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      'hibp-api-key': apiKey,
      'User-Agent': USER_AGENT,
    },
  });

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

  const registrable = host => {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    const parts = h.split('.').filter(Boolean);
    return parts.length <= 2 ? h : parts.slice(-2).join('.');
  };

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
  if (freeze) {
    lines.push('⚠️  RECOMMENDATION: A high-severity identity breach was found.');
    lines.push('   Consider placing a credit freeze with all three bureaus:');
    lines.push('   Equifax, Experian, and TransUnion (free, reversible).');
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
 * @returns {Promise<{perEmail, allBreaches, brokerMatches, freeze, totalBreaches}>}
 */
async function runBreachCheck(opts = {}) {
  const { emails = [], apiKey, brokers = [], fetchImpl } = opts;
  const perEmail = [];
  const allBreaches = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      const breaches = await checkBreaches(email, { apiKey, fetchImpl });
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

  return {
    perEmail,
    allBreaches,
    brokerMatches,
    freeze,
    totalBreaches: breachCount(allBreaches),
  };
}

module.exports = {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  formatBreachReport,
  runBreachCheck,
  collectEmails,
  missingKeyMessage,
  // constants exported for tests / reuse
  HIBP_BASE,
  USER_AGENT,
};
