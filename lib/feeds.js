/**
 * lib/feeds.js
 *
 * Live broker-list feeds from official state registries (California + Vermont).
 *
 * Replaces reliance on the stale (Jan 2023) Markup dataset as the only coverage
 * source. The registries are public CSV exports; this module fetches them
 * (fetchImpl injectable for tests), normalizes each row to the generic broker
 * shape { name, optOutUrl, method, source }, dedups by registrable domain
 * against the explicit brokers.js list (and against each other), and the result
 * is written by watcher.js --update-brokers to data/feeds-brokers.json.
 *
 * Pure helpers (normalizeFeedRow, parseCsv, mapHeaderRow, dedupeFeedBrokers)
 * have no network or file I/O. Only fetchCaRegistry / fetchVtRegistry /
 * buildFeedsFile touch the (injected) network.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { hostnameOf } = require('./serp-scan');

// ── Registry endpoints (real, public) ────────────────────────────────────────
// California: legacy AG registry CSV export (2020-2023) at oag.ca.gov/data-brokers.
// The current registry is maintained by the CPPA (cppa.ca.gov/data_broker_registry);
// the AG CSV remains the most machine-readable historical export and is used as
// the default. Override via the CA_REGISTRY_URL env var when the CPPA publishes a
// stable CSV endpoint.
const CA_REGISTRY_URL = process.env.CA_REGISTRY_URL
  || 'https://oag.ca.gov/data-brokers/csv';

// Vermont: Secretary of State data-broker registry bulk export.
// Override via VT_REGISTRY_URL.
const VT_REGISTRY_URL = process.env.VT_REGISTRY_URL
  || 'https://bizfilings.vermont.gov/online/DatabrokerInquire/DatabrokerExport';

const FEEDS_PATH = path.join(__dirname, '..', 'data', 'feeds-brokers.json');

// Header aliases -> canonical fields. Registries use different column titles.
const NAME_HEADERS = ['data broker name', 'business name', 'name', 'company name', 'registrant'];
const URL_HEADERS  = ['website url', 'website', 'url', 'opt-out url', 'opt out url', 'privacy url'];

// URL path keywords that indicate a directly-actionable opt-out / request page.
const DIRECT_FORM_KEYWORDS = [
  'opt-out', 'optout', 'opt_out',
  'do-not-sell', 'donotsell', 'do_not_sell',
  'privacy-request', 'privacyrequest',
  'data-request', 'datarequest',
  'dsar', 'remove', 'delete', 'request',
];

/**
 * Parse a single CSV line into an array of cell strings, honoring double-quoted
 * fields, embedded commas, and doubled-quote ("") escapes.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * Map a header array and a cell array into a row object keyed by lowercased,
 * trimmed header names. Tolerates rows shorter than the header row.
 * @param {string[]} headers
 * @param {string[]} cells
 * @returns {Record<string,string>}
 */
function mapHeaderRow(headers, cells) {
  const row = {};
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || '').trim().toLowerCase();
    if (!key) continue;
    row[key] = cells[i] !== undefined ? cells[i] : '';
  }
  return row;
}

/**
 * Parse a CSV string into an array of header-mapped row objects. The first
 * non-empty line is treated as the header. Blank lines are skipped.
 * @param {string} csv
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(csv) {
  if (!csv) return [];
  const lines = String(csv).split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    rows.push(mapHeaderRow(headers, cells));
  }
  return rows;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && String(row[key]).trim().length > 0) {
      return String(row[key]).trim();
    }
  }
  return '';
}

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function classifyMethod(url) {
  if (!url) return 'manual';
  // Extract the URL path only (ignore hostname/query-param values to avoid false positives).
  // A keyword must appear as a whole path segment (delimited by / or end-of-path).
  let urlPath;
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch (_) {
    // Fallback for scheme-less URLs: use the portion after the first /
    const slashIdx = url.indexOf('/');
    urlPath = slashIdx === -1 ? '' : url.slice(slashIdx).toLowerCase();
  }
  // Split the path into individual segments (filter empty strings from leading /)
  const segments = urlPath.split('/').filter(s => s.length > 0);
  for (const kw of DIRECT_FORM_KEYWORDS) {
    // Match whole segments or segment parts separated by - or _
    // e.g. kw="opt-out" matches segment "opt-out", "opt-out-request" etc.
    // kw="remove" must be a complete segment or a hyphen/underscore token
    for (const seg of segments) {
      // Split each segment on hyphens and underscores to get sub-tokens
      const tokens = seg.split(/[-_]/);
      // The keyword itself matches as a whole segment
      if (seg === kw) return 'direct-form';
      // Or the keyword appears as a whole hyphen/underscore-separated token within the segment
      if (tokens.includes(kw)) return 'direct-form';
      // Or the segment starts with the keyword followed by - or _
      // (handles "opt-out-request" matching "opt-out")
      if (seg.startsWith(kw + '-') || seg.startsWith(kw + '_')) return 'direct-form';
    }
  }
  return 'manual';
}

/**
 * Normalize one parsed registry row into a generic broker entry.
 * @param {Record<string,string>} row  header-mapped row (lowercased keys)
 * @param {string} source  'ca' | 'vt'
 * @returns {{ name: string, optOutUrl: string, method: string, source: string } | null}
 */
