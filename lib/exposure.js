/**
 * lib/exposure.js
 *
 * Exposure Score: synthesizes the project's existing privacy signals into one
 * 0-100 number a non-technical person understands. Lower is better.
 *
 * Signals:
 *   - still-listed brokers   (state.optOuts entries verified still listed, or
 *                             submitted-but-never-verified)            10 pts each
 *   - SERP hits              (broker domains appearing in serp results,
 *                             weighted by best search rank)             4 pts/weight
 *   - breach exposure        (breachCount input, default 0)             8 pts each
 *
 * computeExposureScore is PURE (no I/O) and unit-tested across many state
 * shapes. snapshotExposure / loadExposureHistory persist a dated history to
 * data/exposure-history.json using the same tmp -> rename -> bak atomic-write
 * strategy as lib/config.js saveState. The history path is overridable in tests
 * via setTestExposureHistoryPath.
 *
 * The SERP and breach signals are persisted by their own runs (serp-history,
 * breach-result). loadPersistedSignals() reads both for --score / --report /
 * the dashboard: the SERP part reflects the LATEST conclusive scan, never an
 * all-time best (NET-13), and the breach count is the last real HIBP result
 * rather than a hard-coded 0.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { resolvePaths } = require('./paths');
const { mkdirPrivate, writePrivateFile } = require('./private-fs');

const DATA_DIR     = resolvePaths().data;
const HISTORY_PATH = path.join(DATA_DIR, 'exposure-history.json');
const BREACH_RESULT_PATH = path.join(DATA_DIR, 'breach-result.json');
const SERP_HISTORY_PATH  = path.join(DATA_DIR, 'serp-history.json');

// Point weights. Tuned so a single still-listed broker (10) reads as a clear
// signal, an above-the-fold SERP hit (weight 3 -> 12) is comparable, and a known
// breach (8) is meaningful but not dominant.
const LISTED_POINTS = 10;
const SERP_POINTS   = 4;
const BREACH_POINTS = 8;
const MAX_SCORE     = 100;
const HISTORY_MAX   = 120; // ~10 years of monthly snapshots; avoids unbounded growth

// Test-only override for the history file path. null means use HISTORY_PATH.
let _testHistoryPath = null;

function setTestExposureHistoryPath(p) {
  _testHistoryPath = p || null;
}

function _getHistoryPath() {
  return _testHistoryPath || HISTORY_PATH;
}

// Test-only override for the persisted breach result path.
let _testBreachPath = null;

function setTestBreachResultPath(p) {
  _testBreachPath = p || null;
}

function _getBreachPath() {
  return _testBreachPath || BREACH_RESULT_PATH;
}

/**
 * Decide whether a single state.optOuts entry represents a broker that is still
 * exposing the person's data.
 *
 * Still listed when EITHER:
 *   (a) verifiedStillListedAt exists AND it is newer than verifiedDeletedAt
 *       (or verifiedDeletedAt is absent), OR
 *   (b) lastSuccess exists AND the entry was never verified either way
 *       (submitted but unconfirmed -> treat as still exposed).
 *
 * @param {object} entry  a value from state.optOuts
 * @returns {boolean}
 */
function isStillListed(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const stillMs = entry.verifiedStillListedAt ? Date.parse(entry.verifiedStillListedAt) : NaN;
  const goneMs  = entry.verifiedDeletedAt ? Date.parse(entry.verifiedDeletedAt) : NaN;

  if (!Number.isNaN(stillMs)) {
    // Confirmed still listed unless a deletion was confirmed at the same time or later.
    if (Number.isNaN(goneMs) || stillMs > goneMs) return true;
    return false;
  }

  // No "still listed" verification. If a deletion was confirmed, it is gone.
  if (!Number.isNaN(goneMs)) return false;

  // Never verified either way: a recorded submission means it is still exposed.
  return !!entry.lastSuccess;
}

/**
 * Map a best (lowest) search rank to a SERP weight.
 *   rank 1-3   -> 3 (above the fold)
 *   rank 4-10  -> 2 (first page)
 *   rank 11+   -> 1
 *   unknown    -> 1
 *
 * @param {number|null|undefined} bestRankValue
 * @returns {number}
 */
function serpWeightForRank(bestRankValue) {
  if (typeof bestRankValue !== 'number' || !Number.isFinite(bestRankValue)) return 1;
  if (bestRankValue <= 3) return 3;
  if (bestRankValue <= 10) return 2;
  return 1;
}

