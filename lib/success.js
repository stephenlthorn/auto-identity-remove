/**
 * lib/success.js
 *
 * Post-submit page text analysis. Classifies whether an opt-out form submission
 * appears to have succeeded, failed, or is ambiguous.
 *
 * Patterns are deliberately conservative: false positives (logging a failed
 * submission as success) cause a 90-day cooldown that hides live data exposure.
 */

const SUCCESS_PATTERN = /(your (opt-?out( request)?|removal|deletion|request) (is |has been |was )?(complete|received|submitted|processed|confirmed)|you('ve| have) been (removed|deleted|opted out)|we('ve| have) received your (request|opt-?out|deletion)|successfully (submitted|removed|processed|opted out)|removal (complete|confirmed|processed)|request (received|confirmed|submitted))/i;

const FAILURE_PATTERN = /(this field is required|please (enter|provide|fill out|correct)|invalid (email|phone|zip|postal|address)|something went wrong|an error (has occurred|occurred)|please try again|submission failed|could not (process|submit)|required field)/i;

function looksLikeSuccess(text) {
  if (!text || typeof text !== 'string') return false;
  return SUCCESS_PATTERN.test(text);
}

function looksLikeFailure(text) {
  if (!text || typeof text !== 'string') return false;
  return FAILURE_PATTERN.test(text);
}

/**
 * @param {string|null|undefined} text  Page body innerText after submit
 * @returns {{ outcome: 'success'|'failure'|'unknown', snippet: string }}
 */
function classifyPostSubmit(text) {
  if (!text || typeof text !== 'string') return { outcome: 'unknown', snippet: '' };

  if (looksLikeSuccess(text)) {
    const m = text.match(SUCCESS_PATTERN);
    const snippet = m
      ? text.slice(Math.max(0, m.index - 20), m.index + 100).replace(/\s+/g, ' ').trim()
      : '';
    return { outcome: 'success', snippet };
  }

  if (looksLikeFailure(text)) {
    const m = text.match(FAILURE_PATTERN);
    const snippet = m
      ? text.slice(Math.max(0, m.index - 20), m.index + 100).replace(/\s+/g, ' ').trim()
      : '';
    return { outcome: 'failure', snippet };
  }

  return { outcome: 'unknown', snippet: '' };
}

module.exports = { looksLikeSuccess, looksLikeFailure, classifyPostSubmit, SUCCESS_PATTERN, FAILURE_PATTERN };
