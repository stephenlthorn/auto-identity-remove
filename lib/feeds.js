/**
 * lib/feeds.js
 *
 * Live broker-list feeds from official state registries.
 *
 * Registries today:
 *   CA  California Privacy Protection Agency, the current registry (CSV).
 *   VT  Vermont. Its site stopped offering a file export, so by default it is
 *       skipped with one plain line; VT_REGISTRY_URL still lets you point at a
 *       CSV of your own.
 * Texas and Oregon run web-application-only registries with no CSV, sheet or
 * JSON export, so they are not read.
 *
 * Each registry is fetched on its own (fetchImpl injectable for tests) and
 * reports on its own: an HTML page, a non-2xx status, zero parseable rows, a
 * file cut off by an unclosed quote or one far smaller than the last good run
 * is a failure for THAT registry, never an empty success. Rows are normalized to
 * the generic broker shape { name, optOutUrl, method, source, registries },
 * deduped by company (the registrable domain of the primary website) against the
 * explicit brokers.js list (and against each other), and written by
 * `aidr update-brokers` to data/feeds-brokers.json as
 * { brokers, registryHosts, registries, updatedAt }. registryHosts maps the
 * registrable domain of each broker's PRIMARY WEBSITE to the registries that list
 * it (never a rights-page host, a shared form platform or a bare suffix) and is
 * built BEFORE the dedupe, so brokers the tool already knows can be matched too
 * (the DROP package reads it).
 *
 * Pure helpers (normalizeFeedRow, parseCsv, mapHeaderRow, normalizeHeader,
 * dedupeFeedBrokers) have no network or file I/O. Only the fetchers and
 * buildFeedsFile touch the (injected) network.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { hostnameOf } = require('./serp-scan');
const { registrableDomain, looksLikeHost, isCoverableDomain, isSharedPlatformHost } = require('./domains');
const { resolvePaths } = require('./paths');

// ── Registry endpoints (real, public) ────────────────────────────────────────
// California: the CPPA's current registry. The older Attorney General export
// (oag.ca.gov/data-brokers/csv, 2020 to 2023) now answers 403. Override via the
// CA_REGISTRY_URL env var.
const CA_REGISTRY_URL = process.env.CA_REGISTRY_URL
  || 'https://cppa.ca.gov/data_broker_registry/registry.csv';

// Vermont: the old export URL now returns an HTML web-app page, not a file. It
// is kept as the documented default but NOT fetched unless VT_REGISTRY_URL is
// set (VT_REGISTRY_URL_OVERRIDE), because fetching it can only fail.
const VT_REGISTRY_URL_OVERRIDE = process.env.VT_REGISTRY_URL || '';
const VT_REGISTRY_URL = VT_REGISTRY_URL_OVERRIDE
  || 'https://bizfilings.vermont.gov/online/DatabrokerInquire/DatabrokerExport';
const VT_SKIP_MESSAGE = "Vermont's site no longer offers a file export, so it was skipped";

// Some government hosts answer 403 to a bare client.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 60000;

const FEEDS_PATH = path.join(resolvePaths().data, 'feeds-brokers.json');

// Header aliases -> canonical fields. Registries use different column titles.
// Keys are the normalizeHeader() form: lower-case, no trailing colon or [note].
const NAME_HEADERS = ['data broker name', 'business name', 'name', 'company name', 'registrant'];
const URL_HEADERS  = ['website url', 'website', 'data broker primary website', 'url', 'opt-out url', 'opt out url', 'privacy url'];
// California's column for how consumers exercise their rights; preferred as the
// opt-out URL. The real header is long, so it is matched by its opening words.
const RIGHTS_HEADER_PREFIX = "data broker's primary website that contains details";

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
 * Reduce a registry header cell to a stable key so the alias lists keep working
 * when a registry decorates its titles: drop a byte-order mark, bracketed notes
 * like "[optional]" and trailing colons, turn curly quotes into straight ones
 * and non-breaking hyphens and spaces into plain ones, collapse spaces, and
 * lower-case.
 * @param {string} raw
 * @returns {string}
 */
