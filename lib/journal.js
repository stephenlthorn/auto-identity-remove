/**
 * lib/journal.js
 *
 * Crash-safe run journal (R3).
 *
 * The run log (logs/run-<ts>.json) is written once, after the last broker. A
 * crash, an OOM kill or `docker stop` therefore left no log at all: `--retry-failed`
 * had nothing to read and the audit trail had a hole. The journal is the same
 * information written as it happens, one JSON line per result, to
 * logs/run-<ts>.jsonl next to the summary.
 *
 *   {"type":"run","startedAt":"...","mode":"run","partial":false,"filter":null}
 *   {"broker":"Spokeo","status":"success","detail":"...","time":"...","person":"Jane Doe"}
 *   ...
 *   {"type":"end","finishedAt":"...","counts":{"succeeded":12,...}}
 *
 * Result lines are exactly the entries logResult() pushes into `results`, so
 * resultsFromJournal() can rebuild the same bucketed shape the rest of the code
 * already reads. `type` is reserved for the header and end lines.
 *
 * Crash behaviour: every append is ONE writeSync of ONE newline-terminated line
 * on an O_APPEND descriptor, so a kill never leaves a half-written earlier line
 * and nothing sits in a process buffer. Only the very last line can be torn;
 * readJournal() drops it. There is no per-append fsync: a process crash (the
 * case this guards) cannot lose bytes already handed to the kernel, and the
 * file is fsynced on close.
 *
 * The journal holds the user's name and the brokers that hold their data, so
 * it is created 0600 in a 0700 directory like every other run artifact.
 *
 * Journaling must never be the thing that kills a run: a failed write warns
 * once and the journal turns itself off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { mkdirPrivate, chmodPrivate, FILE_MODE } = require('./private-fs');
const { STATUS_BUCKET } = require('./logger');

// Derived from the logger's map so a new bucket there cannot drift out of the
// journal. `errors` is the logger's fallback for an unknown status.
const BUCKETS = [...new Set([...Object.values(STATUS_BUCKET), 'errors'])];

const bucketFor = status => STATUS_BUCKET[status] || 'errors';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The journal that sits next to a summary file: run-<ts>.json -> run-<ts>.jsonl.
 * @param {string} summaryPath
 * @returns {string}
 */
function journalPathFor(summaryPath) {
  return /\.json$/.test(summaryPath) ? `${summaryPath}l` : `${summaryPath}.jsonl`;
}

/**
 * Bucket sizes of a `results` object, for the journal's end line.
 * @param {object} results
 * @returns {Record<string, number>}
 */
function countResults(results) {
  const counts = {};
  for (const bucket of BUCKETS) counts[bucket] = Array.isArray(results && results[bucket]) ? results[bucket].length : 0;
  return counts;
}

/**
 * Open (creating if needed) an append-only run journal and write its header.
 *
 * @param {string} filePath  logs/run-<ts>.jsonl
 * @param {{ startedAt?: string, mode?: string|null, partial?: boolean, filter?: object|null }} [header]
 * @param {{ fs?: object, warn?: (message: string) => void }} [opts]  injection points for tests
 * @returns {{
 *   append: (entry: object) => boolean,
 *   close: (info?: { finishedAt?: string, counts?: object, interrupted?: boolean }) => void,
 * }}
 */
