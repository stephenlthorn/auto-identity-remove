/**
 * dashboard/runs.js
 *
 * Run history for the dashboard: lists logs/run-*.json (the end-of-run summary
 * watcher.js writes) and logs/run-*.jsonl (the crash-safe journal, one result
 * per line), summarises each run and reads one run's per-broker rows.
 *
 * Pure of express, so the top-level `node --test` can cover it. Three things
 * shape it:
 *
 *  - The logs directory is user-writable and its files hold PII. A run id is
 *    matched against a strict pattern and then looked up with lstat, so no path
 *    is ever built from request text and a symlink cannot lead out of the
 *    directory. Whatever a file contains, it is parsed defensively: a torn
 *    journal line, a truncated summary or a wrong-shaped value costs that run,
 *    not the listing.
 *  - A broker result's `detail` can hold a full opt-out URL, and a URL's query
 *    string can hold PII (an email, a zip, a name). Nothing here returns one:
 *    every URL is reduced to its host.
 *  - Rows expose a fixed set of fields. Anything else an entry carries stays in
 *    the file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { STATUS_BUCKET } = require('../lib/logger');
const { classifyStatus } = require('./validate');
const { assignInitials } = require('./people');

const MAX_RUN_BYTES = 10 * 1024 * 1024; // same cap the log viewer applies
const MAX_ROWS = 5000;                  // rows returned for one run
const MAX_DETAIL = 300;
const MAX_FILTER_TEXT = 300;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CACHED = 300;

// No dots: a stem can never be "..", never carry an extension, never name a hidden file.
const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const RUN_FILE = /^(run-[A-Za-z0-9][A-Za-z0-9_-]{0,95})\.(json|jsonl)$/;
const STAMP = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/; // timestampForFilename(), UTC

// Run log bucket -> count key in the API. These are the arrays logger.js fills,
// in the order the summary file lists them.
const BUCKET_COUNT = {
  succeeded: 'submitted',
  skipped: 'skipped',
  notFound: 'notListed',
  captchaFailed: 'captchaFailed',
  manual: 'manual',
  errors: 'errors',
  dead: 'dead',
  pendingConfirm: 'pendingConfirm',
  unverified: 'unverified',
};
const BUCKETS = Object.keys(BUCKET_COUNT);

// The status a summary entry implies when it does not carry one: the first
// status the logger routes to that bucket ("skipped" before "preview").
const BUCKET_STATUS = {};
for (const [status, bucket] of Object.entries(STATUS_BUCKET)) {
  if (!(bucket in BUCKET_STATUS)) BUCKET_STATUS[bucket] = status;
}

const isRunId = id => typeof id === 'string' && RUN_ID.test(id);

function zeroCounts() {
  const counts = {};
  for (const b of BUCKETS) counts[BUCKET_COUNT[b]] = 0;
  return counts;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const clean = (text, max) => String(text).replace(CONTROL, ' ').trim().slice(0, max);

// ---- detail redaction ----------------------------------------------------------------

const MAILTO_WITH_QUERY = /\bmailto:[^\s?<>"')\]]*\?[^\s<>"')\]]*/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]*/gi;

/**
 * A broker result's detail with every URL reduced to its host. A query string or
 * path can hold the user's email, zip or name, and a mailto: link's query can be
 * a pre-filled message body, so those are cut as well. Control characters become
 * spaces and the length is capped.
 *
 * @param {*} text
 * @returns {string}  "" for anything that is not a string
 */
