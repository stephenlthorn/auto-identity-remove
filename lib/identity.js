/**
 * lib/identity.js
 *
 * The identity fingerprint stamped on state entries (R5), kept apart from
 * lib/config.js so the pure modules that need to ask "is this entry about this
 * person?" (the complaint builder) can do it without loading config.js, which
 * reads state.json the moment it is required.
 */

'use strict';

const crypto = require('crypto');

const _digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

const _fpText = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// The normalized identity fields, in hash order: first name, last name, zip,
// email. A US zip (country defaults to US) counts by its first 5 characters.
function _fpFields(person) {
  const zip = _fpText(person.zip);
  return [
    _fpText(person.firstName),
    _fpText(person.lastName),
    (_fpText(person.country) || 'us') === 'us' ? zip.slice(0, 5) : zip,
    _fpText(person.email),
  ];
}

const _sha16 = (parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);

/**
 * Identity fingerprint (R5): the first 16 hex characters of a sha256 over the
 * normalized first name, last name, zip and email, newline separated. State
 * entries carry it as `fp`, so an entry written for different data (a corrected
 * zip or email) or for another person who shares the name counts as never run
 * instead of suppressing the re-submission for 90 days.
 *
 * The phone number is deliberately NOT part of it (CFG2-7): the first version
 * hashed the phone digits too, so adding a number, or writing it +1 512...
 * instead of 512..., made every broker look never run and re-submitted all of
 * them for a cosmetic edit. A phone is a detail of one request, not who the
 * person is.
 *
 * Normalization is trim + lowercase + collapsed whitespace. Pass the person as
 * configured: the real email, never the relay alias, which is a per-run
 * submission detail and would re-run everyone whenever it rotated. A hash, not
 * the data, is what reaches state.json.
 *
 * @param {object|null|undefined} person
 * @returns {string|null} null when there is no person to fingerprint
 */
function personFingerprint(person) {
  if (!person || typeof person !== 'object') return null;
  return _sha16(_fpFields(person));
}

// Every fingerprint the first generation (name, zip, email AND phone digits) could
// have stamped for this person. The phone it hashed is gone from the entry, so the
// candidates are the ones a cosmetic phone edit produces: the number as configured
// now, no number (stamped before one was added) and the number with or without its
// leading 1. A phone changed to a different number matches none of them, so that
// entry re-runs once and is restamped; state from released installs carries no
// fingerprint at all and is unaffected.
function _legacyFingerprints(person) {
  const digits = _digits(person.phone);
  const phones = new Set([digits, '']);
  if (digits.length === 11 && digits[0] === '1') phones.add(digits.slice(1));
  if (digits.length === 10) phones.add('1' + digits);
  const fields = _fpFields(person);
  return [...phones].map((phone) => _sha16([...fields, phone]));
}

/**
 * Does a stamped `fp` describe this person? True for the current fingerprint and
 * for the first-generation one (see _legacyFingerprints). False with nothing to
 * compare: an unstamped entry is the caller's to trust, not this function's.
 *
 * @param {string|null|undefined} entryFp
 * @param {object|null|undefined} person
 * @returns {boolean}
 */
function fingerprintMatches(entryFp, person) {
  if (!entryFp || !person || typeof person !== 'object') return false;
  return entryFp === personFingerprint(person) || _legacyFingerprints(person).includes(entryFp);
}

module.exports = { personFingerprint, fingerprintMatches };
