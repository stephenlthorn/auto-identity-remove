/**
 * scripts/prune-dead.js
 *
 * Reads logs/run-*.json and adds hosts that are provably gone to
 * data/dead-urls.json, which makes every later run skip them without a request.
 * Run it by hand; nothing calls it automatically.
 *
 * Adding a live broker to that file silently stops the user being opted out of
 * it, so the bar is deliberately high. A host is added only when its most recent
 * history is an unbroken streak of HARD failures - DNS name not resolved
 * (ERR_NAME_NOT_RESOLVED / ENOTFOUND) or HTTP 404 / 410 - across at least
 * MIN_RUNS separate runs spanning at least MIN_SPAN_DAYS days. One outage, a
 * refused connection, a timeout or a 5xx never counts, and a single run in which
 * the host answered ends the streak.
 *
 * Run-log shape (what watcher.js writes - see lib/logger.js): one object per
 * run, bucketed by outcome:
 *   { runAt, succeeded: [], skipped: [], notFound: [], captchaFailed: [],
 *     manual: [], errors: [], dead: [], pendingConfirm: [], genericStats }
 * Every entry is { broker, status, detail, time } and, for generic-pass entries,
 * a `host`. Only entries that identify a host are considered: `entry.host`, or
 * `entry.broker` when that is itself a bare hostname (BADBOOL rows are named by
 * their host). A company name such as "Acxiom" is never treated as a hostname.
 *
 * Idempotent - running twice produces no change.
 * Exported `pruneDeadUrls(logsDir, deadUrlsPath)` takes explicit paths for
 * testability.
 *
 * Usage:
 *   node scripts/prune-dead.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const MIN_RUNS = 3;
const MIN_SPAN_DAYS = 14;
// A run in which MORE than this share of the hosts that were actually tried failed
// hard is a machine that was offline (or whose resolver was down), not evidence about
// any one host: it is left out of every host's history. Only judged once a run has at
// least MIN_HOSTS_FOR_OUTAGE_CHECK hosts, so a small log of a few really dead hosts is
// not mistaken for an outage.
const MAX_HARD_SHARE = 0.5;
const MIN_HOSTS_FOR_OUTAGE_CHECK = 10;
const DAY_MS = 24 * 3600 * 1000;

// DNS name not resolved, or the page is gone. Not refused/closed connections,
// timeouts or 5xx: those are what an outage looks like.
const HARD_FAILURE = /ERR_NAME_NOT_RESOLVED|ENOTFOUND|\bHTTP (404|410)\b/;
// The generic runner short-circuits hosts already in dead-urls.json; that entry
// is a cache hit, not a new observation.
const CACHED_SKIP = /cached dead-url/i;
const BARE_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Normalised hostname for an entry, or null when it does not identify one. */
function hostOf(entry) {
  const candidate = typeof entry.host === 'string' && entry.host ? entry.host : entry.broker;
  if (typeof candidate !== 'string') return null;
  let host = candidate.trim();
  if (/^https?:\/\//i.test(host)) {
    try { host = new URL(host).hostname; } catch (_) { return null; }
  }
  host = host.toLowerCase().replace(/^www\./, '');
  return BARE_HOSTNAME.test(host) ? host : null;
}

/** Every entry in a run log: bucketed object, { results: [] }, or a flat array. */
function entriesOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.results)) return raw.results;
  return Object.values(raw).filter(Array.isArray).flat();
}

/** When the run happened: runAt, else the file name's timestamp, else mtime. */
function runTime(raw, file) {
  const runAt = raw && !Array.isArray(raw) ? Date.parse(raw.runAt) : NaN;
  if (!Number.isNaN(runAt)) return runAt;
  const m = path.basename(file).match(/run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    const fromName = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    if (!Number.isNaN(fromName)) return fromName;
  }
  return fs.statSync(file).mtimeMs;
}

/**
 * What one run says about one host: 'hard' (only hard failures), 'other' (it
 * answered, or failed in a way that proves nothing), or null (only cache hits).
 */
