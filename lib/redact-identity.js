/**
 * lib/redact-identity.js
 *
 * Remove the person's own details from text that came from a broker's page before
 * it is logged or recorded (codex #8). A confirmation page often echoes what was
 * submitted, and the snippet around its "request received" wording went straight
 * into the run log and state.json, where the dashboard serves it back.
 *
 * Redacted: first and last name (alone and together), email, any extra address the
 * broker was shown (the relay alias), phone in any formatting, zip and street. The
 * words around them stay, so the snippet remains evidence of what the page said.
 */

'use strict';

const REDACTED = '[redacted]';

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const present = (value) => typeof value === 'string' && value.trim() !== '';

// Whole-word match: letters or digits on either side mean it is part of a longer word or number.
const wholeWord = (source) => new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, 'giu');

function phonePattern(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 7) return null;
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const separated = national.split('').join('[^0-9]{0,3}');
  return new RegExp(`(?<![0-9])(?:\\+?1[^0-9]{0,3})?${separated}(?![0-9])`, 'g');
}

function streetPattern(value) {
  const words = String(value).trim().split(/\s+/).map(escapeRegex);
  return wholeWord(words.join('\\s+'));
}

/**
 * @param {string} text
 * @param {object|null|undefined} person  the person whose details were submitted
 * @param {Array<string|undefined>} [extras]  further values to remove (the masked alias)
 * @returns {string}
 */
function redactIdentity(text, person, extras = []) {
  let out = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (!out) return out;
  const p = person || {};

  const patterns = [];
  const literal = (value, minLength = 2) => {
    if (present(value) && value.trim().length >= minLength) patterns.push(wholeWord(escapeRegex(value.trim()).replace(/\\? +/g, '\\s+')));
  };

  // Longest first, so "Jane Doe" goes before "Jane" and "Doe".
  literal(p.fullName);
  literal([p.firstName, p.lastName].filter(present).join(' '));
  literal(p.email, 3);
  for (const extra of extras) literal(extra, 3);
  for (const value of [p.phone, p.phoneFormatted]) {
    if (present(value)) {
      const re = phonePattern(value);
      if (re) patterns.push(re);
    }
  }
  for (const key of ['address', 'street', 'streetAddress', 'addressLine1', 'addressLine2', 'address1', 'address2']) {
    if (present(p[key]) && p[key].trim().length >= 5) patterns.push(streetPattern(p[key]));
  }
  literal(p.zip, 3);
  literal(p.firstName);
  literal(p.lastName);

  for (const re of patterns) out = out.replace(re, REDACTED);
  return out;
}

module.exports = { redactIdentity, REDACTED };
