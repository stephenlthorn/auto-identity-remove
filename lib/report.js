'use strict';

/**
 * lib/report.js
 *
 * Monthly opt-out report:
 *   - buildReportModel(opts)  pure data model (unit-tested, no I/O)
 *   - renderReportHtml(model) escaped HTML string (unit-tested)
 *   - renderReportPdf(opts)   Playwright-backed PDF writer (context injected)
 *
 * PDFs contain PII; they are written under logs/reports/ which is gitignored.
 */

const path = require('path');

const REPORT_DIR = path.join(__dirname, '..', 'logs', 'reports');

const STALE_PENDING_DAYS = 14;

function _daysBetween(laterIso, earlierMs) {
  return (earlierMs - new Date(laterIso).getTime()) / (1000 * 60 * 60 * 24);
}

function _isVerifiedClear(entry) {
  if (!entry || !entry.verifiedDeletedAt) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.verifiedDeletedAt).getTime() > new Date(entry.lastSuccess).getTime();
}

function _isStillListed(entry) {
  if (!entry || !entry.verifiedStillListedAt) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.verifiedStillListedAt).getTime() > new Date(entry.lastSuccess).getTime();
}

function _isPending(entry) {
  if (!entry || !entry.pendingConfirm || !entry.pendingConfirm.since) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.pendingConfirm.since).getTime() > new Date(entry.lastSuccess).getTime();
}

function _lastHistory(entry) {
  if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) return null;
  return entry.history[entry.history.length - 1];
}

function _scoreTrend(exposure) {
  if (!exposure || typeof exposure.total_brokers_appearing !== 'number') {
    return { current: null, previous: null, delta: null, direction: 'unknown' };
  }
  const current = exposure.total_brokers_appearing;
  const previous = typeof exposure.previous === 'number' ? exposure.previous : null;
  if (previous === null) {
    return { current, previous: null, delta: null, direction: 'unknown' };
  }
  const delta = current - previous;
  const direction = delta < 0 ? 'improving' : delta > 0 ? 'worsening' : 'flat';
  return { current, previous, delta, direction };
}

/**
 * Build the pure report data model.
 *
 * @param {object} opts
 * @param {{ optOuts?: Record<string, object> }} opts.state  config.js state object
 * @param {Array<{ name: string, expectedSender?: string }>} [opts.brokers]
 * @param {object} [opts.diff]      diffResults() output (optional, surfaced as-is)
 * @param {{ total_brokers_appearing?: number, previous?: number }} [opts.exposure]
 * @param {Date}   [opts.now]       injectable clock (default new Date())
 * @param {number} [opts.staleAfterDays]  pending-confirm staleness threshold (default 14)
 * @returns {object}
 */
function buildReportModel(opts = {}) {
  const { state = {}, brokers = [], diff = null, exposure = null } = opts;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const staleAfterDays = typeof opts.staleAfterDays === 'number' ? opts.staleAfterDays : STALE_PENDING_DAYS;
  const nowMs = now.getTime();

  const optOuts = (state && state.optOuts) || {};
  const brokerMap = new Map(brokers.map(b => [b.name, b]));

  const removedVerified = [];
  const submitted = [];
  const stillListed = [];
  const awaitingConfirmation = [];
  const errors = [];
  const actionsNeeded = [];

  for (const [key, entry] of Object.entries(optOuts)) {
    const brokerName = key.includes('|') ? key.slice(0, key.indexOf('|')) : key;

    if (_isVerifiedClear(entry)) {
      removedVerified.push({ broker: brokerName, verifiedAt: entry.verifiedDeletedAt });
    } else if (entry.lastSuccess) {
      submitted.push({ broker: brokerName, lastSuccess: entry.lastSuccess });
    }

    if (_isStillListed(entry)) {
      stillListed.push({ broker: brokerName, verifiedStillListedAt: entry.verifiedStillListedAt });
      actionsNeeded.push({ kind: 'still_listed', broker: brokerName, detail: 'This broker re-listed you after removal.' });
    }

    if (_isPending(entry)) {
      const expectedSender = (brokerMap.get(brokerName) || {}).expectedSender;
      awaitingConfirmation.push({ broker: brokerName, since: entry.pendingConfirm.since, expectedSender });
      const ageDays = _daysBetween(entry.pendingConfirm.since, nowMs);
      if (ageDays >= staleAfterDays) {
        actionsNeeded.push({ kind: 'confirm_email', broker: brokerName, detail: 'Click the confirmation link in the broker email.' });
      }
    }

    const last = _lastHistory(entry);
    if (last === 'error' || last === 'captcha_failed') {
      if (last === 'error') errors.push({ broker: brokerName, lastHistory: 'error' });
      actionsNeeded.push({ kind: 'manual', broker: brokerName, detail: 'Manual action needed - the automated submit could not complete.' });
    }
  }

  return {
    period: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    diff,
    removedVerified,
    submitted,
    stillListed,
    awaitingConfirmation,
    errors,
    actionsNeeded,
    scoreTrend: _scoreTrend(exposure),
  };
}