function runVerdict(entries) {
  let sawHard = false;
  for (const e of entries) {
    if (e.status === 'dead' && CACHED_SKIP.test(String(e.detail || ''))) continue;
    if (e.status === 'dead' && HARD_FAILURE.test(String(e.detail || ''))) { sawHard = true; continue; }
    return 'other';
  }
  return sawHard ? 'hard' : null;
}

/**
 * @param {string} logsDir      - Directory containing run-*.json files
 * @param {string} deadUrlsPath - Path to data/dead-urls.json
 * @returns {{ added: string[], total: number, ignoredRuns: number }} Summary of changes made;
 *   ignoredRuns counts runs left out as outages (most hosts failed hard)
 */
function pruneDeadUrls(logsDir, deadUrlsPath) {
  let existing = [];
  try {
    const raw = JSON.parse(fs.readFileSync(deadUrlsPath, 'utf8'));
    existing = Array.isArray(raw.hosts) ? raw.hosts : [];
  } catch (_) {
    existing = [];
  }
  const existingSet = new Set(existing);

  let logFiles = [];
  try {
    logFiles = fs.readdirSync(logsDir)
      .filter(f => /^run-.*\.json$/.test(f))
      .map(f => path.join(logsDir, f));
  } catch (_) {
    // logs dir missing - nothing to prune
  }

  // host -> [{ at, verdict }], one item per run
  const history = new Map();
  let ignoredRuns = 0;
  for (const file of logFiles) {
    let raw;
    let at;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      at = runTime(raw, file);
    } catch (_) {
      continue; // malformed or unreadable file
    }

    const byHost = new Map();
    for (const entry of entriesOf(raw)) {
      if (!entry || typeof entry !== 'object') continue;
      const host = hostOf(entry);
      if (!host) continue;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(entry);
    }
    const verdicts = [];
    for (const [host, entries] of byHost) {
      const verdict = runVerdict(entries);
      if (verdict) verdicts.push({ host, verdict });
    }
    const hardCount = verdicts.filter((v) => v.verdict === 'hard').length;
    if (verdicts.length >= MIN_HOSTS_FOR_OUTAGE_CHECK && hardCount / verdicts.length > MAX_HARD_SHARE) {
      ignoredRuns++;
      continue;
    }
    for (const { host, verdict } of verdicts) {
      if (!history.has(host)) history.set(host, []);
      history.get(host).push({ at, verdict });
    }
  }

  const newlyDead = [];
  for (const [host, runs] of history) {
    if (existingSet.has(host)) continue;
    runs.sort((a, b) => a.at - b.at);
    const streak = [];
    for (let i = runs.length - 1; i >= 0 && runs[i].verdict === 'hard'; i--) streak.unshift(runs[i]);
    if (streak.length < MIN_RUNS) continue;
    if (streak[streak.length - 1].at - streak[0].at < MIN_SPAN_DAYS * DAY_MS) continue;
    newlyDead.push(host);
  }

  const merged = [...existingSet, ...newlyDead].sort();
  if (newlyDead.length > 0) {
    fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: merged }, null, 2) + '\n', 'utf8');
  }

  return { added: newlyDead.sort(), total: merged.length, ignoredRuns };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const root         = path.join(__dirname, '..');
  const logsDir      = path.join(root, 'logs');
  const deadUrlsPath = path.join(root, 'data', 'dead-urls.json');

  const { added, total, ignoredRuns } = pruneDeadUrls(logsDir, deadUrlsPath);
  if (ignoredRuns > 0) {
    console.log(`prune-dead: ignored ${ignoredRuns} run(s) in which most hosts failed (an outage, not evidence about any host).`);
  }

  if (added.length === 0) {
    console.log(`prune-dead: no new hosts added (${total} already cached).`);
  } else {
    console.log(`prune-dead: added ${added.length} host(s) → ${total} total in dead-urls.json`);
    for (const h of added) console.log(`  + ${h}`);
  }
}

module.exports = { pruneDeadUrls, MIN_RUNS, MIN_SPAN_DAYS };
