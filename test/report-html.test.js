'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel, renderReportHtml } = require('../lib/report');

const NOW = new Date('2026-06-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('renderReportHtml', () => {
  it('returns a full HTML document string', () => {
    const model = buildReportModel({ state: { optOuts: {} }, brokers: [], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<\/html>\s*$/);
    assert.match(html, /<style>/);
  });

  it('includes the reporting period in the document', () => {
    const model = buildReportModel({ state: { optOuts: {} }, brokers: [], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /2026-06/);
  });

  it('escapes HTML-special characters in broker-supplied text', () => {
    const state = {
      optOuts: {
        'Evil<script>': { pendingConfirm: { since: daysAgo(1) } },
      },
    };
    const brokers = [{ name: 'Evil<script>', expectedSender: 'a&b@"x".com' }];
    const model = buildReportModel({ state, brokers, now: NOW });
    const html = renderReportHtml(model);
    assert.ok(!html.includes('<script>'), 'raw <script> tag must not appear');
    assert.match(html, /Evil&lt;script&gt;/);
    assert.match(html, /a&amp;b@&quot;x&quot;\.com/);
  });

  it('renders an action list when actions are needed', () => {
    const state = {
      optOuts: {
        Radaris: { history: ['captcha_failed'] },
      },
    };
    const model = buildReportModel({ state, brokers: [{ name: 'Radaris' }], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /Radaris/);
    assert.match(html, /Manual action needed/);
  });

  it('renders an all-clear message when no actions are needed', () => {
    const state = {
      optOuts: {
        Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
      },
    };
    const model = buildReportModel({ state, brokers: [{ name: 'Spokeo' }], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /Nothing needs your attention|No action needed/i);
  });

  it('shows the score trend direction when exposure data is present', () => {
    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: { total_brokers_appearing: 2, previous: 5 },
    });
    const html = renderReportHtml(model);
    assert.match(html, /improving/i);
  });
});
