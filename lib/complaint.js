'use strict';

/**
 * lib/complaint.js
 *
 * Auto-generate regulator complaints when a broker ignores a removal request
 * past its legal response window.
 *
 *   findOverdue(state, opts)            - PURE. Returns overdue brokers.
 *   buildComplaint({ person, broker, overdue, regime })
 *                                        - PURE. Returns { agency, subject, body }.
 *   renderComplaintHtml({ agency, subject, body })
 *                                        - PURE. Returns a standalone HTML string.
 *   writeComplaintFiles(opts)            - IMPURE. Writes .txt + .pdf to a dir.
 *
 * Legal windows:
 *   CCPA - 45 days for a business to respond/delete.
 *   GDPR - 30 days (one month) for erasure under Article 17.
 */

const fs = require('fs');
const path = require('path');

const { pickRegime } = require('./right-to-know');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const CCPA_DAYS = 45;
const GDPR_DAYS = 30;

/**
 * Split a state key into its plain broker name and person label.
 * Multi-person keys are "BrokerName|First Last"; single-person keys are just
 * "BrokerName". Only the FIRST "|" is treated as the separator so broker names
 * that themselves contain "|" survive (person labels never do).
 *
 * @param {string} key
 * @returns {{ broker: string, person: string|null }}
 */
function splitStateKey(key) {
  const idx = String(key).indexOf('|');
  if (idx === -1) return { broker: key, person: null };
  return { broker: key.slice(0, idx), person: key.slice(idx + 1) };
}

/**
 * Resolve the legal regime for an overdue entry (B1).
 *
 * The regime is derived from the matched person's country via
 * right-to-know.pickRegime (EU/UK -> GDPR, everyone else -> CCPA). The old
 * `entry.regime` field was never written anywhere, so reading it routed every
 * complaint through CCPA (45-day window) even for EU users. When no person can
 * be matched (bare single-person key, or unknown person), regime falls back to
 * CCPA - the historical default.
 *
 * pickRegime returns the uppercase 'GDPR'/'CCPA'; findOverdue and
 * AGENCY_BY_REGIME use the lowercase form, so we lowercase here.
 *
 * @param {string|null} personLabel  "First Last" from the composite key.
 * @param {Map<string, object>} personByName
 * @returns {'ccpa'|'gdpr'}
 */
function regimeForPerson(personLabel, personByName) {
  const person = personLabel ? personByName.get(personLabel) : null;
  if (!person) return 'ccpa';
  return pickRegime(person.country) === 'GDPR' ? 'gdpr' : 'ccpa';
}

/**
 * Resolve the "request submitted" timestamp for a state entry.
 * Priority: explicit knowRequestedAt > lastSuccess > pendingConfirm.since >
 * verifiedStillListedAt > lastAttempt.
 * @param {object} entry
 * @returns {string|null} ISO timestamp or null when none present.
 */
function resolveRequestedAt(entry) {
  if (!entry) return null;
  if (entry.knowRequestedAt) return entry.knowRequestedAt;
  if (entry.lastSuccess) return entry.lastSuccess;
  if (entry.pendingConfirm && entry.pendingConfirm.since) return entry.pendingConfirm.since;
  if (entry.verifiedStillListedAt) return entry.verifiedStillListedAt;
  if (entry.lastAttempt) return entry.lastAttempt;
  return null;
}

/**
 * Find brokers still listed past their legal response window.
 *
 * Multi-person state keys ("Broker|First Last") are split so the returned
 * `broker` is the plain broker name (B2) and callers' `brokerMap.get(broker)`
 * hits. The `regime` is derived from the matched person's country (B1) rather
 * than a never-written `entry.regime`, so EU users correctly get the 30-day
 * GDPR window instead of always defaulting to 45-day CCPA.
 *
 * @param {{ optOuts?: object }} state - state.json shape.
 * @param {object} [opts]
 * @param {Date} [opts.now] - injected clock; defaults to new Date().
 * @param {number} [opts.ccpaDays=45]
 * @param {number} [opts.gdprDays=30]
 * @param {Array<{ firstName?: string, lastName?: string, country?: string }>} [opts.persons]
 *   Person definitions used to derive the regime from the composite key.
 * @returns {Array<{ broker: string, person: string|null, requestedAt: string, daysOverdue: number, regime: string }>}
 *   Sorted by daysOverdue descending.
 */