/**
 * Return the best (lowest positive) numeric rank from a ranks object, or null.
 *
 * @param {{ ddg?: number|null, bing?: number|null, google?: number|null }} ranks
 * @returns {number|null}
 */
function bestRank(ranks) {
  if (!ranks || typeof ranks !== 'object') return null;
  const nums = [ranks.ddg, ranks.bing, ranks.google].filter(
    n => typeof n === 'number' && Number.isFinite(n) && n > 0
  );
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

/**
 * Compute the exposure score (PURE - no I/O).
 *
 * @param {object}   args
 * @param {object}   [args.state]        shared state object ({ optOuts: {...} })
 * @param {object[]} [args.serpResults]  runSerpScan summary.results array
 *                                       ([{ broker, ranks: {ddg,bing,google} }])
 * @param {number}   [args.breachCount]  number of known breaches (default 0)
 * @param {object[]} [args.brokers]      broker definitions (reserved; unused today)
 * @returns {{ score: number, breakdown: { listed: number, serp: number, breach: number },
 *             listedCount: number, serpHits: number, breachWeight: number }}
 */
function computeExposureScore(args) {
  const {
    state = { optOuts: {} },
    serpResults = [],
    breachCount = 0,
  } = (args || {});

  const optOuts = (state && state.optOuts && typeof state.optOuts === 'object') ? state.optOuts : {};

  let listedCount = 0;
  for (const entry of Object.values(optOuts)) {
    if (isStillListed(entry)) listedCount += 1;
  }

  const serpList = Array.isArray(serpResults) ? serpResults : [];
  let serpWeight = 0;
  for (const r of serpList) {
    serpWeight += serpWeightForRank(bestRank(r && r.ranks));
  }
  const serpHits = serpList.length;

  const breaches = Math.max(0, Math.floor(Number(breachCount) || 0));
  const breachWeight = breaches * BREACH_POINTS;

  const listedPoints = listedCount * LISTED_POINTS;
  const serpPoints   = serpWeight * SERP_POINTS;
  const rawPoints    = listedPoints + serpPoints + breachWeight;
  const score        = Math.min(MAX_SCORE, Math.round(rawPoints));

  return {
    score,
    breakdown: { listed: listedPoints, serp: serpPoints, breach: breachWeight },
    listedCount,
    serpHits,
    breachWeight,
  };
}

/**
 * Read the persisted exposure history. Returns [] on absent / unparseable /
 * wrong-shape files (never throws).
 *
 * @returns {Array<object>}
 */
function loadExposureHistory() {
  const p = _getHistoryPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Append a dated snapshot of a computeExposureScore summary to the history file
 * using an atomic tmp -> rename -> bak write (mirrors lib/config.js saveState).
 *
 * @param {object} summary  result of computeExposureScore
 * @param {object} [opts]
 * @param {Date}   [opts.now]  injectable clock for tests (default new Date())
 * @returns {object} the entry that was appended
 */
function snapshotExposure(summary, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const entry = {
    at: now.toISOString(),
    score: summary.score,
    breakdown: summary.breakdown,
    listedCount: summary.listedCount,
    serpHits: summary.serpHits,
    breachWeight: summary.breachWeight,
  };

  const history = loadExposureHistory();
  history.push(entry);
  const capped = history.slice(-HISTORY_MAX);

  const target = _getHistoryPath();
  const bak = target + '.bak';
  // Owner-only (CFG2-12). A directory that is already there is not ours to chmod.
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) mkdirPrivate(dir);
  const body = JSON.stringify(capped, null, 2);
  // Temp file + atomic rename: a kill mid-write leaves the original intact.
  writePrivateFile(target, body);
  // Rotate a backup AFTER the new file is safely in place (best-effort).
  try { writePrivateFile(bak, body); } catch (_) {}

  return entry;
}

// Rows written before scan ids existed are split into scans by time: the
// engines of one scan are seconds apart, scans themselves days apart.
const LEGACY_SCAN_GAP_MS = 60 * 60 * 1000;

/**
 * Group raw serp-history rows into scans.
 *   - rows with a scanId group by it; a marker row ({ scan: true,
 *     conclusive }) flags a scan that proved nothing (every engine blocked);
 *   - rows without one are clustered by time (undated rows form the oldest
 *     cluster, so a history with no timestamps at all is a single scan).
 * @returns {Array<{ ms: number, conclusive: boolean, rows: object[] }>}
 */
function _groupScans(rows) {
  const byId = new Map();
  const legacy = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const ms = Date.parse(row.scannedAt);
    if (row.scanId) {
      if (!byId.has(row.scanId)) byId.set(row.scanId, { ms: -Infinity, conclusive: true, rows: [] });
      const scan = byId.get(row.scanId);
      if (!Number.isNaN(ms)) scan.ms = Math.max(scan.ms, ms);
      if (row.scan === true && row.conclusive === false) scan.conclusive = false;
      if (row.broker && row.engine) scan.rows.push(row);
    } else if (row.broker && row.engine) {
      legacy.push({ row, ms: Number.isNaN(ms) ? -Infinity : ms });
    }
  }

  const scans = [...byId.values()];
  legacy.sort((x, y) => x.ms - y.ms);
  let current = null;
  let prevMs = -Infinity;
  for (const { row, ms } of legacy) {
    const startsNewScan = current === null || (Number.isFinite(ms) && ms - prevMs > LEGACY_SCAN_GAP_MS)
      || (Number.isFinite(ms) !== Number.isFinite(prevMs));
    if (startsNewScan) {
      current = { ms, conclusive: true, rows: [] };
      scans.push(current);
    }
    current.rows.push(row);
    current.ms = Math.max(current.ms, ms);
    prevMs = ms;
  }
  return scans;
}

