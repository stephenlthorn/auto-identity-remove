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

module.exports = {
  buildReportModel,
  REPORT_DIR,
  STALE_PENDING_DAYS,
};