function findOverdue(state, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ccpaDays = typeof opts.ccpaDays === 'number' ? opts.ccpaDays : CCPA_DAYS;
  const gdprDays = typeof opts.gdprDays === 'number' ? opts.gdprDays : GDPR_DAYS;
  const optOuts = (state && state.optOuts) || {};

  const personByName = new Map(
    (opts.persons || [])
      .filter(p => p && (p.firstName || p.lastName))
      .map(p => [`${p.firstName || ''} ${p.lastName || ''}`.trim(), p])
  );

  const overdue = [];
  for (const [key, entry] of Object.entries(optOuts)) {
    const requestedAt = resolveRequestedAt(entry);
    if (!requestedAt) continue;

    const requestedMs = new Date(requestedAt).getTime();
    if (Number.isNaN(requestedMs)) continue;

    // Skip if verified clear AFTER the request (broker actually complied).
    if (entry.verifiedDeletedAt) {
      const verifiedMs = new Date(entry.verifiedDeletedAt).getTime();
      if (!Number.isNaN(verifiedMs) && verifiedMs > requestedMs) continue;
    }

    const { broker, person } = splitStateKey(key);
    const regime = regimeForPerson(person, personByName);
    const windowDays = regime === 'gdpr' ? gdprDays : ccpaDays;
    const ageDays = Math.floor((now.getTime() - requestedMs) / MS_PER_DAY);
    const daysOverdue = ageDays - windowDays;
    if (daysOverdue <= 0) continue;

    overdue.push({ broker, person, requestedAt, daysOverdue, regime });
  }

  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

// ── Complaint templates ────────────────────────────────────────────────────

const AGENCY_BY_REGIME = {
  ccpa: ['CA_AG', 'FTC'],
  gdpr: ['EU_DPA'],
};

const AGENCY_META = {
  CA_AG: {
    name: 'California Attorney General - Consumer Complaint',
    portal: 'https://oag.ca.gov/contact/consumer-complaint-against-business-or-company',
    law: 'the California Consumer Privacy Act (CCPA)',
    windowDays: CCPA_DAYS,
  },
  FTC: {
    name: 'Federal Trade Commission - ReportFraud',
    portal: 'https://reportfraud.ftc.gov/',
    law: 'the California Consumer Privacy Act (CCPA) and applicable federal consumer-protection law',
    windowDays: CCPA_DAYS,
  },
  EU_DPA: {
    name: 'Data Protection Authority - GDPR Complaint',
    portal: 'https://edpb.europa.eu/about-edpb/about-edpb/members_en',
    law: 'the General Data Protection Regulation (GDPR), Article 17',
    windowDays: GDPR_DAYS,
  },
};

function _fullName(person) {
  return person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ');
}

function _locationLine(person) {
  const parts = [person.city, person.state, person.zip].filter(Boolean).join(', ');
  return parts || '(location not provided)';
}

/**
 * Build a single pre-filled regulator complaint.
 *
 * @param {object} opts
 * @param {object} opts.person - { fullName/firstName/lastName, city, state, zip, email, phoneFormatted }
 * @param {object} opts.broker - { name, optOutUrl?, emailTo? }
 * @param {{ requestedAt: string, daysOverdue: number }} opts.overdue
 * @param {'CA_AG'|'FTC'|'EU_DPA'} opts.regime - the target agency code.
 * @returns {{ agency: string, subject: string, body: string }}
 */
function buildComplaint({ person, broker, overdue, regime }) {
  const meta = AGENCY_META[regime];
  if (!meta) throw new Error(`Unknown complaint regime: ${regime}`);

  const name = _fullName(person);
  const requestedDate = String(overdue.requestedAt).slice(0, 10);
  const brokerName = broker.name;
  const brokerContact = broker.optOutUrl || broker.emailTo || '(no public opt-out contact on file)';

  const subject = `Consumer privacy complaint: ${brokerName} failed to honor data-deletion request`;

  const body = [
    `To: ${meta.name}`,
    `Portal: ${meta.portal}`,
    '',
    'Complainant:',
    `  Name: ${name}`,
    `  Location: ${_locationLine(person)}`,
    `  Email: ${person.email || '(not provided)'}`,
    `  Phone: ${person.phoneFormatted || '(not provided)'}`,
    '',
    `Business complained about: ${brokerName}`,
    `Business opt-out contact: ${brokerContact}`,
    '',
    'Summary of complaint:',
    `On ${requestedDate} I submitted a verified request to ${brokerName} to delete all of`,
    `my personal information, exercising my rights under ${meta.law}.`,
    `The legal response window is ${meta.windowDays} days. As of today, ${overdue.daysOverdue} day(s)`,
    'have elapsed beyond that deadline and my personal information is still being',
    `listed and sold by ${brokerName}. The business has not deleted my data and has`,
    'not provided a lawful basis for refusing.',
    '',
    'Requested action:',
    `I ask that ${meta.name} investigate ${brokerName} for its failure to comply with`,
    `${meta.law} within the required ${meta.windowDays}-day window, and compel deletion of`,
    'my personal information.',
    '',
    'Signed,',
    name,
  ].join('\n');

  return { agency: regime, subject, body };
}

/**
 * Build the list of complaints for one overdue broker.
 * CCPA brokers get CA AG + FTC; GDPR brokers get an EU DPA complaint.
 *
 * @param {object} opts
 * @param {object} opts.person
 * @param {object} opts.broker - broker definition (or { name } when unknown).
 * @param {{ requestedAt, daysOverdue, regime }} opts.overdue
 * @returns {Array<{ agency, subject, body }>}
 */
function buildComplaintsForBroker({ person, broker, overdue }) {
  const agencies = AGENCY_BY_REGIME[overdue.regime] || AGENCY_BY_REGIME.ccpa;
  return agencies.map(regime => buildComplaint({ person, broker, overdue, regime }));
}

/**
 * Render a complaint as a standalone printable HTML document.
 * PURE - used by writeComplaintFiles to produce the PDF.
 *
 * @param {{ agency: string, subject: string, body: string }} complaint
 * @returns {string} HTML string.
 */
function renderComplaintHtml({ agency, subject, body }) {
  const esc = s => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${esc(subject)}</title>`,
    '<style>',
    'body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt;',
    '  line-height: 1.5; margin: 1in; color: #111; }',
    'h1 { font-size: 14pt; margin-bottom: 0.5em; }',
    'pre { font-family: inherit; white-space: pre-wrap; word-wrap: break-word; }',
    '</style></head><body>',
    `<h1>${esc(subject)}</h1>`,
    `<pre>${esc(body)}</pre>`,
    '</body></html>',
  ].join('\n');
}

/**
 * Sanitize a string for use in a filename.
 * @param {string} s
 * @returns {string}
 */
function _slug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Write complaint .txt and .pdf files to outDir.
 *
 * The PDF is produced via Playwright: a page is created (injectable for tests),
 * loaded with the rendered HTML, and exported with page.pdf(). This mirrors the
 * persistent-context pattern used elsewhere in the tool.
 *
 * @param {object} opts
 * @param {string} opts.outDir - directory to write into (created if missing).
 * @param {Array<{ broker: string, complaints: Array<{agency, subject, body}> }>} opts.entries
 * @param {() => Promise<{ setContent: Function, pdf: Function, close: Function }>} [opts.newPage]
 *   Factory returning a Playwright-like page. When omitted, the .pdf step is skipped.
 * @returns {Promise<{ written: string[] }>} absolute paths written.
 */
async function writeComplaintFiles({ outDir, entries, newPage }) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const entry of entries) {
    for (const complaint of entry.complaints) {
      const base = `${_slug(entry.broker)}-${_slug(complaint.agency)}`;
      const txtPath = path.join(outDir, `${base}.txt`);
      fs.writeFileSync(txtPath, complaint.body, 'utf8');
      written.push(txtPath);

      if (typeof newPage === 'function') {
        const pdfPath = path.join(outDir, `${base}.pdf`);
        const page = await newPage();
        try {
          await page.setContent(renderComplaintHtml(complaint), { waitUntil: 'load' });
          await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true });
          written.push(pdfPath);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  }

  return { written };
}

module.exports = {
  findOverdue,
  buildComplaint,
  buildComplaintsForBroker,
  renderComplaintHtml,
  writeComplaintFiles,
  // Internal exports for unit-testing.
  resolveRequestedAt,
  splitStateKey,
  regimeForPerson,
  AGENCY_BY_REGIME,
  AGENCY_META,
};
