/**
 * scripts/prune-dead.js
 *
 * Reads all logs/run-*.json files, finds hostnames that appear with
 * status:'dead' in EVERY run they appear in (and appear at least once),
 * then merges them into data/dead-urls.json.
 *
 * Idempotent — running twice produces no change.
 * Exported `pruneDeadUrls(logsDir, deadUrlsPath)` is a pure function for
 * testability (takes explicit paths; no side-effects beyond writing the file).
 *
 * Usage:
 *   node scripts/prune-dead.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * Aggregate dead hostnames from log files in `logsDir`.
 * A hostname is "consistently dead" if every entry for that host across all
 * log files has status 'dead' (and it appears at least once).
 *
 * @param {string} logsDir      - Directory containing run-*.json files
 * @param {string} deadUrlsPath - Path to data/dead-urls.json
 * @returns {{ added: string[], total: number }} Summary of changes made
 */
function pruneDeadUrls(logsDir, deadUrlsPath) {
  // ── 1. Load existing dead set ──────────────────────────────────────────────
  let existing = [];
  try {
    const raw = JSON.parse(fs.readFileSync(deadUrlsPath, 'utf8'));
    existing = Array.isArray(raw.hosts) ? raw.hosts : [];
  } catch (_) {
    existing = [];
  }
  const existingSet = new Set(existing);

  // ── 2. Read all run-*.json log files ──────────────────────────────────────
  let logFiles = [];
  try {
    logFiles = fs.readdirSync(logsDir)
      .filter(f => /^run-.*\.json$/.test(f))
      .map(f => path.join(logsDir, f));
  } catch (_) {
    // logs dir missing — nothing to prune
  }

  // ── 3. Aggregate: for each hostname, track {dead, total} across all runs ──
  // Maps hostname → { deadCount: number, totalCount: number }
  const hostStats = new Map();

  for (const logFile of logFiles) {
    let entries;
    try {
      const raw = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      // Support both array-of-entries and { results: [...] } shapes
      entries = Array.isArray(raw) ? raw : (Array.isArray(raw.results) ? raw.results : []);
    } catch (_) {
      continue; // skip malformed files
    }

    for (const entry of entries) {
      if (!entry || typeof entry.broker !== 'string') continue;

      // Derive hostname from broker field (may be a hostname already or a URL)
      let host;
      try {
        // If it looks like a full URL, parse it; otherwise treat as hostname directly
        if (entry.broker.startsWith('http')) {
          host = new URL(entry.broker).hostname.replace(/^www\./, '');
        } else {
          host = entry.broker.replace(/^www\./, '');
        }
      } catch (_) {
        host = entry.broker.replace(/^www\./, '');
      }

      if (!host) continue;

      const stats = hostStats.get(host) || { deadCount: 0, totalCount: 0 };
      stats.totalCount += 1;
      if (entry.status === 'dead') stats.deadCount += 1;
      hostStats.set(host, stats);
    }
  }

  // ── 4. Identify consistently-dead hosts (dead in 100% of their appearances) ─
  const newlyDead = [];
  for (const [host, { deadCount, totalCount }] of hostStats) {
    if (totalCount > 0 && deadCount === totalCount && !existingSet.has(host)) {
      newlyDead.push(host);
    }
  }

  // ── 5. Merge, dedup, sort, write ──────────────────────────────────────────
  const merged = [...existingSet, ...newlyDead].sort();
  fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: merged }, null, 2) + '\n', 'utf8');

  return { added: newlyDead.sort(), total: merged.length };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const root        = path.join(__dirname, '..');
  const logsDir     = path.join(root, 'logs');
  const deadUrlsPath = path.join(root, 'data', 'dead-urls.json');

  const { added, total } = pruneDeadUrls(logsDir, deadUrlsPath);

  if (added.length === 0) {
    console.log(`prune-dead: no new hosts added (${total} already cached).`);
  } else {
    console.log(`prune-dead: added ${added.length} host(s) → ${total} total in dead-urls.json`);
    for (const h of added) console.log(`  + ${h}`);
  }
}

module.exports = { pruneDeadUrls };