function redactDetail(text) {
  if (typeof text !== 'string') return '';
  let out = text.replace(CONTROL, ' ');
  out = out.replace(MAILTO_WITH_QUERY, m => m.slice(0, m.indexOf('?')));
  out = out.replace(URL_IN_TEXT, m => {
    try { return new URL(m).hostname || '[url]'; } catch (_) { return '[url]'; }
  });
  out = out.trim();
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}...` : out;
}

// ---- parsing -----------------------------------------------------------------------------

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

// One broker result as the rest of this module sees it, or null when it is not
// one. `bucket` is where the logger filed it, which is what a run's counts mean.
function toRow(raw, bucket, fallbackStatus) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const broker = typeof raw.broker === 'string' ? raw.broker : (typeof raw.name === 'string' ? raw.name : '');
  if (!broker.trim()) return null;
  const status = typeof raw.status === 'string' && raw.status ? raw.status : fallbackStatus;
  return {
    bucket: bucket || STATUS_BUCKET[status] || 'errors', // logger.logResult files an unknown status under errors
    broker: clean(broker, 120),
    person: typeof raw.person === 'string' && raw.person.trim() ? clean(raw.person, 120) : null,
    status: clean(status || '', 40),
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    host: typeof raw.host === 'string' && HOSTNAME.test(raw.host) ? raw.host : undefined,
    time: typeof raw.time === 'string' ? clean(raw.time, 30) : '',
  };
}

function normaliseFilter(partial, filter) {
  if (!partial) return null;
  const f = filter && typeof filter === 'object' && !Array.isArray(filter) ? filter : {};
  const text = v => (typeof v === 'string' && v.trim() ? clean(v, MAX_FILTER_TEXT) : null);
  return { only: text(f.only), skip: text(f.skip), retryFailed: !!f.retryFailed, resume: !!f.resume };
}

function parseSummary(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (_) { return { ok: false, error: 'unreadable' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'unrecognized' };
  const hasBucket = BUCKETS.some(b => Array.isArray(obj[b]));
  if (!hasBucket && typeof obj.runAt !== 'string') return { ok: false, error: 'unrecognized' };
  const rows = [];
  for (const bucket of BUCKETS) {
    if (!Array.isArray(obj[bucket])) continue;
    for (const raw of obj[bucket]) {
      const row = toRow(raw, bucket, BUCKET_STATUS[bucket]);
      if (row) rows.push(row);
    }
  }
  const partial = !!obj.partial;
  return { ok: true, rows, meta: { runAt: obj.runAt, partial, filter: normaliseFilter(partial, obj.filter) } };
}

// JSON Lines, one result per line. A crash can leave the last line torn, and the
// file is user-writable, so a line that does not parse (or is not a result) is
// skipped rather than failing the run.
function parseJournal(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch (_) { continue; }
    if (!raw || typeof raw.broker !== 'string' || typeof raw.status !== 'string') continue;
    const row = toRow(raw, null, raw.status);
    if (row) rows.push(row);
  }
  return { ok: true, rows, meta: { runAt: undefined, partial: false, filter: null } };
}

function readCapped(file, size) {
  if (size > MAX_RUN_BYTES) return { ok: false, error: 'too large' };
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch (_) { return { ok: false, error: 'unreadable' }; }
}

// ---- files -------------------------------------------------------------------------------

// lstat, not stat: a symlink in the logs directory must not lead anywhere.
function statRegular(dir, name) {
  try {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    return st.isFile() ? { file, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch (_) {
    return null;
  }
}

function statStem(dir, stem) {
  return { json: statRegular(dir, `${stem}.json`), jsonl: statRegular(dir, `${stem}.jsonl`) };
}

// Every run-*.json / run-*.jsonl regular file's stem, newest first.
function scanStems(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const stems = new Set();
  for (const ent of ents) {
    const m = ent.isFile() ? ent.name.match(RUN_FILE) : null;
    if (m) stems.add(m[1]);
  }
  // timestampForFilename() stamps sort chronologically as plain strings, which is
  // also how filter.loadLastLog picks "the last run".
  return [...stems].sort().reverse();
}

// The summary when it parses; otherwise the journal beside it, so a torn summary
// does not hide a run the journal can still describe.
function readStem(files) {
  let failure = null;
  for (const [source, f, parse] of [['summary', files.json, parseSummary], ['journal', files.jsonl, parseJournal]]) {
    if (!f) continue;
    const text = readCapped(f.file, f.size);
    const got = text.ok ? parse(text.text) : text;
    if (got.ok) return { ...got, source };
    failure = failure || { source, error: got.error };
  }
  return { ok: false, ...(failure || { source: 'summary', error: 'unreadable' }) };
}

// ---- summaries -----------------------------------------------------------------------------

function startedAtOf(stem, runAt, files) {
  if (typeof runAt === 'string' && !Number.isNaN(Date.parse(runAt))) return new Date(runAt).toISOString();
  const m = stem.match(STAMP);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  const mtime = (files.json || files.jsonl || {}).mtimeMs;
  return new Date(Number.isFinite(mtime) ? mtime : 0).toISOString();
}

function summarise(stem, files, read) {
  const base = { id: stem, complete: false, partial: false, filter: null, total: 0, counts: zeroCounts(), people: [], captchaSites: 0 };
  if (!read.ok) {
    return { ...base, startedAt: startedAtOf(stem, undefined, files), source: read.source, mode: 'unreadable', error: read.error };
  }
  const counts = zeroCounts();
  const sites = new Set();
  const order = [];
  const perPerson = new Map();
  for (const row of read.rows) {
    const key = BUCKET_COUNT[row.bucket] || 'errors';
    counts[key] += 1;
    if (row.bucket === 'captchaFailed') sites.add(row.broker);
    if (!row.person) continue;
    if (!perPerson.has(row.person)) { perPerson.set(row.person, { counts: zeroCounts(), total: 0 }); order.push(row.person); }
    const mine = perPerson.get(row.person);
    mine.counts[key] += 1;
    mine.total += 1;
  }
  const initials = assignInitials(order);
  const complete = read.source === 'summary';
  return {
    ...base,
    startedAt: startedAtOf(stem, read.meta.runAt, files),
    source: read.source,
    complete,
    mode: !complete ? 'incomplete' : (read.meta.partial ? 'partial' : 'full'),
    partial: read.meta.partial,
    filter: read.meta.filter,
    total: read.rows.length,
    counts,
    people: order.map(person => ({ person, initials: initials[person], counts: perPerson.get(person).counts, total: perPerson.get(person).total })),
    captchaSites: sites.size,
  };
}

// Parsing every run on every poll would re-read hundreds of KB per file; a run
// log never changes once written, so a summary is reused until its files do. Only
// the small summary is kept, never the rows.
const cache = new Map();
function describeStem(dir, stem) {
  const files = statStem(dir, stem);
  const sig = [files.json, files.jsonl].map(f => (f ? `${f.file}:${f.size}:${f.mtimeMs}` : '-')).join('|');
  if (cache.has(sig)) return cache.get(sig);
  const summary = summarise(stem, files, readStem(files));
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(sig, summary);
  return summary;
}

/**
 * One page of runs, newest first.
 * @param {string} logsDir
 * @param {{ limit?: *, offset?: * }} [page]
 */
function listRuns(logsDir, { limit, offset } = {}) {
  const lim = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const off = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const stems = scanStems(logsDir);
  const page = stems.slice(off, off + lim);
  return {
    runs: page.map(stem => describeStem(logsDir, stem)),
    total: stems.length,
    limit: lim,
    offset: off,
    hasMore: off + page.length < stems.length,
  };
}

/** The newest run, or null when there are none. */
function latestRun(logsDir) {
  return listRuns(logsDir, { limit: 1 }).runs[0] || null;
}

/**
 * One run: its summary plus a row per broker result, URLs reduced to hosts.
 * @param {string} logsDir
 * @param {*} id  untrusted; must be a run id
 * @returns {{ ok: true, run: object, rows: object[], truncated: boolean, rowCount: number }
 *          | { ok: false, status: number, error: string }}
 */
function readRun(logsDir, id) {
  if (!isRunId(id)) return { ok: false, status: 400, error: 'bad run id' };
  const files = statStem(logsDir, id);
  if (!files.json && !files.jsonl) return { ok: false, status: 404, error: 'run not found' };
  const read = readStem(files);
  if (!read.ok) return { ok: false, status: 422, error: `run log is ${read.error}` };
  const run = summarise(id, files, read);
  const initials = Object.fromEntries(run.people.map(p => [p.person, p.initials]));
  const rows = read.rows.slice(0, MAX_ROWS).map(r => {
    const out = {
      broker: r.broker,
      person: r.person,
      initials: r.person ? initials[r.person] : null,
      status: r.status,
      key: classifyStatus(r.status),
      detail: redactDetail(r.detail),
      time: r.time,
    };
    if (r.host) out.host = r.host;
    return out;
  });
  return { ok: true, run, rows, truncated: read.rows.length > MAX_ROWS, rowCount: read.rows.length };
}

module.exports = { listRuns, latestRun, readRun, redactDetail, isRunId, MAX_LIMIT, MAX_ROWS, MAX_RUN_BYTES };
