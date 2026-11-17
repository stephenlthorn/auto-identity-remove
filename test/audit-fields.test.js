'use strict';

/**
 * test/audit-fields.test.js - Q4: the audit report lists which details were typed.
 *
 * Names only ("first name", "masked email"), whatever flags the run had. A result
 * with no recorded fields renders exactly as before, so old logs are unchanged.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderAuditMarkdown } = require('../lib/audit');
const logger = require('../lib/logger');

const person = { firstName: 'Jane', lastName: 'Sample', email: 'jane.sample@example.com' };
const timestamp = '2026-11-17T10:00:00.000Z';

test('a result with typed fields lists the detail names after the broker', () => {
  const md = renderAuditMarkdown({
    person, timestamp,
    results: { succeeded: [{ broker: 'Spokeo', status: 'success', detail: 'Form submitted', fields: ['first name', 'masked email'] }] },
  });
  assert.match(md, /- Spokeo - 2026-11-17 \(Form submitted\) - details typed: first name, masked email/);
});

test('a result without fields renders exactly as before', () => {
  const md = renderAuditMarkdown({
    person, timestamp,
    results: { succeeded: [{ broker: 'Spokeo', status: 'success', detail: 'Form submitted' }] },
  });
  assert.match(md, /^- Spokeo - 2026-11-17 \(Form submitted\)$/m);
  assert.ok(!/details typed/.test(md));
});

test('the fields appear in every bucket that carries them', () => {
  const md = renderAuditMarkdown({
    person, timestamp,
    results: { errors: [{ broker: 'Beta', status: 'error', detail: 'no submit', fields: ['email'] }] },
  });
  assert.match(md, /- Beta - 2026-11-17 \(no submit\) - details typed: email/);
});

test('logResult stores the names on the entry, and only names', () => {
  logger.resetResults();
  const realLog = console.log;
  console.log = () => {};
  try {
    logger.logResult('Spokeo', 'success', 'ok', { fields: ['first name', 'email'], host: 'spokeo.com' });
    logger.logResult('Plain', 'success', 'ok');
  } finally {
    console.log = realLog;
  }
  const [withFields, plain] = logger.results.succeeded;
  assert.deepEqual(withFields.fields, ['first name', 'email']);
  assert.equal('fields' in plain, false);
});
