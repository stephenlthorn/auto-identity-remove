// test/complaint-build.test.js
/**
 * Content assertions for lib/complaint.js buildComplaint / buildComplaintsForBroker
 * / renderComplaintHtml. All pure - no disk, no browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildComplaint,
  buildComplaintsForBroker,
  renderComplaintHtml,
} = require('../lib/complaint');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phoneFormatted: '(512) 555-0000',
};

const BROKER = { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' };

const OVERDUE_CCPA = { requestedAt: '2026-04-01T00:00:00.000Z', daysOverdue: 24, regime: 'ccpa' };
const OVERDUE_GDPR = { requestedAt: '2026-04-20T00:00:00.000Z', daysOverdue: 20, regime: 'gdpr' };

test('CA AG complaint cites CCPA and the California Attorney General', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.equal(c.agency, 'CA_AG');
  assert.match(c.subject, /Spokeo/);
  assert.match(c.body, /California Attorney General/);
  assert.match(c.body, /California Consumer Privacy Act \(CCPA\)/);
  assert.match(c.body, /45[- ]day/);
});

test('FTC complaint cites the Federal Trade Commission ReportFraud portal', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'FTC' });
  assert.equal(c.agency, 'FTC');
  assert.match(c.body, /Federal Trade Commission/);
  assert.match(c.body, /reportfraud\.ftc\.gov/);
});

test('EU DPA complaint cites GDPR Article 17 and a 30-day window', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_GDPR, regime: 'EU_DPA' });
  assert.equal(c.agency, 'EU_DPA');
  assert.match(c.body, /General Data Protection Regulation \(GDPR\), Article 17/);
  assert.match(c.body, /30[- ]day/);
});

test('complaint body includes complainant name, location, email and phone', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.match(c.body, /Jane Doe/);
  assert.match(c.body, /Austin, TX, 73301/);
  assert.match(c.body, /jane@example\.com/);
  assert.match(c.body, /\(512\) 555-0000/);
});

test('complaint body includes the request date and broker contact', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.match(c.body, /2026-04-01/);
  assert.match(c.body, /https:\/\/www\.spokeo\.com\/optout/);
  assert.match(c.body, /24 day\(s\)/);
});

test('falls back gracefully when person lacks optional fields', () => {
  const sparse = { firstName: 'John', lastName: 'Smith' };
  const broker = { name: 'Radaris' };
  const c = buildComplaint({ person: sparse, broker, overdue: OVERDUE_CCPA, regime: 'FTC' });
  assert.match(c.body, /John Smith/);
  assert.match(c.body, /\(not provided\)/);
  assert.match(c.body, /no public opt-out contact on file/);
});

test('unknown regime throws', () => {
  assert.throws(
    () => buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'NOPE' }),
    /Unknown complaint regime/
  );
});

test('buildComplaintsForBroker returns CA AG + FTC for ccpa overdue', () => {
  const list = buildComplaintsForBroker({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA });
  assert.deepEqual(list.map(c => c.agency).sort(), ['CA_AG', 'FTC']);
});

test('buildComplaintsForBroker returns a single EU DPA complaint for gdpr overdue', () => {
  const list = buildComplaintsForBroker({ person: PERSON, broker: BROKER, overdue: OVERDUE_GDPR });
  assert.deepEqual(list.map(c => c.agency), ['EU_DPA']);
});

test('renderComplaintHtml produces a standalone HTML doc with escaped body', () => {
  const c = { agency: 'CA_AG', subject: 'Complaint <Spokeo>', body: 'a & b < c > d' };
  const html = renderComplaintHtml(c);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Complaint &lt;Spokeo&gt;/);
  assert.match(html, /a &amp; b &lt; c &gt; d/);
  assert.match(html, /<\/html>/);
});
