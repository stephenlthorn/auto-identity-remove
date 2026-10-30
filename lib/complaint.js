'use strict';

/**
 * lib/complaint.js
 *
 * Generate regulator complaints when a broker has not honored a deletion
 * request past its response window AND a verification pass still found the
 * person listed. The complaint is signed by the user and asserts those facts,
 * so it is only built from evidence (NET-6), never from the mere age of a
 * submission.
 *
 *   findOverdue(state, opts)            - PURE. Returns brokers with a deletion
 *                                          request past its window and positive
 *                                          evidence the person is still listed.
 *   findOverdueKnowRequests(state, opts) - PURE. Right-to-know requests past
 *                                          their window (reported, never
 *                                          turned into deletion complaints).
 *   buildComplaint({ person, broker, overdue, regime })
 *                                        - PURE. Returns { agency, subject, body }.
 *   renderComplaintHtml({ agency, subject, body })
 *                                        - PURE. Returns a standalone HTML string.
 *   writeComplaintFiles(opts)            - IMPURE. Writes .txt + .pdf to a dir
 *                                          (dir 0700, files 0600).
 *
 * Response windows (lib/regime.js):
 *   GDPR    - 30 days (one month) for erasure under Article 17.
 *   CCPA    - 45 days, California residents only.
 *   generic - 45 days, no statute cited.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { regimeFor, responseDays, fullName } = require('./regime');
const { fingerprintMatches } = require('./identity');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const CCPA_DAYS = responseDays('ccpa');
const GDPR_DAYS = responseDays('gdpr');
const GENERIC_DAYS = responseDays('generic');

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
 * Resolve the legal regime for an overdue entry (B1, NET-9, NET-15).
 *
 * The regime is derived from the matched person via regime.regimeFor (EEA/UK
 * -> gdpr, California -> ccpa, everyone else -> generic). The old
 * `entry.regime` field was never written anywhere, so reading it routed every
 * complaint through CCPA. A bare single-person key has no "|Name" suffix, so
 * the one configured person (`soleCandidate`) stands in for it (NET-9); with
 * no person to resolve, no statute can be cited and the answer is 'generic'.
 *
 * @param {string|null} personLabel  "First Last" from the composite key.
 * @param {Map<string, object>} personByName
 * @param {object|null} [soleCandidate]  the only configured person, for bare keys.
 * @returns {'ccpa'|'gdpr'|'generic'}
 */
function regimeForPerson(personLabel, personByName, soleCandidate = null) {
  const person = personLabel ? personByName.get(personLabel) : soleCandidate;
  if (!person) return 'generic';
  return regimeFor(person);
}

/**
 * Resolve the DELETION request date for a state entry: the last successful
 * submission, nothing else (NET-6, codex #8).
 *
 * knowRequestedAt is a disclosure request and must never date a deletion
 * complaint. pendingConfirm.since (the broker is waiting for the user to click
 * a confirmation link), lastAttempt (may be a failure) and
 * verifiedStillListedAt (evidence, not a request) are not requests either.
 *
 * @param {object} entry
 * @returns {string|null} ISO timestamp or null when no deletion request exists.
 */
function resolveRequestedAt(entry) {
  if (!entry || !entry.lastSuccess) return null;
  return entry.lastSuccess;
}