function normalizeFeedRow(row, source) {
  if (!row || typeof row !== 'object') return null;
  const name = pickField(row, NAME_HEADERS);
  if (!name) return null;
  const optOutUrl = normalizeUrl(pickField(row, URL_HEADERS));
  return {
    name,
    optOutUrl,
    method: classifyMethod(optOutUrl),
    source,
  };
}

/**
 * Dedupe normalized feed brokers by registrable domain, dropping any whose
 * host collides with an explicit broker host (or with an earlier feed entry).
 * Entries with no parseable host (empty optOutUrl) are kept as-is - they are
 * manual rows that carry no dedupe key.
 * @param {Array<{name,optOutUrl,method,source}>} brokers
 * @param {Iterable<string>} explicitHosts  bare hostnames (www-stripped) from brokers.js
 * @returns {Array<{name,optOutUrl,method,source}>}
 */
function dedupeFeedBrokers(brokers, explicitHosts) {
  const seen = new Set(explicitHosts);
  const out = [];
  for (const b of brokers) {
    if (!b) continue;
    const host = hostnameOf(b.optOutUrl);
    if (!host) { out.push(b); continue; }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(b);
  }
  return out;
}

async function fetchText(url, fetchImpl) {
  const impl = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!impl) throw new Error('No fetch implementation available (Node 18+ global fetch or inject fetchImpl)');
  const res = await impl(url);
  if (!res || !res.ok) {
    const status = res ? res.status : 'no-response';
    throw new Error(`Feed fetch failed for ${url}: HTTP ${status}`);
  }
  return res.text();
}

/**
 * Fetch + normalize the California data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source}>>}
 */
async function fetchCaRegistry(opts = {}) {
  const url = opts.url || CA_REGISTRY_URL;
  const csv = await fetchText(url, opts.fetchImpl);
  return parseCsv(csv).map(r => normalizeFeedRow(r, 'ca')).filter(Boolean);
}

/**
 * Fetch + normalize the Vermont data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source}>>}
 */
async function fetchVtRegistry(opts = {}) {
  const url = opts.url || VT_REGISTRY_URL;
  const csv = await fetchText(url, opts.fetchImpl);
  return parseCsv(csv).map(r => normalizeFeedRow(r, 'vt')).filter(Boolean);
}

/**
 * Fetch both registries, merge, and dedupe against the explicit broker hosts.
 * Pure aside from the (injected) fetches; does NOT write to disk - callers
 * (watcher.js --update-brokers) own the write.
 * @param {{ fetchImpl?: Function, explicitHosts?: Iterable<string> }} [opts]
 * @returns {Promise<{ brokers: Array, stats: { ca: number, vt: number, total: number } }>}
 */
async function buildFeedsFile(opts = {}) {
  const fetchImpl = opts.fetchImpl;
  const explicitHosts = opts.explicitHosts || [];
  const ca = await fetchCaRegistry({ fetchImpl });
  const vt = await fetchVtRegistry({ fetchImpl });
  const merged = dedupeFeedBrokers([...ca, ...vt], explicitHosts);
  return {
    brokers: merged,
    stats: { ca: ca.length, vt: vt.length, total: merged.length },
  };
}

/**
 * Derive the bare (www-stripped) hostnames an explicit broker covers, from its
 * optOutUrl or searchUrl. Email-only / host-less brokers contribute nothing.
 * @param {Array<{optOutUrl?:string, searchUrl?:string}>} brokers
 * @returns {Set<string>}
 */
function explicitHostsOf(brokers) {
  const hosts = new Set();
  for (const b of brokers || []) {
    const host = hostnameOf((b && (b.optOutUrl || b.searchUrl)) || '');
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Orchestrate `watcher.js --update-brokers`: derive explicit hosts, fetch +
 * normalize + dedup both registries via buildFn, persist via writeFn, and log a
 * summary via logFn. All side-effecting deps are injected for testability.
 * @param {{
 *   brokers: Array,
 *   buildFn?: (opts:{ explicitHosts:Set<string> }) => Promise<{brokers:Array, stats:object}>,
 *   writeFn?: (brokers:Array) => void,
 *   logFn?: (msg:string) => void,
 * }} deps
 * @returns {Promise<{ brokers: Array, stats: { ca:number, vt:number, total:number } }>}
 */
async function runUpdateBrokers(deps = {}) {
  const { brokers = [] } = deps;
  const buildFn = deps.buildFn || buildFeedsFile;
  const log = deps.logFn || (() => {});
  const writeFn = deps.writeFn || ((arr) => {
    fs.writeFileSync(FEEDS_PATH, JSON.stringify(arr, null, 2));
  });
  const explicitHosts = explicitHostsOf(brokers);
  log(`Fetching live broker registries (CA + Vermont)...`);
  const { brokers: feedBrokers, stats } = await buildFn({ explicitHosts });
  writeFn(feedBrokers);
  log(`Wrote ${stats.total} deduped registry broker(s) to data/feeds-brokers.json`);
  log(`  California: ${stats.ca} fetched - Vermont: ${stats.vt} fetched`);
  return { brokers: feedBrokers, stats };
}

module.exports = {
  normalizeFeedRow,
  parseCsv,
  parseCsvLine,
  mapHeaderRow,
  dedupeFeedBrokers,
  explicitHostsOf,
  fetchCaRegistry,
  fetchVtRegistry,
  buildFeedsFile,
  runUpdateBrokers,
  CA_REGISTRY_URL,
  VT_REGISTRY_URL,
  FEEDS_PATH,
};