function openJournal(filePath, header, opts = {}) {
  const impl = opts.fs || fs;
  const warn = opts.warn || (message => console.error(message));
  const meta = header || {};

  const tally = Object.fromEntries(BUCKETS.map(bucket => [bucket, 0]));
  let fd = null;
  let closed = false;
  let failed = false;

  function fail(err) {
    failed = true;
    if (fd !== null) {
      try { impl.closeSync(fd); } catch (_) { /* already unusable */ }
      fd = null;
    }
    // The code, not the message: fs messages quote paths.
    warn(`journal: ${(err && err.code) || 'write failed'} - the run continues without a crash-safe journal`);
  }

  // One writeSync of one whole line. A short write (not seen on regular files)
  // is finished in a loop rather than leaving half a line.
  function writeLine(object) {
    const line = Buffer.from(`${JSON.stringify(object)}\n`, 'utf8');
    let offset = 0;
    while (offset < line.length) {
      offset += impl.writeSync(fd, line, offset, line.length - offset);
    }
  }

  function writeGuarded(object) {
    if (failed || fd === null) return false;
    try {
      writeLine(object);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  try {
    mkdirPrivate(path.dirname(filePath), { fs: impl });
    fd = impl.openSync(filePath, 'a', FILE_MODE);
    // `mode` only applies on create: a file left 0644 by something else is tightened.
    chmodPrivate(filePath, { fs: impl });
  } catch (err) {
    fail(err);
  }

  writeGuarded({
    type: 'run',
    startedAt: typeof meta.startedAt === 'string' && meta.startedAt ? meta.startedAt : new Date().toISOString(),
    mode: meta.mode === undefined ? null : meta.mode,
    partial: meta.partial === true,
    filter: meta.filter === undefined ? null : meta.filter,
  });

  return {
    append(entry) {
      if (closed || !isPlainObject(entry)) return false;
      // A circular or BigInt field would throw from stringify; skip that one
      // row rather than switching the whole journal off.
      try { JSON.stringify(entry); } catch (_) { return false; }
      if (!writeGuarded(entry)) return false;
      tally[bucketFor(entry.status)] += 1;
      return true;
    },

    close(info) {
      if (closed) return;
      closed = true;
      const { finishedAt, counts, interrupted } = info || {};
      const end = {
        type: 'end',
        finishedAt: typeof finishedAt === 'string' && finishedAt ? finishedAt : new Date().toISOString(),
        counts: isPlainObject(counts) ? counts : { ...tally },
      };
      if (interrupted) end.interrupted = true;
      writeGuarded(end);

      if (fd === null) return;
      try { impl.fsyncSync(fd); } catch (_) { /* best-effort: not every FS has fsync */ }
      try { impl.closeSync(fd); } catch (_) { /* nothing more to do */ }
      fd = null;
    },
  };
}

/**
 * Read a journal back, tolerating the damage a crash does.
 *
 * - A torn FINAL line (no trailing newline, not valid JSON) is dropped; it is
 *   the expected shape of a kill mid-write, so it is not reported as corruption.
 * - Any other line that is not a journal line is skipped and counted in
 *   `corruptLines`, so one bad line cannot take the rest of the run with it.
 * - `ended` is true only when an end line closes the file.
 *
 * @param {string} filePath
 * @returns {{ header: object|null, entries: object[], ended: boolean, end: object|null, corruptLines: number }|null}
 *   null when the file cannot be read.
 */
function readJournal(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }

  const rawLines = text.split('\n');
  const tornTailIndex = text.endsWith('\n') ? -1 : rawLines.length - 1;

  let header = null;
  let end = null;
  let corruptLines = 0;
  const entries = [];

  rawLines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      if (index !== tornTailIndex) corruptLines += 1;
      return;
    }

    if (!isPlainObject(parsed)) { corruptLines += 1; return; }

    if (parsed.type === 'run') {
      if (header === null) header = parsed;
      end = null;
      return;
    }
    if (parsed.type === 'end') {
      end = parsed;
      return;
    }
    if (typeof parsed.broker !== 'string' || typeof parsed.status !== 'string') { corruptLines += 1; return; }

    entries.push(parsed);
    end = null;
  });

  return { header, entries, ended: end !== null, end, corruptLines };
}

/**
 * Rebuild the bucketed `results` shape from a journal, bucketing with the same
 * STATUS_BUCKET map logResult() uses.
 *
 * The result is ALWAYS marked `partial`: this is the run that has no summary
 * JSON, and nothing vouches that it covered the whole broker list. The diff
 * therefore never takes it as a baseline. `crashed` says whether the process
 * actually died (no end line, or an interrupted one) as opposed to finishing
 * without managing to write its summary.
 *
 * @param {{ header?: object|null, entries?: object[], ended?: boolean, end?: object|null }|null} journal
 * @returns {object}
 */
function resultsFromJournal(journal) {
  const { header, entries, ended, end } = journal || {};

  const results = { runAt: (header && header.startedAt) || null };
  for (const bucket of BUCKETS) results[bucket] = [];
  for (const entry of entries || []) results[bucketFor(entry.status)].push(entry);

  results.partial = true;
  if (header && header.filter) results.filter = header.filter;
  results.crashed = !ended || Boolean(end && end.interrupted);
  results.source = 'journal';
  return results;
}

module.exports = {
  openJournal,
  readJournal,
  resultsFromJournal,
  journalPathFor,
  countResults,
  BUCKETS,
};
