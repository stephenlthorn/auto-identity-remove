'use strict';

/**
 * lib/audit.js
 *
 * Render a markdown audit report per run and write it to logs/.
 * Suitable as legal evidence of opt-out requests.
 */

const fs   = require('fs');
const path = require('path');

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

/**
 * Render a full markdown audit report.
 *
 * @param {{ person: object, timestamp: string, results: object }} opts
 * @returns {string}
 */
function renderAuditMarkdown({ person, timestamp, results }) {
  const dateStr = timestamp.slice(0, 10); // YYYY-MM-DD
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ');
  const emailPart = person.email ? ` (${person.email})` : '';

  const sections = [];

  sections.push(`# Opt-out audit - ${dateStr}`);
  sections.push('');
  sections.push(`**Requested by:** ${fullName}${emailPart}`);
  sections.push(`**Timestamp:** ${timestamp}`);

  const succeeded     = results.succeeded     || [];
  const pendingConfirm = results.pendingConfirm || [];
  const errors        = results.errors        || [];
  const notFound      = results.notFound      || [];
  const captchaFailed = results.captchaFailed || [];
  const manual        = results.manual        || [];

  if (succeeded.length > 0) {
    sections.push('');
    sections.push('## Submitted (form accepted)');
    sections.push(renderBrokerList(succeeded, dateStr));
  }

  if (pendingConfirm.length > 0) {
    sections.push('');
    sections.push('## Awaiting email confirmation');
    sections.push(renderBrokerList(pendingConfirm, dateStr));
  }

  if (notFound.length > 0) {
    sections.push('');
    sections.push('## Not found');
    sections.push(renderBrokerList(notFound, dateStr));
  }

  const manualAll = [...captchaFailed, ...manual];
  if (manualAll.length > 0) {
    sections.push('');
    sections.push('## Manual action required');
    sections.push(renderBrokerList(manualAll, dateStr));
  }

  if (errors.length > 0) {
    sections.push('');
    sections.push('## Errors');
    sections.push(renderBrokerList(errors, dateStr));
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
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf8');
  return filePath;
}

module.exports = { renderAuditMarkdown, writeAuditFile, timestampForFilename };
