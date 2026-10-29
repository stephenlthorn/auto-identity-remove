// test/report-pdf-private.test.js
/**
 * The monthly report PDF names the brokers that list the user and when, and it
 * is emailed as an attachment: it is a private file. Playwright writes it with
 * the process umask, so renderReportPdf tightens it to 0600 itself (the
 * private-files contract, codex #1).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderReportPdf } = require('../lib/report');

const posix = process.platform !== 'win32';

// A fake page whose pdf() writes the file the way Playwright does.
function context() {
  const page = {
    async setContent() {},
    async pdf(opts) { fs.writeFileSync(opts.path, '%PDF-1.4 stub'); },
    async close() {},
  };
  return { async newPage() { return page; } };
}

test('the report PDF is 0600 even under a permissive umask', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-report-'));
  const oldUmask = process.umask(0o022);
  try {
    const out = path.join(dir, 'report-2026-06-09.pdf');
    await renderReportPdf({ html: '<html></html>', outPath: out, context: context() });
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  } finally {
    process.umask(oldUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-running over last month\'s world-readable PDF tightens it', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-report-'));
  try {
    const out = path.join(dir, 'report-2026-06-09.pdf');
    fs.writeFileSync(out, 'old');
    fs.chmodSync(out, 0o644);
    await renderReportPdf({ html: '<html></html>', outPath: out, context: context() });
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a page.pdf that writes nothing (test doubles) does not make renderReportPdf throw', async () => {
  const page = { async setContent() {}, async pdf() {}, async close() {} };
  const out = path.join(os.tmpdir(), `aidr-never-written-${process.pid}.pdf`);
  const result = await renderReportPdf({ html: '', outPath: out, context: { async newPage() { return page; } } });
  assert.equal(result, out);
});
