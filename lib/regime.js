'use strict';

/**
 * lib/regime.js
 *
 * Single source for "which privacy law may we cite for this person" (NET-15).
 * email.js, right-to-know.js and complaint.js used to keep their own copy of
 * the EU list (and the copies disagreed with reality: NO, IS and LI were
 * missing), and right-to-know / complaints cited the CCPA for everyone outside
 * the EU, including people the CCPA does not protect.
 *
 *   gdpr    - EU, EEA and UK residents (GDPR / UK GDPR).
 *   ccpa    - California residents only.
 *   generic - everyone else: cite no statute, lean on the broker's own
 *             published opt-out policy instead of asserting a right the person
 *             does not have.
 *
 * Pure: no I/O, no config or logger requires.
 */

// EU-27, the EEA-only states (IS, LI, NO) and the UK (UK GDPR). Switzerland is
// deliberately absent: it has its own act, not the GDPR.
const GDPR_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB',
]);

// Days a business has to act before a follow-up is justified. GDPR Art. 12(3)
// is one month; the CCPA is 45 days. With no statute to cite we use the longer
// window so a follow-up never fires early.
const RESPONSE_DAYS = { gdpr: 30, ccpa: 45, generic: 45 };

const NO_NAME = '(name not provided)';

function _upper(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

/**
 * @param {string|null|undefined} country ISO 3166-1 alpha-2, any case
 * @returns {boolean}
 */
function isGdprCountry(country) {
  return GDPR_COUNTRIES.has(_upper(country));
}

/**
 * @param {{ country?: string, state?: string }|null|undefined} person
 * @returns {'gdpr'|'ccpa'|'generic'}
 */
function regimeFor(person) {
  const country = _upper(person && person.country);
  if (isGdprCountry(country)) return 'gdpr';
  // An unset country means US (the config default everywhere else in the tool).
  const inUs = country === '' || country === 'US';
  const state = _upper(person && person.state);
  if (inUs && (state === 'CA' || state === 'CALIFORNIA')) return 'ccpa';
  return 'generic';
}

/**
 * @param {'gdpr'|'ccpa'|'generic'} regime
 * @returns {number}
 */
function responseDays(regime) {
  return RESPONSE_DAYS[regime] || RESPONSE_DAYS.generic;
}

/**
 * The name to print in a template. Never undefined: configs written before
 * the dashboard defaulted fullName have only firstName + lastName.
 * @param {object|null|undefined} person
 * @returns {string}
 */
function fullName(person) {
  if (!person) return NO_NAME;
  if (person.fullName) return String(person.fullName);
  const joined = [person.firstName, person.lastName].filter(Boolean).join(' ');
  return joined || NO_NAME;
}

/**
 * "Austin, TX 73301" with whichever parts exist; '' when none do.
 * @param {object|null|undefined} person
 * @returns {string}
 */
function locationText(person) {
  if (!person) return '';
  const stateZip = [person.state, person.zip].filter(Boolean).join(' ');
  return [person.city, stateZip].filter(Boolean).join(', ');
}

/**
 * The "Name / Location / Email / Phone" block shared by the request
 * templates. A field the person did not supply is left out rather than
 * printed as the word "undefined".
 * @param {object|null|undefined} person
 * @returns {string[]}
 */
function identityLines(person) {
  const lines = [`Name: ${fullName(person)}`];
  const location = locationText(person);
  if (location) lines.push(`Location: ${location}`);
  if (person && person.email) lines.push(`Email: ${person.email}`);
  const phone = person && (person.phoneFormatted || person.phone);
  if (phone) lines.push(`Phone: ${phone}`);
  return lines;
}

module.exports = {
  GDPR_COUNTRIES,
  RESPONSE_DAYS,
  isGdprCountry,
  regimeFor,
  responseDays,
  fullName,
  locationText,
  identityLines,
};