function normalizeHeader(raw) {
  return String(raw || '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Map a header array and a cell array into a row object keyed by normalized
 * header names (see normalizeHeader). Tolerates rows shorter than the header row.
 * @param {string[]} headers
 * @param {string[]} cells
 * @returns {Record<string,string>}
 */
function mapHeaderRow(headers, cells) {
  const row = {};
  for (let i = 0; i < headers.length; i++) {
    const key = normalizeHeader(headers[i]);
    if (!key) continue;
    row[key] = cells[i] !== undefined ? cells[i] : '';
  }
  return row;
}

/**
 * Split CSV text into records (arrays of cells) with a quote-aware state
 * machine, so a quoted cell may contain commas, doubled-quote escapes AND
 * newlines. Splitting the text on newlines first (the old approach) turned the
 * second line of a multi-line address or description into a bogus record.
 *
 * Record separators outside quotes are \r\n, \n or a lone \r. Blank lines are
 * skipped; a blank line inside a quoted cell is kept. A leading BOM is dropped
 * and an unterminated quote consumes to the end of the text.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsvRecords(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const records = [];
  let cells = [];
  let cur = '';
  let inQuotes = false;

  const endRecord = () => {
    cells.push(cur);
    const blank = cells.length === 1 && cells[0] === '';
    if (!blank) records.push(cells);
    cells = [];
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || cells.length > 0) endRecord();
  return records;
}

/**
 * Parse a CSV string into an array of header-mapped row objects. The first
 * non-empty record is treated as the header. Blank lines are skipped.
 * @param {string} csv
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(csv) {
  if (!csv) return [];
  const records = parseCsvRecords(csv);
  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    rows.push(mapHeaderRow(headers, records[i]));
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

// One http(s) URL and nothing else: "https://x.example/privacy or email privacy@x.example" is a
// sentence that happens to start with a URL, and opening it would visit the wrong page.
function isHttpUrl(raw) {
  const t = String(raw || '').trim();
  if (/\s/.test(t)) return false;
  if (!/^https?:\/\//i.test(t)) return false;
  try { return Boolean(new URL(t).hostname); } catch (_) { return false; }
}

function pickByPrefix(row, prefix) {
  const key = Object.keys(row).find(k => k.startsWith(prefix));
  return key ? String(row[key]).trim() : '';
}

/** Registry code for a source tag: 'ca' -> 'CA'. */
function registryCode(source) {
  return String(source || '').toUpperCase();
}

/**
 * Normalize one parsed registry row into a generic broker entry. A valid
 * http(s) consumer-rights URL (California's rights column) wins as the opt-out
 * URL; otherwise the primary website is used.
 * @param {Record<string,string>} row  header-mapped row (normalized keys)
 * @param {string} source  'ca' | 'vt'
 * @returns {{ name: string, optOutUrl: string, method: string, source: string, registries: string[] } | null}
 */
function normalizeFeedRow(row, source) {
  if (!row || typeof row !== 'object') return null;
  const name = pickField(row, NAME_HEADERS);
  if (!name) return null;
  const rightsUrl = pickByPrefix(row, RIGHTS_HEADER_PREFIX);
  const chosen = isHttpUrl(rightsUrl)
    ? rightsUrl
    : normalizeUrl(pickField(row, URL_HEADERS));
  // A cell that is not a dotted host name ("constructor", "see our website") gives no
  // page to visit: the row stays, as a manual one with no URL.
  const chosenHost = hostnameOf(chosen);
  const optOutUrl = chosenHost && looksLikeHost(chosenHost) ? chosen : '';
  return {
    name,
    optOutUrl,
    method: classifyMethod(optOutUrl),
    source,
    registries: [registryCode(source)],
  };
}

/**
 * The registry domain one row stands for: the registrable domain of its PRIMARY
 * WEBSITE, or [] when that cell gives none. This is what registryHosts holds, and
 * what DROP coverage later trusts, so it is deliberately narrow:
 *   - never the consumer-rights URL's host (it is often a OneTrust or Google Forms
 *     page that belongs to many companies);
 *   - never a shared form platform and never a bare public suffix (co.uk);
 *   - a cell that is not a dotted host name is ignored (registry cells are third-party
 *     text: "constructor" or "see our website" name no company).
 * Since 2.1 was never released, no feeds file written by the earlier code (which also
 * listed rights-URL hosts) exists outside development, so no migration is needed.
 * @param {Record<string,string>} row
 * @returns {string[]}
 */
function rowDomains(row) {
  const host = hostnameOf(normalizeUrl(pickField(row, URL_HEADERS)));
  if (!host || !looksLikeHost(host)) return [];
  const domain = registrableDomain(host);
  return isCoverableDomain(domain) ? [domain] : [];
}

/**
 * A page on a shared form platform is told apart by host AND path: three companies whose
 * rights pages are all privacyportal.onetrust.com/webform/<id> are three companies.
 */
function pageKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch (_) {
    return '';
  }
}

/**
 * The keys that say two feed rows are the same company. A company is its PRIMARY WEBSITE's
 * registrable domain (domainsOf gives it); the opt-out URL may be the rights page and says
 * nothing about identity when it sits on a shared form platform. A row with no usable
 * website falls back to its opt-out URL: the page itself on a shared platform, the
 * registrable domain otherwise.
 */
function identityKeys(broker, host, domainsOf) {
  const websites = domainsOf ? domainsOf(broker) : [];
  if (websites.length > 0) return websites;
  if (isSharedPlatformHost(host)) return [pageKey(broker.optOutUrl)];
  return [registrableDomain(host)];
}

/**
 * Dedupe normalized feed brokers by company (see identityKeys), dropping any whose
 * host collides with an explicit broker host (or with an earlier feed entry).
 * Entries with no parseable host (empty optOutUrl) are kept as-is - they are
 * manual rows that carry no dedupe key.
 * @param {Array<{name,optOutUrl,method,source}>} brokers
 * @param {Iterable<string>} explicitHosts  bare hostnames (www-stripped) from brokers.js
 * @param {(b:object)=>string[]} [domainsOf]  the primary-website domains a feed row stands for
 * @returns {Array<{name,optOutUrl,method,source}>}
 */
function dedupeFeedBrokers(brokers, explicitHosts, domainsOf) {
  const explicit = new Set(explicitHosts);
  const seen = new Set();
  const out = [];
  for (const b of brokers) {
    if (!b) continue;
    const host = hostnameOf(b.optOutUrl);
    if (!host) { out.push(b); continue; }
    // An explicit broker on a shared platform host says nothing about this company's page there.
    if (explicit.has(host) && !isSharedPlatformHost(host)) continue;
    const keys = identityKeys(b, host, domainsOf).filter(Boolean);
    if (keys.some(k => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(b);
  }
  return out;
}


const HTML_SNIFF = /^\s*<(?:!doctype\s+html|html|head|body)\b/i;

async function fetchText(url, fetchImpl) {
  const impl = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!impl) throw new Error('No fetch implementation available (Node 18+ global fetch or inject fetchImpl)');
  const init = { headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/csv,*/*;q=0.8' } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await impl(url, init);
  if (!res || !res.ok) {
    const status = res ? res.status : 'no-response';
    throw new Error(`Feed fetch failed for ${url}: HTTP ${status}`);
  }
  const type = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
  const body = await res.text();
  // A web app that answers 200 with its HTML shell is not a registry file.
  if (/html/i.test(type) || HTML_SNIFF.test(String(body).replace(/^\uFEFF/, ''))) {
    throw new Error(`Feed fetch for ${url} returned an HTML page, not a CSV file`);
  }
  return body;
}

/**
 * Fetch one registry and return its normalized rows plus, per row, the domains
 * it stands for. Throws (with a reason fit to print) when the fetch fails, the
 * answer is HTML, or no row parses.
 * @returns {Promise<{ rows: Array, hosts: string[][] }>}
 */
async function loadRegistry({ url, source, fetchImpl }) {
  const csv = await fetchText(url, fetchImpl);
  // An odd number of double quotes means one was never closed (an escaped quote is two), and
  // the parser then reads everything after it as one cell: a few rows would be reported as the
  // whole registry. Say so instead.
  if ((String(csv).match(/"/g) || []).length % 2 === 1) {
    throw new Error(`Feed for ${url} ends inside an unclosed quote, so rows after it were lost`);
  }
  const rows = [];
  const hosts = [];
  for (const raw of parseCsv(csv)) {
    const entry = normalizeFeedRow(raw, source);
    if (!entry) continue;
    rows.push(entry);
    hosts.push(rowDomains(raw));
  }
  if (rows.length === 0) throw new Error(`Feed for ${url} had no parseable rows`);
  return { rows, hosts };
}

/**
 * Fetch + normalize the California data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source,registries}>>}
 */
async function fetchCaRegistry(opts = {}) {
  const { rows } = await loadRegistry({ url: opts.url || CA_REGISTRY_URL, source: 'ca', fetchImpl: opts.fetchImpl });
  return rows;
}

/**
 * Fetch + normalize the Vermont data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source,registries}>>}
 */
async function fetchVtRegistry(opts = {}) {
  const { rows } = await loadRegistry({ url: opts.url || VT_REGISTRY_URL, source: 'vt', fetchImpl: opts.fetchImpl });
  return rows;
}

// The registries, in merge order (earlier wins a dedupe tie).
function registrySpecs(opts) {
  const vtUrl = opts.vtUrl || VT_REGISTRY_URL_OVERRIDE;
  return [
    { code: 'CA', source: 'ca', label: 'California', url: opts.caUrl || CA_REGISTRY_URL },
    { code: 'VT', source: 'vt', label: 'Vermont', url: vtUrl, skipReason: vtUrl ? '' : VT_SKIP_MESSAGE },
  ];
}

// The earlier file's host map, as a Map of domain to code list. Keys are third-party text, so
// anything that is not a coverable domain (including "constructor") is dropped here.
function previousRegistryHosts(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [host, codes] of Object.entries(raw)) {
    if (isCoverableDomain(host) && Array.isArray(codes)) out.set(host, codes);
  }
  return out;
}

// Accept the old bare-array feeds file as well as the current object.
function previousParts(previous) {
  if (Array.isArray(previous)) return { brokers: previous, registryHosts: new Map(), registries: {}, updatedAt: '' };
  const p = previous && typeof previous === 'object' ? previous : {};
  return {
    brokers: Array.isArray(p.brokers) ? p.brokers : [],
    registryHosts: previousRegistryHosts(p.registryHosts),
    registries: p.registries && typeof p.registries === 'object' ? p.registries : {},
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
  };
}

// How many brokers an earlier run found on this registry, or 0 when it never read it.
function earlierKnownCount(info) {
  if (!info || typeof info !== 'object') return 0;
  if (Number.isInteger(info.knownCount) && info.knownCount > 0) return info.knownCount;
  return info.ok === true && Number.isInteger(info.count) && info.count > 0 ? info.count : 0;
}

// The real California registry lists several hundred brokers. Fewer than this from the real URL
// means a cut-off, empty-ish or wrong file, not a small registry.
const CA_MIN_BROKERS = 100;

function caUrlOverridden(opts) {
  return Boolean(opts.caUrl || process.env.CA_REGISTRY_URL);
}

/**
 * Refuse a registry file that parsed but is implausible, by throwing (the caller treats a throw
 * as that registry failing: its earlier rows are kept and the run says so).
 *   - fewer than half of the earlier count: the file shrank or was cut off;
 *   - with no earlier count, a California count under CA_MIN_BROKERS from the real URL.
 */
function checkRegistrySize({ spec, count, earlier, overridden }) {
  if (earlier > 0 && count * 2 < earlier) {
    throw new Error(`Feed for ${spec.url} had ${count} broker(s), fewer than half of the ${earlier} the last good run found; the file looks cut off or damaged`);
  }
  if (earlier === 0 && spec.code === 'CA' && !overridden && count < CA_MIN_BROKERS) {
    throw new Error(`Feed for ${spec.url} had only ${count} broker(s); the real registry lists several hundred (at least ${CA_MIN_BROKERS}), so the file looks wrong`);
  }
}

function addHost(map, host, code) {
  if (!map.has(host)) map.set(host, new Set());
  map.get(host).add(code);
}

/**
 * Fetch every registry, merge, and dedupe against the explicit broker hosts.
 * Each registry succeeds or fails on its own. When one fails and the previous
 * feeds file had rows from it, those rows (and the hosts they covered) are
 * kept and marked carriedOver. Pure aside from the (injected) fetches; does NOT
 * write to disk - callers own the write.
 * @param {{ fetchImpl?: Function, explicitHosts?: Iterable<string>, previous?: object|Array|null,
 *           now?: Date, caUrl?: string, vtUrl?: string }} [opts]
 * @returns {Promise<{ brokers: Array, registryHosts: object, registries: object,
 *                     updatedAt: string, stats: { ca:number, vt:number, total:number } }>}
 */
async function buildFeedsFile(opts = {}) {
  const explicitHosts = opts.explicitHosts || [];
  const prev = previousParts(opts.previous);
  const stamp = (opts.now || new Date()).toISOString();
  const registries = {};
  const hostCodes = new Map();
  const pool = [];
  const domainsByRow = new Map();

  for (const spec of registrySpecs(opts)) {
    if (spec.skipReason) {
      registries[spec.code] = { label: spec.label, ok: false, skipped: true, count: 0, error: spec.skipReason };
      continue;
    }
    try {
      const { rows, hosts } = await loadRegistry({ url: spec.url, source: spec.source, fetchImpl: opts.fetchImpl });
      checkRegistrySize({ spec, count: rows.length, earlier: earlierKnownCount(prev.registries[spec.code]), overridden: spec.code === 'CA' && caUrlOverridden(opts) });
      rows.forEach((row, i) => {
        for (const d of hosts[i]) addHost(hostCodes, d, spec.code);
        domainsByRow.set(row, hosts[i]);
      });
      pool.push(...rows);
      registries[spec.code] = { label: spec.label, ok: true, count: rows.length, knownCount: rows.length, fetchedAt: stamp };
    } catch (err) {
      const earlier = prev.brokers.filter(b => b && b.source === spec.source);
      const prior = prev.registries[spec.code] || {};
      // How many brokers the registry had the last time it was read: DROP prints this, and a
      // failed run must not make the tool forget it.
      const knownCount = earlierKnownCount(prior);
      registries[spec.code] = {
        label: spec.label, ok: false, count: 0, knownCount, error: err.message,
        carriedOver: earlier.length > 0,
        carriedCount: earlier.length,
        fetchedAt: prior.fetchedAt || prev.updatedAt || '',
      };
      pool.push(...earlier);
      for (const [host, codes] of prev.registryHosts) {
        if (codes.includes(spec.code)) addHost(hostCodes, host, spec.code);
      }
    }
  }

  // Looked up through a Map: a host that came out of a third-party cell must never be able to
  // hit Object.prototype ("constructor"). The written object only ever holds dotted domains.
  const codesByHost = new Map([...hostCodes.keys()].sort().map(host => [host, [...hostCodes.get(host)].sort()]));
  const registryHosts = Object.fromEntries(codesByHost);

  const domainsOf = row => domainsByRow.get(row) || [];
  const merged = dedupeFeedBrokers(pool, explicitHosts, domainsOf).map((row) => {
    const codes = new Set(row.registries || [registryCode(row.source)]);
    const ownHost = hostnameOf(row.optOutUrl);
    // The opt-out page's own domain counts only when it is not a shared form platform.
    const domains = [...domainsOf(row), ...(ownHost && !isSharedPlatformHost(ownHost) ? [registrableDomain(ownHost)] : [])];
    for (const d of domains) for (const c of (codesByHost.get(d) || [])) codes.add(c);
    return { ...row, registries: [...codes].sort() };
  });

  return {
    brokers: merged,
    registryHosts,
    registries,
    updatedAt: stamp,
    stats: {
      ca: registries.CA.ok ? registries.CA.count : 0,
      vt: registries.VT.ok ? registries.VT.count : 0,
      total: merged.length,
    },
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

function readPreviousFeeds() {
  try { return JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8')); } catch (_) { return null; }
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

function registryLine(info) {
  if (info.skipped) return `  ${info.label}: skipped - ${info.error}.`;
  if (info.ok) return `  ${info.label}: ${plural(info.count, 'broker', 'brokers')}`;
  const base = `  ${info.label}: FAILED - ${info.error}.`;
  if (!info.carriedOver) return base;
  const date = info.fetchedAt ? info.fetchedAt.slice(0, 10) : 'an earlier run';
  return `${base} Kept ${info.carriedCount} earlier row(s) from ${date}.`;
}

/**
 * Orchestrate `aidr update-brokers`: derive explicit hosts, fetch + normalize +
 * dedupe the registries via buildFn, print one line per registry, and persist
 * via writeFn. All side-effecting deps are injected for testability.
 *
 * exitCode is 0 when at least one registry was read and 1 when none were: a run
 * where every registry failed writes nothing, so the earlier file stays as it
 * was instead of being replaced by an empty one.
 * @param {{
 *   brokers: Array,
 *   buildFn?: Function,
 *   writeFn?: (file:object) => void,
 *   readPreviousFn?: () => (object|Array|null),
 *   fetchImpl?: Function,
 *   now?: Date,
 *   logFn?: (msg:string) => void,
 * }} deps
 * @returns {Promise<{ brokers: Array, stats: object, file: object, exitCode: number }>}
 */
async function runUpdateBrokers(deps = {}) {
  const { brokers = [] } = deps;
  const buildFn = deps.buildFn || buildFeedsFile;
  const log = deps.logFn || (() => {});
  const writeFn = deps.writeFn || ((file) => {
    // AIDR_HOME/data does not exist until something writes into it.
    fs.mkdirSync(path.dirname(FEEDS_PATH), { recursive: true });
    fs.writeFileSync(FEEDS_PATH, JSON.stringify(file, null, 2));
  });
  const readPrevious = deps.readPreviousFn || readPreviousFeeds;
  const explicitHosts = explicitHostsOf(brokers);
  log('Fetching live broker registries...');
  const built = await buildFn({
    explicitHosts, fetchImpl: deps.fetchImpl, now: deps.now, previous: readPrevious(),
  });
  const file = {
    brokers: built.brokers,
    registryHosts: built.registryHosts || {},
    registries: built.registries || {},
    updatedAt: built.updatedAt || (deps.now || new Date()).toISOString(),
  };
  const infos = Object.values(file.registries);
  for (const info of infos) log(registryLine(info));
  const anyOk = infos.length === 0 || infos.some(i => i.ok);
  if (anyOk) {
    writeFn(file);
    log(`Wrote ${built.stats.total} deduped registry broker(s) to ${FEEDS_PATH}`);
  } else {
    log('Every registry failed; the earlier broker list was left unchanged.');
  }
  return { brokers: built.brokers, stats: built.stats, file, exitCode: anyOk ? 0 : 1 };
}

module.exports = {
  normalizeFeedRow,
  parseCsv,
  parseCsvRecords,
  parseCsvLine,
  mapHeaderRow,
  normalizeHeader,
  rowDomains,
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
