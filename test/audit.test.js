'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { renderAuditMarkdown, writeAuditFile } = require('../lib/audit');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const person = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
};

const timestamp = '2026-05-19T10:00:00.000Z';

const results = {
  succeeded: [
    { broker: 'Spokeo', status: 'success', detail: 'Form submitted', time: '10:00:01 AM' },
  ],
  pendingConfirm: [
    { broker: 'InfoTracer', status: 'pending_confirm', detail: 'Check email', time: '10:00:02 AM' },
  ],
  errors: [
    { broker: 'BeenVerified', status: 'error', detail: 'Timeout', time: '10:00:03 AM' },
  ],
  notFound: [],
  skipped: [],
  captchaFailed: [],
  manual: [],
};

// ── renderAuditMarkdown ───────────────────────────────────────────────────────

describe('renderAuditMarkdown', () => {
  it('includes a title with the date portion of the timestamp', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /# Opt-out audit - 2026-05-19/);
  });

  it('includes the person full name', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /Jane Doe/);
  });

  it('includes the person email', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /jane@example\.com/);
  });

  it('includes the full ISO timestamp', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /2026-05-19T10:00:00\.000Z/);
  });

  it('includes a "Submitted (form accepted)" section with Spokeo', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /## Submitted \(form accepted\)/);
    assert.match(md, /Spokeo/);
  });

  it('includes an "Awaiting email confirmation" section with InfoTracer', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /## Awaiting email confirmation/);
    assert.match(md, /InfoTracer/);
  });

  it('includes an "Errors" section with BeenVerified', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /## Errors/);
    assert.match(md, /BeenVerified/);
  });

  it('omits empty sections', () => {
    const minimal = {
      ...results,
      pendingConfirm: [],
      errors: [],
    };
    const md = renderAuditMarkdown({ person, timestamp, results: minimal });
    assert.doesNotMatch(md, /## Awaiting email confirmation/);
    assert.doesNotMatch(md, /## Errors/);
  });

  it('includes detail text for broker entries when present', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    assert.match(md, /Form submitted/);
  });

  it('handles missing email gracefully', () => {
    const noEmail = { firstName: 'John', lastName: 'Smith' };
    const md = renderAuditMarkdown({ person: noEmail, timestamp, results });
    assert.match(md, /John Smith/);
  });
});

// ── writeAuditFile ────────────────────────────────────────────────────────────

describe('writeAuditFile', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a file stamped down to the second so same-day runs do not collide (B8)', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    const filePath = writeAuditFile(tmpDir, md, timestamp);
    assert.equal(path.basename(filePath), 'audit-2026-05-19T10-00-00.md');
    assert.ok(fs.existsSync(filePath), 'File should exist on disk');
  });

  it('two runs on the same day produce distinct filenames (B8)', () => {
    const md = '# Audit';
    const first = writeAuditFile(tmpDir, md, '2026-05-19T10:00:00.000Z');
    const second = writeAuditFile(tmpDir, md, '2026-05-19T14:30:05.000Z');
    assert.notEqual(path.basename(first), path.basename(second));
    assert.ok(fs.existsSync(first) && fs.existsSync(second), 'both files survive');
  });

  it('written file contains the markdown content', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    const filePath = writeAuditFile(tmpDir, md, timestamp);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(content, md);
  });

  it('returns the full absolute path to the written file', () => {
    const md = renderAuditMarkdown({ person, timestamp, results });
    const filePath = writeAuditFile(tmpDir, md, timestamp);
    assert.ok(path.isAbsolute(filePath));
  });

  it('uses now when no timestamp is provided', () => {
    const md = '# Audit';
    const filePath = writeAuditFile(tmpDir, md);
    assert.match(path.basename(filePath), /^audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
  });
});
