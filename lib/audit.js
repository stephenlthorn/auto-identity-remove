'use strict';

/**
 * lib/audit.js
 *
 * Render a markdown audit report per run and write it to logs/.
 * Suitable as legal evidence of opt-out requests.
 */

const path = require('path');
const { personLabel } = require('./logger');
const { writePrivateFile, mkdirPrivate } = require('./private-fs');

/**
 * Render a section of broker entries as a markdown bullet list.
 *
 * @param {Array<{broker: string, detail?: string, time?: string}>} entries
 * @param {string} dateStr - YYYY-MM-DD used in bullet line.
 * @returns {string}
 */
function renderBrokerList(entries, dateStr) {
  return entries.map(r => {
    const detail = r.detail ? ` (${r.detail})` : '';
    return `- ${r.broker} - ${dateStr}${detail}`;
  }).join('\n');
}

const BUCKETS = ['succeeded', 'pendingConfirm', 'unverified', 'notFound', 'captchaFailed', 'manual', 'errors'];

/**
 * Markdown lines for one set of result buckets, with headings at `level`.
 * Empty sections are omitted.
 */
function renderSections(results, dateStr, level) {
  const mark = '#'.repeat(level);
  const lines = [];
  const add = (title, entries) => {
    if (entries.length === 0) return;
    lines.push('', `${mark} ${title}`, renderBrokerList(entries, dateStr));
  };

  add('Submitted (form accepted)', results.succeeded || []);
  add('Awaiting email confirmation', results.pendingConfirm || []);
  // The form went out but the result page was unreadable: evidence that a
  // request was made, not that it was accepted.
  add('Submitted, result unconfirmed', results.unverified || []);
  add('Not found', results.notFound || []);
  add('Manual action required', [...(results.captchaFailed || []), ...(results.manual || [])]);
  add('Errors', results.errors || []);
  return lines;
}

/** The results restricted to entries for one person label (null = entries with no person). */
function resultsForPerson(results, label) {
  const out = {};
  for (const bucket of BUCKETS) {
    out[bucket] = (results[bucket] || []).filter(r => (r.person || null) === label);
  }
  return out;
}

function identityLine(person) {
  const fullName = personLabel(person) || '';
  return person.email ? `${fullName} (${person.email})` : fullName;
}

/**
 * Render a full markdown audit report.
 *
 * With result entries tagged by person (logger.setCurrentPerson) and more than
 * one person in the run, each person gets their own section so one person's
 * success and another's error at the same broker are not merged (CFG-13).
 * Logs written before entries carried a person render the original flat layout.
 *
 * @param {{ person?: object, persons?: object[], timestamp: string, results: object }} opts
 * @returns {string}
 */
function renderAuditMarkdown({ person, persons, timestamp, results }) {
  const dateStr = timestamp.slice(0, 10); // YYYY-MM-DD
  const roster = (Array.isArray(persons) && persons.length > 0 ? persons : [person]).filter(Boolean);

  const taggedLabels = [];
  for (const bucket of BUCKETS) {
    for (const r of results[bucket] || []) {
      if (r.person && !taggedLabels.includes(r.person)) taggedLabels.push(r.person);
    }
  }
  const perPerson = taggedLabels.length > 1 || (taggedLabels.length === 1 && roster.length > 1);

  const sections = [];

  sections.push(`# Opt-out audit - ${dateStr}`);
  sections.push('');
  sections.push(`**Requested by:** ${roster.map(identityLine).join('; ')}`);
  sections.push(`**Timestamp:** ${timestamp}`);

  if (!perPerson) {
    sections.push(...renderSections(results, dateStr, 2));
    return sections.join('\n');
  }

  const rosterLabels = roster.map(p => personLabel(p));
  const labels = [...rosterLabels.filter(Boolean), ...taggedLabels.filter(l => !rosterLabels.includes(l))];
  for (const label of labels) {
    const owner = roster.find(p => personLabel(p) === label);
    sections.push('', `## ${owner ? identityLine(owner) : label}`);
    const body = renderSections(resultsForPerson(results, label), dateStr, 3);
    if (body.length === 0) {
      sections.push('', 'No results recorded for this person in this run.');
    } else {
      sections.push(...body);
    }
  }

  const unattributed = resultsForPerson(results, null);
  const unattributedBody = renderSections(unattributed, dateStr, 3);
  if (unattributedBody.length > 0) {
    sections.push('', '## Results not attributed to a person', ...unattributedBody);
  }

  return sections.join('\n');
}

/**
 * Convert an ISO timestamp to a filename-safe stamp: date + time down to the
 * second with ':' replaced by '-' (B8). Two runs on the same day no longer
 * collide, so intraday diffs survive instead of overwriting each other.
 *
 * '2026-05-19T10:00:00.000Z' -> '2026-05-19T10-00-00'
 *
 * @param {string} ts - ISO timestamp.
 * @returns {string}
 */
function timestampForFilename(ts) {
  return ts.slice(0, 19).replace(/:/g, '-');
}

/**
 * Write audit markdown to logsDir/audit-<YYYY-MM-DDTHH-MM-SS>.md.
 *
 * @param {string} logsDir - Directory to write into.
 * @param {string} markdown - Markdown content to write.
 * @param {string} [timestamp] - ISO timestamp used for the filename stamp. Defaults to now.
 * @returns {string} Absolute path of written file.
 */
function writeAuditFile(logsDir, markdown, timestamp) {
  const ts = timestamp || new Date().toISOString();
  const stamp = timestampForFilename(ts);
  const fileName = `audit-${stamp}.md`;
  const filePath = path.join(logsDir, fileName);
  // 0700 dir, 0600 file: the report holds the user's name, email and the list
  // of brokers that hold their data (CORE-9).
  mkdirPrivate(logsDir);
  writePrivateFile(filePath, markdown);
  return filePath;
}

module.exports = { renderAuditMarkdown, writeAuditFile, timestampForFilename };
