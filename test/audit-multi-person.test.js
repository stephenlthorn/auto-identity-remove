/**
 * test/audit-multi-person.test.js
 *
 * CFG-13: the audit report named only persons[0] ("Requested by: Jane Doe")
 * even when the run processed two people, and every broker row was merged into
 * one undifferentiated list. For a document meant as evidence of who asked
 * which broker to remove what, that is wrong: Jane's success and John's error
 * at the same broker must be two separate, labelled facts.
 *
 * Old run logs have no `person` on their entries, so the flat layout must keep
 * working for them.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderAuditMarkdown } = require('../lib/audit');

const jane = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' };
const john = { firstName: 'John', lastName: 'Smith', email: 'john@example.com' };
const timestamp = '2026-05-19T10:00:00.000Z';

function emptyResults(over = {}) {
  return {
    succeeded: [], pendingConfirm: [], unverified: [], notFound: [],
    captchaFailed: [], manual: [], errors: [], skipped: [],
    ...over,
  };
}

/** Markdown split into { heading -> body } on level-2 headings. */
function sectionsOf(md) {
  const out = {};
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1);
  }
  return out;
}

const twoPersonResults = emptyResults({
  succeeded: [{ broker: 'Spokeo', status: 'success', detail: 'form accepted', person: 'Jane Doe' }],
  errors: [{ broker: 'Spokeo', status: 'error', detail: 'timeout', person: 'John Smith' }],
  pendingConfirm: [{ broker: 'Radaris', status: 'pending_confirm', detail: 'check email', person: 'John Smith' }],
});

test('a two-person audit names both people in the header', () => {
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: twoPersonResults });
  const header = md.split('\n').find(l => l.startsWith('**Requested by:**'));
  assert.match(header, /Jane Doe/);
  assert.match(header, /John Smith/);
});

test('a two-person audit has one section per person with that person\'s own rows', () => {
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: twoPersonResults });
  const sections = sectionsOf(md);

  const janeKey = Object.keys(sections).find(k => k.startsWith('Jane Doe'));
  const johnKey = Object.keys(sections).find(k => k.startsWith('John Smith'));
  assert.ok(janeKey, `no section for Jane Doe in:\n${md}`);
  assert.ok(johnKey, `no section for John Smith in:\n${md}`);

  assert.match(sections[janeKey], /Spokeo/);
  assert.doesNotMatch(sections[janeKey], /timeout/, 'John\'s error must not appear under Jane');
  assert.doesNotMatch(sections[janeKey], /Radaris/);

  assert.match(sections[johnKey], /timeout/);
  assert.match(sections[johnKey], /Radaris/);
  assert.doesNotMatch(sections[johnKey], /form accepted/, 'Jane\'s success must not appear under John');
});

test('Jane succeeded and John errored at the same broker stay two separate rows', () => {
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: twoPersonResults });
  assert.equal((md.match(/- Spokeo - /g) || []).length, 2);
});

test('each person section shows that person\'s email so the request is attributable', () => {
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: twoPersonResults });
  const sections = sectionsOf(md);
  assert.match(Object.keys(sections).find(k => k.startsWith('Jane Doe')), /jane@example\.com/);
  assert.match(Object.keys(sections).find(k => k.startsWith('John Smith')), /john@example\.com/);
});

test('a person with no recorded results still gets a section that says so', () => {
  const onlyJane = emptyResults({
    succeeded: [{ broker: 'Spokeo', status: 'success', detail: '', person: 'Jane Doe' }],
  });
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: onlyJane });
  const sections = sectionsOf(md);
  const johnKey = Object.keys(sections).find(k => k.startsWith('John Smith'));
  assert.ok(johnKey, 'John must not silently vanish from the evidence');
  assert.match(sections[johnKey], /No results recorded/i);
});

test('entries with no person in a multi-person run are kept, in their own section', () => {
  const mixed = emptyResults({
    succeeded: [
      { broker: 'Spokeo', status: 'success', detail: '', person: 'Jane Doe' },
      { broker: 'Untagged Broker', status: 'success', detail: '' },
    ],
  });
  const md = renderAuditMarkdown({ person: jane, persons: [jane, john], timestamp, results: mixed });
  assert.match(md, /Untagged Broker/);
});

test('legacy run logs without a person on any entry keep the flat layout', () => {
  const legacy = emptyResults({
    succeeded: [{ broker: 'Spokeo', status: 'success', detail: 'Form submitted' }],
    errors: [{ broker: 'BeenVerified', status: 'error', detail: 'Timeout' }],
  });
  const md = renderAuditMarkdown({ person: jane, timestamp, results: legacy });
  const sections = sectionsOf(md);
  assert.ok('Submitted (form accepted)' in sections);
  assert.ok('Errors' in sections);
  assert.match(md, /\*\*Requested by:\*\* Jane Doe \(jane@example\.com\)/);
});

test('a single person whose entries are all tagged still renders the flat layout', () => {
  const tagged = emptyResults({
    succeeded: [{ broker: 'Spokeo', status: 'success', detail: '', person: 'Jane Doe' }],
  });
  const md = renderAuditMarkdown({ person: jane, persons: [jane], timestamp, results: tagged });
  assert.ok('Submitted (form accepted)' in sectionsOf(md));
});

test('unverified submissions get their own section that does not claim acceptance or removal', () => {
  const r = emptyResults({
    unverified: [{ broker: 'Whitepages', status: 'unverified', detail: 'no explicit confirmation' }],
  });
  const md = renderAuditMarkdown({ person: jane, timestamp, results: r });
  const sections = sectionsOf(md);
  const key = Object.keys(sections).find(k => /unconfirmed/i.test(k));
  assert.ok(key, `expected an unconfirmed section in:\n${md}`);
  assert.match(sections[key], /Whitepages/);
  assert.equal('Submitted (form accepted)' in sections, false, 'an unverified row is not an accepted submission');
});