function _escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderList(items, mapFn) {
  if (!items || items.length === 0) return '<p class="empty">None.</p>';
  return '<ul>' + items.map(mapFn).join('') + '</ul>';
}

function _renderActions(actions) {
  if (!actions || actions.length === 0) {
    return '<p class="all-clear">Nothing needs your attention this month.</p>';
  }
  const label = { confirm_email: 'Confirm email', still_listed: 'Re-listed', manual: 'Manual action needed' };
  return '<ul class="actions">' + actions.map(a => {
    const tag = _escapeHtml(label[a.kind] || a.kind);
    return `<li><strong>${tag}:</strong> ${_escapeHtml(a.broker)} - ${_escapeHtml(a.detail)}</li>`;
  }).join('') + '</ul>';
}

/**
 * Render the report model to a self-contained, escaped HTML document.
 * @param {object} model  Output of buildReportModel.
 * @returns {string}
 */
function renderReportHtml(model) {
  const m = model || {};
  const trend = m.scoreTrend || { direction: 'unknown' };
  const trendLine = trend.direction === 'unknown'
    ? 'Exposure trend: not enough data yet.'
    : `Exposure trend: ${_escapeHtml(trend.direction)} (${_escapeHtml(trend.current)} brokers visible, was ${_escapeHtml(trend.previous)}).`;

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>Privacy report - ${_escapeHtml(m.period)}</title>`,
    '<style>',
    'body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:40px;line-height:1.5}',
    'h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}',
    'ul{margin:6px 0;padding-left:20px}.empty{color:#888;font-style:italic}',
    '.all-clear{color:#0a7d28;font-weight:600}.actions li{margin:4px 0}',
    '.trend{background:#f4f6fb;padding:10px 14px;border-radius:6px;margin:14px 0}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Monthly privacy report - ${_escapeHtml(m.period)}</h1>`,
    `<p class="trend">${trendLine}</p>`,
    '<h2>Things that need you</h2>',
    _renderActions(m.actionsNeeded),
    '<h2>Verified removed</h2>',
    _renderList(m.removedVerified, r => `<li>${_escapeHtml(r.broker)} (verified ${_escapeHtml((r.verifiedAt || '').slice(0, 10))})</li>`),
    '<h2>Submitted (awaiting verification)</h2>',
    _renderList(m.submitted, r => `<li>${_escapeHtml(r.broker)} (submitted ${_escapeHtml((r.lastSuccess || '').slice(0, 10))})</li>`),
    '<h2>Awaiting your email confirmation</h2>',
    _renderList(m.awaitingConfirmation, r => `<li>${_escapeHtml(r.broker)}${r.expectedSender ? ` (from ${_escapeHtml(r.expectedSender)})` : ''}</li>`),
    '<h2>Re-listed (still showing your data)</h2>',
    _renderList(m.stillListed, r => `<li>${_escapeHtml(r.broker)} (checked ${_escapeHtml((r.verifiedStillListedAt || '').slice(0, 10))})</li>`),
    '<h2>Errors</h2>',
    _renderList(m.errors, r => `<li>${_escapeHtml(r.broker)} (${_escapeHtml(r.lastHistory)})</li>`),
    '<p style="margin-top:30px;color:#888;font-size:12px">Submitted is not the same as confirmed deleted. Run node watcher.js --verify to spot-check.</p>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Build the absolute path for a report PDF.
 * @param {Date}   [now]  Defaults to new Date().
 * @param {string} [dir]  Output directory. Defaults to REPORT_DIR.
 * @returns {string}
 */
function reportPdfPath(now, dir) {
  const d = now instanceof Date ? now : new Date();
  const dateStr = d.toISOString().slice(0, 10);
  return path.join(dir || REPORT_DIR, `report-${dateStr}.pdf`);
}

/**
 * Render an HTML string to a PDF file using an injected Playwright context.
 * The context is injected so tests can supply a fake (no real browser).
 *
 * @param {object} opts
 * @param {string} opts.html
 * @param {string} opts.outPath
 * @param {{ newPage: function }} opts.context  Playwright browser context.
 * @returns {Promise<string>} outPath
 */
async function renderReportPdf({ html, outPath, context }) {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true });
    return outPath;
  } finally {
    await page.close();
  }
}

module.exports = {
  buildReportModel,
  renderReportHtml,
  renderReportPdf,
  reportPdfPath,
  REPORT_DIR,
  STALE_PENDING_DAYS,
  _escapeHtml,
};
