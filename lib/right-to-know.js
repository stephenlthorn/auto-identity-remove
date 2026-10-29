/**
 * lib/right-to-know.js
 *
 * PURE right-to-know (data access / disclosure) request template builder.
 *
 * Public API:
 *   buildKnowRequest({ person, broker, regime }) -> { subject, body }
 *   pickRegime(person | country) -> 'GDPR' | 'CCPA' | 'GENERIC'
 *
 * This requests DISCLOSURE of what data a broker holds (a "show me what you
 * have" request), NOT erasure. GDPR path cites Article 15 (right of access);
 * CCPA path cites the consumer right to know (categories + specific pieces of
 * personal information collected, sources, purposes, and third parties) and is
 * used for California residents only; everyone else gets a generic request
 * that cites no statute (NET-15).
 *
 * Pure module: no I/O, no config/logger requires, deterministic output. The
 * regime routing lives in lib/regime.js, shared with lib/email.js and
 * lib/complaint.js.
 */

const { GDPR_COUNTRIES, isGdprCountry, regimeFor, fullName, identityLines } = require('./regime');

// Kept for callers that imported it from here; the list itself lives in regime.js.
const EU_COUNTRIES = GDPR_COUNTRIES;

/**
 * Decide the legal regime for a right-to-know request.
 *
 * Pass the person to get the accurate three-way answer (California residents
 * are the only CCPA group). Passing a bare country string keeps the old
 * two-way meaning - 'GDPR' or the non-EU default 'CCPA' - because a country
 * alone cannot tell a California resident from anyone else in the US.
 *
 * @param {object|string|undefined} personOrCountry
 * @returns {'GDPR'|'CCPA'|'GENERIC'}
 */
function pickRegime(personOrCountry) {
  if (personOrCountry && typeof personOrCountry === 'object') {
    return regimeFor(personOrCountry).toUpperCase();
  }
  return isGdprCountry(personOrCountry) ? 'GDPR' : 'CCPA';
}

/**
 * Build the GDPR Article 15 right-of-access body (EU + UK).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyGDPR(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am writing to exercise my right of access under Article 15 of the General',
    'Data Protection Regulation (GDPR). I request that you disclose to me, in a',
    'commonly used electronic format, all personal data you hold about me, along',
    'with: the purposes of processing; the categories of personal data concerned;',
    'the recipients or categories of recipients to whom the data has been or will',
    'be disclosed; the sources from which the data was obtained; and the envisaged',
    'retention period.',
    '',
    ...identityLines(person),
    '',
    'Please provide this information within one month of receipt of this request,',
    'as required under Article 12(3) GDPR. This is a request for access and',
    'disclosure only; it is not a request for deletion.',
    '',
    'Thank you,',
    fullName(person),
  ].join('\n');
}

/**
 * Build the CCPA right-to-know body (California residents only).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyCCPA(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am exercising my right to know under the California Consumer Privacy Act',
    '(CCPA / CPRA) and applicable privacy laws. Please disclose to me the',
    'categories of personal information you have collected about me, the specific',
    'pieces of personal information you hold, the categories of sources from which',
    'it was collected, the business or commercial purpose for collecting it, and',
    'the categories of third parties with whom you have shared or sold it.',
    '',
    ...identityLines(person),
    '',
    'Please respond within 45 days as required under the CCPA. This is a request',
    'for disclosure of the information you hold; it is not a request for deletion.',
    '',
    'Thank you,',
    fullName(person),
  ].join('\n');
}

/**
 * Build the generic right-to-know body for everyone the CCPA and GDPR do not
 * cover. It cites no statute: asserting a right the person may not have is
 * how a request gets dismissed (or misrepresents the law over their name).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyGeneric(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am requesting that you disclose to me the personal information you hold',
    'about me: the specific pieces of information, the sources it was collected',
    'from, the purposes it is used for, and the third parties it has been shared',
    'with or sold to. I make this request under the privacy laws that apply to me',
    'and under your own privacy policy.',
    '',
    ...identityLines(person),
    '',
    'Please respond within 45 days. This is a request for disclosure of the',
    'information you hold; it is not a request for deletion.',
    '',
    'Thank you,',
    fullName(person),
  ].join('\n');
}

/**
 * Build a right-to-know request for one (person, broker) pair.
 *
 * @param {object} opts
 * @param {object} opts.person  - person record (fullName, city, state, zip, email, phoneFormatted, country)
 * @param {object} opts.broker  - broker definition (name; emailTo for email method)
 * @param {'GDPR'|'CCPA'|'GENERIC'} [opts.regime] - explicit override; default derived from the person
 * @returns {{ subject: string, body: string }}
 */
function buildKnowRequest({ person, broker, regime } = {}) {
  const chosen = String(regime || pickRegime(person)).toUpperCase();
  const builders = { GDPR: _buildBodyGDPR, CCPA: _buildBodyCCPA };
  const body = (builders[chosen] || _buildBodyGeneric)(person);
  const subject = `Right to Know / Data Access Request - ${fullName(person)}`;
  return { subject, body };
}

module.exports = {
  buildKnowRequest,
  pickRegime,
  // Internal exports for unit-testing
  _buildBodyGDPR,
  _buildBodyCCPA,
  _buildBodyGeneric,
  EU_COUNTRIES,
};