function _ms(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * The verification date proving the person was still listed once the response
 * deadline had passed, or null when there is no such evidence:
 *   - a check made before the deadline proves nothing (the broker still had
 *     time), and a check older than the last submission belongs to a previous
 *     cycle;
 *   - a verified-clear at or after the still-listed stamp means the latest
 *     check found them gone.
 */
function _stillListedEvidence(entry, requestedMs, windowDays) {
  const stillMs = entry.verifiedStillListedAt ? _ms(entry.verifiedStillListedAt) : NaN;
  if (Number.isNaN(stillMs)) return null;
  if (stillMs < requestedMs + windowDays * MS_PER_DAY) return null;
  const goneMs = entry.verifiedDeletedAt ? _ms(entry.verifiedDeletedAt) : NaN;
  if (!Number.isNaN(goneMs) && goneMs >= stillMs) return null;
  return entry.verifiedStillListedAt;
}

/**
 * Index persons by "First Last" and pick the person a bare key refers to.
 * A bare key is only attributable when exactly one person is configured.
 */
function _indexPersons(persons) {
  const list = (persons || []).filter(p => p && (p.firstName || p.lastName));
  const byName = new Map(list.map(p => [`${p.firstName || ''} ${p.lastName || ''}`.trim(), p]));
  return { byName, sole: list.length === 1 ? list[0] : null, count: list.length };
}

/**
 * Who a state entry is about, or null when no configured person can be shown to
 * own it (CFG2-6). A complaint is signed by a person and asserts facts about
 * their data, so an entry only counts when:
 *   - its "|First Last" label names a configured person (Bob was removed from the
 *     config, his entry was not), or, for a bare key, there is exactly one person;
 *   - and, when it is stamped with an identity fingerprint, the stamp describes
 *     that person (a corrected zip or email makes it a record of someone else).
 * With no persons configured there is nothing to resolve against: { person: null },
 * so callers that pass none keep the behaviour they always had.
 *
 * @returns {{ person: object|null }|null}
 */
function _resolveOwner(label, entry, idx) {
  if (idx.count === 0) return { person: null };
  const person = label ? idx.byName.get(label) : idx.sole;
  if (!person) return null;
  if (entry && entry.fp && !fingerprintMatches(entry.fp, person)) return null;
  return { person };
}

/**
 * One candidate per (broker, owner): a person who has both a bare entry (written
 * while they were the only one) and a "Broker|First Last" entry (from a period with
 * several people) has one live request, the latest. Judging both would let a months
 * old record complain about a request that was renewed last week.
 *
 * `rows` are { broker, owner, stampMs, ... }; rows with no known owner never merge.
 */
function _freshestPerOwner(rows) {
  const best = new Map();
  const loose = [];
  for (const row of rows) {
    if (!row.owner.person) { loose.push(row); continue; }
    const id = `${row.broker}\n${fullName(row.owner.person)}`;
    const held = best.get(id);
    if (!held || row.stampMs > held.stampMs) best.set(id, row);
  }
  return [...best.values(), ...loose];
}

/**
 * The windows to apply per regime, from opts (kept for callers that tune them).
 */
function _windows(opts) {
  return {
    ccpa: typeof opts.ccpaDays === 'number' ? opts.ccpaDays : CCPA_DAYS,
    gdpr: typeof opts.gdprDays === 'number' ? opts.gdprDays : GDPR_DAYS,
    generic: typeof opts.genericDays === 'number'
      ? opts.genericDays
      : (typeof opts.ccpaDays === 'number' ? opts.ccpaDays : GENERIC_DAYS),
  };
}

/**
 * Find brokers that were asked to delete, are past the response deadline, and
 * were still found listing the person after that deadline.
 *
 * Multi-person state keys ("Broker|First Last") are split so the returned
 * `broker` is the plain broker name (B2) and callers' `brokerMap.get(broker)`
 * hits. A bare key resolves to the single configured person (NET-9); with
 * several persons a bare key cannot be attributed to anyone, so it is skipped
 * rather than signed over the wrong name.
 *
 * @param {{ optOuts?: object }} state - state.json shape.
 * @param {object} [opts]
 * @param {Date} [opts.now] - injected clock; defaults to new Date().
 * @param {number} [opts.ccpaDays=45]
 * @param {number} [opts.gdprDays=30]
 * @param {number} [opts.genericDays=45]
 * @param {Array<{ firstName?: string, lastName?: string, country?: string, state?: string }>} [opts.persons]
 *   Person definitions used to derive the regime from the composite key.
 * @returns {Array<{ broker: string, person: string|null, requestedAt: string, stillListedAt: string, daysOverdue: number, regime: string }>}
 *   Sorted by daysOverdue descending.
 */
function findOverdue(state, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const windows = _windows(opts);
  const optOuts = (state && state.optOuts) || {};
  const idx = _indexPersons(opts.persons);
  const { byName, sole } = idx;

  const rows = [];
  for (const [key, entry] of Object.entries(optOuts)) {
    const { broker, person } = splitStateKey(key);
    const owner = _resolveOwner(person, entry, idx);
    if (!owner) continue;
    const requestedAt = resolveRequestedAt(entry);
    const requestedMs = requestedAt ? _ms(requestedAt) : NaN;
    rows.push({ broker, person, entry, owner, requestedAt, requestedMs, stampMs: Number.isNaN(requestedMs) ? -Infinity : requestedMs });
  }

  const overdue = [];
  for (const row of _freshestPerOwner(rows)) {
    const { broker, person, entry, requestedAt, requestedMs } = row;
    if (!requestedAt || Number.isNaN(requestedMs)) continue;

    const regime = regimeForPerson(person, byName, sole);
    const windowDays = windows[regime];
    const ageDays = Math.floor((now.getTime() - requestedMs) / MS_PER_DAY);
    const daysOverdue = ageDays - windowDays;
    if (daysOverdue <= 0) continue;

    const stillListedAt = _stillListedEvidence(entry, requestedMs, windowDays);
    if (!stillListedAt) continue;

    overdue.push({ broker, person, requestedAt, stillListedAt, daysOverdue, regime });
  }

  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/**
 * Right-to-know (disclosure) requests that have outlived their response
 * window. These are NOT deletion complaints (codex #8): the tool cannot see
 * whether the broker replied, and "ignored my deletion request" would be
 * false. The caller reports them so the user can follow up by hand.
 *
 * Same options and key handling as findOverdue.
 *
 * @param {{ optOuts?: object }} state
 * @param {object} [opts]
 * @returns {Array<{ broker: string, person: string|null, requestedAt: string, daysOverdue: number, regime: string }>}
 */
function findOverdueKnowRequests(state, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const windows = _windows(opts);
  const optOuts = (state && state.optOuts) || {};
  const idx = _indexPersons(opts.persons);
  const { byName, sole } = idx;

  const rows = [];
  for (const [key, entry] of Object.entries(optOuts)) {
    const { broker, person } = splitStateKey(key);
    const owner = _resolveOwner(person, entry, idx);
    if (!owner) continue;
    const requestedAt = entry && entry.knowRequestedAt;
    const requestedMs = requestedAt ? _ms(requestedAt) : NaN;
    rows.push({ broker, person, owner, requestedAt, requestedMs, stampMs: Number.isNaN(requestedMs) ? -Infinity : requestedMs });
  }

  const out = [];
  for (const { broker, person, requestedAt, requestedMs } of _freshestPerOwner(rows)) {
    if (Number.isNaN(requestedMs)) continue;

    const regime = regimeForPerson(person, byName, sole);
    const ageDays = Math.floor((now.getTime() - requestedMs) / MS_PER_DAY);
    const daysOverdue = ageDays - windows[regime];
    if (daysOverdue <= 0) continue;

    out.push({ broker, person, requestedAt, daysOverdue, regime });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/**
 * One-paragraph console note for overdue right-to-know requests; '' when none.
 * @param {Array<{ broker: string, person: string|null, daysOverdue: number }>} overdue
 * @returns {string}
 */
function formatOverdueKnowNote(overdue) {
  if (!Array.isArray(overdue) || overdue.length === 0) return '';
  const lines = overdue.map(o => {
    const who = o.person ? ` (${o.person})` : '';
    return `  - ${o.broker}${who}: ${o.daysOverdue} day(s) past the response window`;
  });
  return [
    `${overdue.length} right-to-know request(s) are overdue - no complaint generated:`,
    ...lines,
    'A disclosure request is not a deletion request, and aidr cannot see whether the broker',
    'replied. Check your inbox and follow up with the broker directly.',
  ].join('\n');
}

// ── Complaint templates ────────────────────────────────────────────────────

// California residents may complain to the CA AG (CCPA); the FTC takes
// complaints from anyone about a business ignoring its own stated opt-out
// process. EEA/UK residents go to their data protection authority.
const AGENCY_BY_REGIME = {
  ccpa: ['CA_AG', 'FTC'],
  gdpr: ['EU_DPA'],
  generic: ['FTC'],
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

// The FTC complaint for someone the CCPA does not cover (NET-15) cites no
// state statute: it rests on the business not honoring its own opt-out process.
const FTC_GENERIC_META = {
  law: 'applicable federal consumer-protection law',
  windowDays: GENERIC_DAYS,
};

function _metaFor(agency, overdueRegime) {
  const meta = AGENCY_META[agency];
  if (!meta) return null;
  if (agency === 'FTC' && overdueRegime === 'generic') return { ...meta, ...FTC_GENERIC_META };
  return meta;
}

function _locationLine(person) {
  const parts = [person.city, person.state, person.zip].filter(Boolean).join(', ');
  return parts || '(location not provided)';
}

/**
 * Build a single pre-filled regulator complaint.
 *
 * Refuses to build one without `overdue.stillListedAt`: the text tells a
 * regulator, over the user's name, that the person's data was still listed on
 * that date. findOverdue only returns entries that have it.
 *
 * @param {object} opts
 * @param {object} opts.person - { fullName/firstName/lastName, city, state, zip, email, phoneFormatted }
 * @param {object} opts.broker - { name, optOutUrl?, emailTo? }
 * @param {{ requestedAt: string, stillListedAt: string, daysOverdue: number, regime?: string }} opts.overdue
 * @param {'CA_AG'|'FTC'|'EU_DPA'} opts.regime - the target agency code.
 * @returns {{ agency: string, subject: string, body: string }}
 */
function buildComplaint({ person, broker, overdue, regime }) {
  const meta = _metaFor(regime, overdue && overdue.regime);
  if (!meta) throw new Error(`Unknown complaint regime: ${regime}`);
  if (!overdue || !overdue.stillListedAt) {
    throw new Error(
      'buildComplaint: no verification that the data is still listed (overdue.stillListedAt); ' +
      'refusing to assert it in a complaint'
    );
  }

  const name = fullName(person);
  const requestedDate = String(overdue.requestedAt).slice(0, 10);
  const stillListedDate = String(overdue.stillListedAt).slice(0, 10);
  const brokerName = broker.name;
  const brokerContact = broker.optOutUrl || broker.emailTo || '(no public opt-out contact on file)';
  const rightsLine = overdue.regime === 'generic'
    ? `through ${brokerName}'s own opt-out process.`
    : `exercising my rights under ${meta.law}.`;
  const windowLine = overdue.regime === 'generic'
    ? `I allowed ${meta.windowDays} days for the request to be honored.`
    : `The legal response window is ${meta.windowDays} days.`;

  const subject = `Consumer privacy complaint: ${brokerName} did not act on a data-deletion request`;

  const body = [
    `To: ${meta.name}`,
    `Portal: ${meta.portal}`,
    '',
    'Complainant:',
    `  Name: ${name}`,
    `  Location: ${_locationLine(person)}`,
    `  Email: ${person.email || '(not provided)'}`,
    `  Phone: ${person.phoneFormatted || person.phone || '(not provided)'}`,
    '',
    `Business complained about: ${brokerName}`,
    `Business opt-out contact: ${brokerContact}`,
    '',
    'Summary of complaint:',
    `On ${requestedDate} I submitted a request to ${brokerName} to delete all of`,
    `my personal information, ${rightsLine}`,
    `${windowLine} As of today, ${overdue.daysOverdue} day(s)`,
    'have elapsed beyond that deadline. A check of the business\'s public listings on',
    `${stillListedDate}, after the deadline had passed, found my personal information`,
    `still listed by ${brokerName}.`,
    '',
    'Requested action:',
    `I ask that ${meta.name} look into ${brokerName}'s handling of this request under`,
    `${meta.law}, and that my personal information be deleted or the`,
    'business explain its lawful basis for keeping it.',
    '',
    'Signed,',
    name,
  ].join('\n');

  return { agency: regime, subject, body };
}

/**
 * Build the list of complaints for one overdue broker.
 * California residents get CA AG + FTC; EEA/UK residents get an EU DPA
 * complaint; everyone else gets the FTC complaint only.
 *
 * @param {object} opts
 * @param {object} opts.person
 * @param {object} opts.broker - broker definition (or { name } when unknown).
 * @param {{ requestedAt, daysOverdue, regime }} opts.overdue
 * @returns {Array<{ agency, subject, body }>}
 */
function buildComplaintsForBroker({ person, broker, overdue }) {
  const agencies = AGENCY_BY_REGIME[overdue.regime] || AGENCY_BY_REGIME.generic;
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
 * Sanitize a string for use in a filename. A value with no filename-safe
 * characters at all (a non-Latin name) becomes a short hash of itself, so two
 * such people still get different, non-empty slugs.
 * @param {string} s
 * @returns {string}
 */
function _slug(s) {
  const raw = String(s);
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  if (safe) return safe;
  return 'x' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

function _chmodQuiet(target, mode) {
  try { fs.chmodSync(target, mode); } catch (_) { /* missing, or a filesystem without modes */ }
}

// mode only applies when a file is CREATED, so an older world-readable file
// is tightened first, and every write is followed by a chmod.
function _writePrivate(filePath, data) {
  _chmodQuiet(filePath, OWNER_ONLY_FILE);
  fs.writeFileSync(filePath, data, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
  _chmodQuiet(filePath, OWNER_ONLY_FILE);
}

/**
 * Pick a base filename no earlier entry in this call has used, so a collision
 * adds a suffix instead of overwriting someone's complaint.
 */
function _uniqueBase(base, taken) {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Write complaint .txt and .pdf files to outDir.
 *
 * The files hold the complainant's name, address, email and phone, so the
 * directory is made 0700 and every file 0600 (codex #1). Names are
 * `[<person>-]<broker>-<agency>` so two people with the same broker never
 * overwrite each other (NET-8, codex #10).
 *
 * The PDF is produced via Playwright: a page is created (injectable for tests),
 * loaded with the rendered HTML, and exported with page.pdf(). This mirrors the
 * persistent-context pattern used elsewhere in the tool.
 *
 * @param {object} opts
 * @param {string} opts.outDir - directory to write into (created if missing).
 * @param {Array<{ broker: string, person?: string|null, complaints: Array<{agency, subject, body}> }>} opts.entries
 *   `person` is the "First Last" label from findOverdue; omit it for a
 *   single-person run to keep the plain Broker-Agency names.
 * @param {() => Promise<{ setContent: Function, pdf: Function, close: Function }>} [opts.newPage]
 *   Factory returning a Playwright-like page. When omitted, the .pdf step is skipped.
 * @returns {Promise<{ written: string[] }>} absolute paths written.
 */
async function writeComplaintFiles({ outDir, entries, newPage }) {
  fs.mkdirSync(outDir, { recursive: true, mode: OWNER_ONLY_DIR });
  _chmodQuiet(outDir, OWNER_ONLY_DIR);
  const written = [];
  const taken = new Set();

  for (const entry of entries) {
    for (const complaint of entry.complaints) {
      const parts = [entry.person ? _slug(entry.person) : null, _slug(entry.broker), _slug(complaint.agency)];
      const base = _uniqueBase(parts.filter(Boolean).join('-'), taken);
      const txtPath = path.join(outDir, `${base}.txt`);
      _writePrivate(txtPath, complaint.body);
      written.push(txtPath);

      if (typeof newPage === 'function') {
        const pdfPath = path.join(outDir, `${base}.pdf`);
        // Pre-create it 0600: Playwright writes into the existing file, which
        // keeps its mode, so the PDF is never briefly world-readable.
        _writePrivate(pdfPath, '');
        const page = await newPage();
        try {
          await page.setContent(renderComplaintHtml(complaint), { waitUntil: 'load' });
          await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true });
          _chmodQuiet(pdfPath, OWNER_ONLY_FILE);
          written.push(pdfPath);
        } catch (err) {
          fs.rmSync(pdfPath, { force: true }); // do not leave the empty placeholder behind
          throw err;
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
  findOverdueKnowRequests,
  formatOverdueKnowNote,
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
