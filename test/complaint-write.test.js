// test/complaint-write.test.js
/**
 * Tests lib/complaint.js writeComplaintFiles().
 *
 * Writes .txt files to a real temp dir (cleaned up after) and verifies the PDF
 * path uses an INJECTED page factory - no real Playwright browser is launched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeComplaintFiles } = require('../lib/complaint');

function makeEntries() {
  return [
    {
      broker: 'Spokeo',
      complaints: [
        { agency: 'CA_AG', subject: 'S1', body: 'CA AG body for Spokeo' },
        { agency: 'FTC', subject: 'S2', body: 'FTC body for Spokeo' },
      ],
    },
  ];
}

test('writes one .txt per complaint into outDir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    const caTxt = path.join(dir, 'Spokeo-CA_AG.txt');
    const ftcTxt = path.join(dir, 'Spokeo-FTC.txt');
    assert.ok(fs.existsSync(caTxt), 'CA AG txt should exist');
    assert.ok(fs.existsSync(ftcTxt), 'FTC txt should exist');
    assert.equal(fs.readFileSync(caTxt, 'utf8'), 'CA AG body for Spokeo');
    assert.ok(written.includes(caTxt));
    assert.ok(written.includes(ftcTxt));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creates outDir when it does not exist', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  const dir = path.join(base, 'nested', 'complaints');
  try {
    await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    assert.ok(fs.existsSync(dir), 'nested outDir should be created');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('when newPage is provided, renders PDF via setContent + page.pdf and records the path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  const pdfCalls = [];
  const setContentCalls = [];
  let closes = 0;

  const newPage = async () => ({
    setContent: async (html, opts) => { setContentCalls.push({ html, opts }); },
    pdf: async (opts) => {
      pdfCalls.push(opts);
      fs.writeFileSync(opts.path, '%PDF-1.4 stub'); // emulate Playwright writing the file
    },
    close: async () => { closes += 1; },
  });

  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries(), newPage });

    assert.equal(setContentCalls.length, 2, 'one setContent per complaint');
    assert.equal(pdfCalls.length, 2, 'one pdf per complaint');
    assert.equal(closes, 2, 'each page closed');

    const caPdf = path.join(dir, 'Spokeo-CA_AG.pdf');
    assert.ok(fs.existsSync(caPdf), 'CA AG pdf should exist');
    assert.equal(pdfCalls[0].format, 'Letter');
    assert.ok(written.includes(caPdf));

    // HTML passed to setContent is the rendered complaint document.
    assert.match(setContentCalls[0].html, /<!doctype html>/);
    assert.match(setContentCalls[0].html, /CA AG body for Spokeo/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips PDF generation entirely when newPage is omitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    assert.equal(written.filter(p => p.endsWith('.pdf')).length, 0, 'no PDFs without newPage');
    assert.equal(written.filter(p => p.endsWith('.txt')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closes the page even if pdf throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  let closes = 0;
  const newPage = async () => ({
    setContent: async () => {},
    pdf: async () => { throw new Error('boom'); },
    close: async () => { closes += 1; },
  });
  try {
    await assert.rejects(
      () => writeComplaintFiles({ outDir: dir, entries: makeEntries(), newPage }),
      /boom/
    );
    assert.equal(closes, 1, 'page closed despite pdf error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