/**
 * Collapse raw serp-history rows (as written by lib/serp-scan.js
 * appendManyToHistory: { scanId, broker, engine, rank, ... }) into the
 * runSerpScan-style results array, using the LATEST CONCLUSIVE scan only and
 * keeping the best (lowest) rank per broker per engine within it.
 *
 * The all-time best rank made a broker seen once in an old scan count forever,
 * so the SERP part of the score could never improve (NET-13). A later scan in
 * which every engine was blocked is skipped, not treated as "clean": it proved
 * nothing, so the last usable scan still stands.
 *
 * @param {Array<{ broker?: string, engine?: string, rank?: number }>} rows
 * @returns {Array<{ broker: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>}
 */
function serpResultsFromHistory(rows) {
  if (!Array.isArray(rows)) return [];

  const usable = _groupScans(rows).filter(scan => scan.conclusive);
  if (usable.length === 0) return [];
  const latest = usable.reduce((best, scan) => (scan.ms >= best.ms ? scan : best));

  const byBroker = new Map();
  for (const row of latest.rows) {
    const rank = (typeof row.rank === 'number' && Number.isFinite(row.rank)) ? row.rank : null;
    if (rank === null) continue;
    if (!byBroker.has(row.broker)) {
      byBroker.set(row.broker, { ddg: null, bing: null, google: null });
    }
    const ranks = byBroker.get(row.broker);
    if (!(row.engine in ranks)) continue; // ignore unknown engines
    if (ranks[row.engine] === null || rank < ranks[row.engine]) {
      ranks[row.engine] = rank;
    }
  }
  return [...byBroker.entries()].map(([broker, ranks]) => ({ broker, ranks }));
}

// -- Persisted breach result ---------------------------------------------------
// --breach-check used to print and forget, so --score and --report hard-coded
// breachCount: 0. recordBreachResult keeps the last count (and nothing else:
// no email addresses, no breach names) for them to read.

/**
 * @returns {{ at: string, totalBreaches: number, inconclusive: boolean }|null}
 */
function loadBreachResult() {
  try {
    const parsed = JSON.parse(fs.readFileSync(_getBreachPath(), 'utf8'));
    const total = Number(parsed && parsed.totalBreaches);
    if (!Number.isFinite(total) || total < 0) return null;
    return { at: parsed.at || null, totalBreaches: Math.floor(total), inconclusive: !!parsed.inconclusive };
  } catch (_) {
    return null;
  }
}

/** The last recorded breach count; 0 when no check has been recorded. */
function loadBreachCount() {
  const result = loadBreachResult();
  return result ? result.totalBreaches : 0;
}

