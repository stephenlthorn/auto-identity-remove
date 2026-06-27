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
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'exposure-history.json');

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
  const tmp = target + '.tmp';
  const bak = target + '.bak';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write to .tmp first so a kill mid-write leaves the original intact.
  fs.writeFileSync(tmp, JSON.stringify(capped, null, 2));
  // Single atomic rename: on POSIX the target is never absent.
  fs.renameSync(tmp, target);
  // Rotate a backup AFTER the new file is safely in place (best-effort).
  try { fs.copyFileSync(target, bak); } catch (_) {}

  return entry;
}

/**
 * Collapse raw serp-history rows (as written by lib/serp-scan.js
 * appendToHistory: { broker, engine, rank, ... }) into the
 * runSerpScan-style results array, keeping the best (lowest) rank per
 * broker per engine. Lets --score reconstruct a SERP signal from the
 * persisted history without running a live scan.
 *
 * @param {Array<{ broker?: string, engine?: string, rank?: number }>} rows
 * @returns {Array<{ broker: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>}
 */
function serpResultsFromHistory(rows) {
  if (!Array.isArray(rows)) return [];
  const byBroker = new Map();
  for (const row of rows) {
    if (!row || !row.broker || !row.engine) continue;
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
  serpResultsFromHistory,
  formatScoreReport,
  exposureToReportAdapter,
  // exported for potential reuse / targeted tests
  isStillListed,
  serpWeightForRank,
  bestRank,
  HISTORY_PATH,
};
