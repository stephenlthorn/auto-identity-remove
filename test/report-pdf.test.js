'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { renderReportPdf, reportPdfPath, REPORT_DIR } = require('../lib/report');

// A fake Playwright context/page that records calls and never touches a browser.
function makeFakeContext() {
  const calls = { setContent: [], pdf: [], closed: 0, newPage: 0 };
  const page = {
    async setContent(html, opts) { calls.setContent.push({ html, opts }); },
    async pdf(opts) { calls.pdf.push(opts); },
    async close() { calls.closed += 1; },
  };
  const context = {
    async newPage() { calls.newPage += 1; return page; },
  };
  return { context, calls };
}

describe('reportPdfPath', () => {
  it('builds logs/reports/report-<date>.pdf under REPORT_DIR by default', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    const p = reportPdfPath(now);
    assert.equal(p, path.join(REPORT_DIR, 'report-2026-06-09.pdf'));
  });

  it('honors an explicit output directory', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    const p = reportPdfPath(now, '/tmp/out');
    assert.equal(p, path.join('/tmp/out', 'report-2026-06-09.pdf'));
  });
});

describe('renderReportPdf', () => {
  it('opens a page, sets the html, writes the pdf, and closes the page', async () => {
    const { context, calls } = makeFakeContext();
    const out = '/tmp/report-test.pdf';
    const result = await renderReportPdf({ html: '<html>x</html>', outPath: out, context });

    assert.equal(result, out);
    assert.equal(calls.newPage, 1);
    assert.equal(calls.setContent.length, 1);
    assert.equal(calls.setContent[0].html, '<html>x</html>');
    assert.equal(calls.pdf.length, 1);
    assert.equal(calls.pdf[0].path, out);
    assert.equal(calls.closed, 1);
  });

  it('closes the page even if pdf() throws', async () => {
    const calls = { closed: 0 };
    const page = {
      async setContent() {},
      async pdf() { throw new Error('pdf boom'); },
      async close() { calls.closed += 1; },
    };
    const context = { async newPage() { return page; } };

    await assert.rejects(
      renderReportPdf({ html: '<html></html>', outPath: '/tmp/x.pdf', context }),
      /pdf boom/
    );
    assert.equal(calls.closed, 1);
  });
});