/**
 * Persist the outcome of a runBreachCheck result. An inconclusive check (a
 * failed lookup) never lowers the stored count: a rate-limited run is not an
 * improvement. A conclusive check replaces it, up or down.
 *
 * @param {{ totalBreaches?: number, inconclusive?: boolean }} result  runBreachCheck result
 * @param {{ now?: Date }} [opts]
 * @returns {{ at: string, totalBreaches: number, inconclusive: boolean }}
 */
function recordBreachResult(result, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const found = Math.max(0, Math.floor(Number(result && result.totalBreaches) || 0));
  const inconclusive = !!(result && result.inconclusive);
  const prior = loadBreachResult();
  const totalBreaches = inconclusive && prior ? Math.max(prior.totalBreaches, found) : found;

  const entry = { at: now.toISOString(), totalBreaches, inconclusive };
  const target = _getBreachPath();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (_) { /* filesystem without modes */ }
  return entry;
}

/**
 * The two persisted signals computeExposureScore needs, in one call:
 *   computeExposureScore({ state, brokers, ...loadPersistedSignals() })
 *
 * @param {{ serpHistoryPath?: string }} [opts]
 * @returns {{ serpResults: object[], breachCount: number }}
 */
function loadPersistedSignals(opts = {}) {
  let rows = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(opts.serpHistoryPath || SERP_HISTORY_PATH, 'utf8'));
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (_) { rows = []; }
  return { serpResults: serpResultsFromHistory(rows), breachCount: loadBreachCount() };
}

/**
 * Build a human-readable multi-line report for the --score CLI mode.
 * Trend is computed against the most recent prior history entry; lower is
 * better, so a negative delta is an improvement.
 *
 * @param {object} summary  result of computeExposureScore
 * @param {Array<{ score: number }>} history  prior snapshots (chronological)
 * @returns {string}
 */
function formatScoreReport(summary, history) {
  const lines = [];
  const bar = '='.repeat(54);
  lines.push(bar);
  lines.push(`Exposure score: ${summary.score} / 100  (lower is better)`);
  lines.push(bar);
  lines.push(`  still-listed brokers : ${summary.listedCount}  (+${summary.breakdown.listed} pts)`);
  lines.push(`  search-result hits   : ${summary.serpHits}  (+${summary.breakdown.serp} pts)`);
  lines.push(`  breach exposure      : ${summary.breakdown.breach / BREACH_POINTS}  (+${summary.breakdown.breach} pts)`);

  const prior = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
  if (!prior || typeof prior.score !== 'number') {
    lines.push('  trend                : (no previous snapshot to compare)');
  } else {
    const delta = summary.score - prior.score;
    const sign = delta > 0 ? '+' : '';
    let verdict;
    if (delta < 0) verdict = 'improved (down) since last snapshot';
    else if (delta > 0) verdict = 'worse (up) since last snapshot';
    else verdict = 'unchanged since last snapshot';
    lines.push(`  trend                : ${sign}${delta} vs ${prior.score} - ${verdict}`);
  }
  lines.push(bar);
  return lines.join('\n');
}

/**
 * Adapt a computeExposureScore summary + prior history into the shape that
 * buildReportModel's _scoreTrend helper expects:
 *   { total_brokers_appearing: number, previous: number|null }
 *
 * total_brokers_appearing = summary.listedCount (brokers still exposing data).
 * previous = the listedCount from the most recent prior history entry, or null
 * when no history is available.
 *
 * @param {object} summary  result of computeExposureScore
 * @param {Array<{ listedCount?: number }>|null|undefined} history  prior snapshots
 * @returns {{ total_brokers_appearing: number, previous: number|null }}
 */
function exposureToReportAdapter(summary, history) {
  const arr = Array.isArray(history) ? history : [];
  const prior = arr.length > 0 ? arr[arr.length - 1] : null;
  const previous = prior != null && typeof prior.listedCount === 'number'
    ? prior.listedCount
    : null;
  return {
    total_brokers_appearing: summary.listedCount,
    previous,
  };
}

module.exports = {
  computeExposureScore,
  snapshotExposure,
  loadExposureHistory,
  setTestExposureHistoryPath,
  setTestBreachResultPath,
  serpResultsFromHistory,
  loadBreachCount,
  recordBreachResult,
  loadPersistedSignals,
  formatScoreReport,
  exposureToReportAdapter,
  // exported for potential reuse / targeted tests
  isStillListed,
  serpWeightForRank,
  bestRank,
  HISTORY_PATH,
};
