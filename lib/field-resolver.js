/**
 * lib/field-resolver.js
 *
 * Semantic field-resolver fallback for lib/forms.js.
 *
 * When every CSS selector for a form field misses (broker changed its DOM),
 * resolveField() locates the field by scoring visible inputs against a
 * combination of signals rather than relying on a single attribute match.
 *
 * Design constraints:
 *   - Pure JS, no embeddings, no external deps. The scorer runs inside the
 *     Playwright page context via page.evaluate, so it must be closure-free:
 *     it receives ONLY its own parameters plus browser globals. Module-level
 *     constants (weights, threshold, regex source) are passed in as arguments,
 *     never closed over — a closed-over reference is silently undefined once
 *     the function is re-parsed inside the browser via new Function(src).
 *   - Conservative by default: a wrong fill is worse than no fill. The
 *     minimum score to accept a match is HIGH (MATCH_THRESHOLD = 5).
 *   - Confirm / duplicate / secondary fields are NEVER a fill target. A field
 *     whose name/id/placeholder/aria-label/label carries a confirm-class marker
 *     (confirm, verify, re-enter, retype, repeat, again, secondary, alt, a
 *     trailing 2 / _2 / -2) is forced to score 0 so the resolver abstains on it.
 *     This holds the fail-safe invariant on the most common opt-out layout
 *     (email + confirm-email): we never drop PII into the confirmation box, and
 *     when the PRIMARY is unreadable we abstain entirely rather than mis-fill.
 *   - Ambiguous-keyword guard from forms.js is preserved as a TIE-BREAK,
 *     not a kill-switch: if two candidates share the same top score and
 *     both could match an ambiguous intent, the resolver abstains.
 *   - Selection is snapshot-consistent: the winner is chosen AND tagged with a
 *     data-* marker inside the SAME page.evaluate that scored it, then located
 *     and filled by that marker. This closes the check-to-use (TOCTOU) gap that
 *     a score-then-reselect-by-index approach has when the DOM mutates between
 *     the two round-trips.
 *   - Only fires on miss — happy-path (exact selector hit) is unchanged.
 *
 * Public API:
 *   resolveField(page, selector, value)  → Playwright Locator | null
 *   deriveIntent(selector, value)        → intent string
 *
 * @module field-resolver
 */

'use strict';

/**
 * The minimum cumulative signal score required before the resolver will commit
 * to filling a candidate element. Tune upward to reduce false positives;
 * tune downward to increase recall on stripped-down forms.
 *
 * A correct hit on two independent signals ≥ 5 (e.g. type=email + autocomplete).
 * A single weak match (placeholder substring alone = 2) stays below threshold.
 */
const MATCH_THRESHOLD = 5;

/**
 * Per-signal point values. Single source of truth for the scorer.
 *
 *   typeMatch:    type attribute matches the intent (structural, strongest)
 *   autocomplete: explicit browser hint (nearly as strong as type)
 *   exactName:    name/id equals a canonical token for the intent
 *   substring:    name/id/placeholder/aria/label contains an intent token
 *
 * A correct hit on two independent signals (type 4 + autocomplete 3, or
 * exactName 3 + substring 2) clears MATCH_THRESHOLD = 5.
 *
 * Passed into page.evaluate as an argument so the serialized scorer stays
 * closure-free (it reads weights.* from its parameter, never a free variable).
 *
 * @type {{typeMatch:number, autocomplete:number, exactName:number, substring:number}}
 */
const SIGNAL_WEIGHTS = Object.freeze({
  typeMatch: 4,
  autocomplete: 3,
  exactName: 3,
  substring: 2,
});

/**
 * Markers that identify a confirm / duplicate / secondary field — one that
 * must NEVER be filled, because the user's PII belongs only in the PRIMARY
 * field. Filling a confirmation field either leaks raw PII into the wrong box
 * (name/phone/zip) or breaks submission outright (primary stays empty and the
 * broker rejects on email !== confirm-email).
 *
 * Serialized into the page context as a string source (NEGATIVE_MARKER_SRC) so
 * the scorer can rebuild the RegExp closure-free.
 *
 * Matches (case-insensitive):
 *   - worded markers: confirm, verify, re-enter/reenter, re-type/retype, repeat,
 *     again, secondary, second, alt, dup(licate)
 *   - delimited duplicate index: foo_2 / foo-2
 *   - bare trailing duplicate index foo2 (email2 / zip2 / phone2), EXCEPT when
 *     the digit follows "v" — a version suffix (given_name_v2), which is a
 *     legitimately renamed PRIMARY field, not a duplicate. Without this carve-out
 *     the guard would falsely abstain on the common broker-renamed-attr case.
 */
// Token boundary = start-of-string or any non-letter (covers _, -, digits, end).
// `\b` alone is wrong here: `_` is a word char, so \balt\b fails on "alt_email"
// while the delimiter-aware form catches it AND still protects legit substrings
// (e.g. "default"/"salt" do not match a delimiter-bounded "alt").
const NEGATIVE_MARKER_SRC =
  '(confirm|verif|re-?enter|re-?type|retype|repeat|secondary)'   // distinctive substrings
  + '|(?:^|[^a-z])(again|second|alt|dup(?:licate)?)(?:[^a-z]|$)' // delimiter-bounded short tokens (dup AND duplicate)
  + '|[_\\-]2$'                                                  // delimited duplicate index foo_2 / foo-2
  + '|[a-uw-z]2$';                                               // bare duplicate index foo2, but not v2 (version)

/**
 * Derive the semantic intent from the original (missed) CSS selector plus the
 * value that was going to be filled. Intent drives which signals we look for.
 *
 * @param {string} selector  The CSS selector that missed.
 * @param {string} value     The value to be filled.
 * @returns {string}  One of: email | firstName | lastName | fullName | phone
 *                            | zip | city | state | country | generic
 */
function deriveIntent(selector, value) {
  // Extract the attribute VALUES from CSS selector tokens (e.g. name="email",
  // name*="first") to avoid false matches on the attribute NAMES themselves.
  // e.g. `input[name*="first" i]` → attrValues = ["first"], NOT matching "name*=".
  const attrValues = [];
  const attrValueRe = /\[[\w-]+[*^$|~]?=["']?([^"'\]]+)/gi;
  let m;
  while ((m = attrValueRe.exec(selector || '')) !== null) {
    attrValues.push(m[1].toLowerCase());
  }
  // Also extract type= value (e.g. type="email")
  const typeMatch = /type=["']?([^"'\] ]+)/i.exec(selector || '');
  const attrType = typeMatch ? typeMatch[1].toLowerCase() : '';

  // Joined attr-value tokens for keyword checks
  const attrStr = attrValues.join(' ');
  const v = (value || '').toLowerCase();

  // email: type attribute, attr-value contains "email" (substring — `_` is a
  // word char so snake_case like user_email defeats \bemail\b), or value looks
  // like an email address.
  if (attrType === 'email') return 'email';
  if (attrStr.includes('email')) return 'email';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';

  // phone: attr-value or selector token (snake/dash tolerant)
  if (/phone|mobile|\bcell\b|\btel\b/.test(attrStr)) return 'phone';
  if (/\btel\b/.test((selector || '').toLowerCase())) return 'phone';

  // name fragments — check before fullName; order matters. `_`/`-`/space
  // tolerant so first_name / first-name / "first name" all resolve.
  if (/first[_\-\s]?name|firstname|fname|given[_\-\s]?name/.test(attrStr)) return 'firstName';
  if (/\bfirst\b/.test(attrStr)) return 'firstName';
  if (/last[_\-\s]?name|lastname|lname|sur[_\-\s]?name|family[_\-\s]?name/.test(attrStr)) return 'lastName';
  if (/\blast\b/.test(attrStr)) return 'lastName';
  if (/middle[_\-\s]?name|mname|\bmiddle\b/.test(attrStr)) return 'generic'; // too ambiguous

  // full name — attr-value "name" without first/last context. `_`/`-`/space
  // tolerant so full_name / your-name resolve, while username/filename/state
  // are excluded.
  if (/(^|[_\-\s])name([_\-\s]|$)|full[_\-\s]?name|fullname/.test(attrStr)
      && !/state|filename|username|account|first|last|company|business|organi|nick|maiden/.test(attrStr)) return 'fullName';

  // location fields (substring-tolerant for snake_case like zip_code)
  if (/zip|postal|postcode/.test(attrStr)) return 'zip';
  if (/\bcity\b|\btown\b|locality/.test(attrStr)) return 'city';
  if (/\bstate\b|province|region/.test(attrStr)) return 'state';
  if (/country/.test(attrStr)) return 'country';

  // address — too broad; treat as generic to avoid wrong fills
  if (/address/.test(attrStr)) return 'generic';

  return 'generic';
}

/**
 * Score a single DOM element against the target intent.
 *
 * Runs inside page.evaluate() — MUST be closure-free. It reads point values
 * from `weights` and the confirm-field pattern from `negativeMarkerSrc`, both
 * passed as parameters, so the serialized source has no free variables.
 *
 * A confirm / duplicate / secondary field always scores 0 (never a fill
 * target) regardless of how strong its positive signals are.
 *
 * @param {Element} el
 * @param {string} intent
 * @param {{typeMatch:number, autocomplete:number, exactName:number, substring:number}} weights
 * @param {string} negativeMarkerSrc  RegExp source for confirm/duplicate markers
 * @returns {number}
 */
function scoreElement(el, intent, weights, negativeMarkerSrc) {
  const tag = el.tagName.toLowerCase();
  // Only score inputs, selects, textareas
  if (!['input', 'select', 'textarea'].includes(tag)) return 0;

  const type = (el.type || '').toLowerCase();
  const name = (el.name || '').toLowerCase();
  const id   = (el.id   || '').toLowerCase();
  const placeholder = (el.placeholder || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

  // Resolve associated <label> text (for= or wrapping label)
  let labelText = '';
  if (el.id) {
    const lbl = document.querySelector('label[for="' + el.id + '"]');
    if (lbl) labelText = lbl.textContent.trim().toLowerCase();
  }
  if (!labelText) {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      if (parent.tagName.toLowerCase() === 'label') {
        labelText = parent.textContent.trim().toLowerCase();
        break;
      }
      parent = parent.parentElement;
    }
  }

  // ── Negative-signal guard ────────────────────────────────────────────────
  // A confirm / duplicate / secondary field is never a fill target. Check every
  // textual signal; any hit forces score 0 so the resolver abstains on it.
  // INTENTIONAL: the guard is applied to FREE TEXT (placeholder/aria-label/
  // labelText) as well as name/id — NOT restricted to name/id. A placeholder-only
  // "Confirm email" field has no name/id marker, so dropping free text would let
  // it become a fill target and re-open the confirm-field PII leak. Over-abstain
  // is the intended safe side here: wrong-fill is worse than no-fill.
  const negativeRe = new RegExp(negativeMarkerSrc, 'i');
  if (negativeRe.test(name) || negativeRe.test(id) || negativeRe.test(placeholder)
      || negativeRe.test(ariaLabel) || negativeRe.test(labelText)) {
    return 0;
  }

  const W = weights;
  let score = 0;

  // ── intent-specific scoring ───────────────────────────────────────────────

  if (intent === 'email') {
    if (type === 'email') score += W.typeMatch;
    if (autocomplete === 'email') score += W.autocomplete;
    if (name === 'email') score += W.exactName;
    else if (name.includes('email')) score += W.substring;
    if (id === 'email' || id.includes('email')) score += W.substring;
    if (placeholder.includes('email')) score += W.substring;
    if (ariaLabel.includes('email')) score += W.substring;
    if (labelText.includes('email')) score += W.substring;
    return score;
  }

  if (intent === 'firstName') {
    if (autocomplete === 'given-name') score += W.autocomplete;
    if (name === 'firstname' || name === 'fname' || name === 'first_name' || name === 'first') score += W.exactName;
    else if (name.includes('first') || name.includes('fname') || name.includes('given')) score += W.substring;
    if (id.includes('first') || id.includes('fname') || id.includes('given')) score += W.substring;
    if (placeholder.includes('first name') || placeholder.includes('firstname') || placeholder.includes('given')) score += W.substring;
    if (ariaLabel.includes('first name') || ariaLabel.includes('firstname') || ariaLabel.includes('given')) score += W.substring;
    if (labelText.includes('first name') || labelText.includes('given name')) score += W.substring;
    return score;
  }

  if (intent === 'lastName') {
    if (autocomplete === 'family-name') score += W.autocomplete;
    if (name === 'lastname' || name === 'lname' || name === 'last_name' || name === 'last' || name === 'surname') score += W.exactName;
    else if (name.includes('last') || name.includes('lname') || name.includes('surname') || name.includes('family')) score += W.substring;
    if (id.includes('last') || id.includes('lname') || id.includes('surname') || id.includes('family')) score += W.substring;
    if (placeholder.includes('last name') || placeholder.includes('lastname') || placeholder.includes('surname')) score += W.substring;
    if (ariaLabel.includes('last name') || ariaLabel.includes('lastname') || ariaLabel.includes('surname')) score += W.substring;
    if (labelText.includes('last name') || labelText.includes('family name') || labelText.includes('surname')) score += W.substring;
    return score;
  }

  if (intent === 'fullName') {
    // A "*name*" field is only the PERSON'S full name if it is not one of these
    // false friends: company/business/organization name, middle name, nickname,
    // maiden name, plus the pre-existing first/last/user/file exclusions. Without
    // this the resolver drops the person's real name into e.g. company_name when
    // the primary name field is unreadable (a verified wrong-fill of PII).
    const isFullNameToken = s => s.includes('name')
      && !/first|last|user|file|company|business|organi|middle|nick|maiden/.test(s);
    if (autocomplete === 'name') score += W.autocomplete;
    if (name === 'name' || name === 'full_name' || name === 'fullname') score += W.exactName;
    else if (isFullNameToken(name)) score += W.substring;
    if (isFullNameToken(id)) score += W.substring;
    if (isFullNameToken(placeholder)) score += W.substring;
    if (ariaLabel.includes('full name') || ariaLabel.includes('your name')) score += W.substring;
    if (isFullNameToken(labelText)) score += W.substring;
    return score;
  }

  if (intent === 'phone') {
    if (type === 'tel') score += W.typeMatch;
    if (autocomplete === 'tel') score += W.autocomplete;
    if (name === 'phone' || name === 'tel' || name === 'mobile' || name === 'cell') score += W.exactName;
    else if (name.includes('phone') || name.includes('mobile') || name.includes('cell') || name.includes('tel')) score += W.substring;
    if (id.includes('phone') || id.includes('mobile') || id.includes('tel')) score += W.substring;
    if (placeholder.includes('phone') || placeholder.includes('mobile') || placeholder.includes('tel')) score += W.substring;
    if (ariaLabel.includes('phone') || ariaLabel.includes('mobile') || ariaLabel.includes('telephone')) score += W.substring;
    if (labelText.includes('phone') || labelText.includes('mobile') || labelText.includes('telephone')) score += W.substring;
    return score;
  }

  if (intent === 'zip') {
    if (autocomplete === 'postal-code') score += W.autocomplete;
    if (name === 'zip' || name === 'zipcode' || name === 'zip_code' || name === 'postal' || name === 'postcode') score += W.exactName;
    else if (name.includes('zip') || name.includes('postal') || name.includes('postcode')) score += W.substring;
    if (id.includes('zip') || id.includes('postal') || id.includes('postcode')) score += W.substring;
    if (placeholder.includes('zip') || placeholder.includes('postal') || placeholder.includes('postcode')) score += W.substring;
    if (ariaLabel.includes('zip') || ariaLabel.includes('postal')) score += W.substring;
    if (labelText.includes('zip') || labelText.includes('postal') || labelText.includes('postcode')) score += W.substring;
    return score;
  }

  if (intent === 'city') {
    if (autocomplete === 'address-level2') score += W.autocomplete;
    if (name === 'city' || name === 'town' || name === 'locality') score += W.exactName;
    else if (name.includes('city') || name.includes('town') || name.includes('locality')) score += W.substring;
    if (id.includes('city') || id.includes('town') || id.includes('locality')) score += W.substring;
    if (placeholder.includes('city') || placeholder.includes('town')) score += W.substring;
    if (ariaLabel.includes('city') || ariaLabel.includes('town')) score += W.substring;
    if (labelText.includes('city') || labelText.includes('town')) score += W.substring;
    return score;
  }

  if (intent === 'state') {
    if (autocomplete === 'address-level1') score += W.autocomplete;
    if (name === 'state' || name === 'province' || name === 'region') score += W.exactName;
    else if (name.includes('state') || name.includes('province') || name.includes('region')) score += W.substring;
    if (id.includes('state') || id.includes('province') || id.includes('region')) score += W.substring;
    if (placeholder.includes('state') || placeholder.includes('province')) score += W.substring;
    if (ariaLabel.includes('state') || ariaLabel.includes('province')) score += W.substring;
    if (labelText.includes('state') || labelText.includes('province') || labelText.includes('region')) score += W.substring;
    return score;
  }

  if (intent === 'country') {
    if (autocomplete === 'country' || autocomplete === 'country-name') score += W.autocomplete;
    if (name === 'country' || name === 'country_code') score += W.exactName;
    else if (name.includes('country')) score += W.substring;
    if (id.includes('country')) score += W.substring;
    if (placeholder.includes('country')) score += W.substring;
    if (ariaLabel.includes('country')) score += W.substring;
    if (labelText.includes('country')) score += W.substring;
    return score;
  }

  return 0; // intent === 'generic' → abstain
}

/**
 * Marker attribute used to bind the scored winner to the element we fill.
 * Set inside the same page.evaluate that scored, then located + removed.
 */
const RESOLVE_MARKER = 'data-aidr-resolve';

/**
 * Resolve a form field by semantic signals when all CSS selectors missed.
 *
 * Scans visible input/select/textarea elements, scores each against the
 * derived intent inside a SINGLE page.evaluate, applies the threshold + tie
 * abstain, and — if a unique winner clears the bar — tags that exact element
 * with a data-* marker before returning. The winner is then located by the
 * marker, never by index, so a DOM mutation between calls cannot redirect the
 * fill to a different element. The caller (forms.js) clears the marker after
 * the fill via clearResolveMarker().
 *
 * Returns null when:
 *   - intent is 'generic' (too risky to guess)
 *   - no candidate scores above MATCH_THRESHOLD (emits a console.warn so a
 *     production miss is debuggable)
 *   - two candidates tie for top score (ambiguous)
 *   - the only viable candidates are confirm/duplicate fields (scored 0)
 *
 * @param {import('playwright').Page} page
 * @param {string} selector  The CSS selector that already missed.
 * @param {string} value     The value that was going to be filled.
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function resolveField(page, selector, value) {
  const intent = deriveIntent(selector, value);
  if (intent === 'generic') {
    warnNoMatch(intent, selector);
    return null;
  }

  // Score, threshold, tie-break, AND tag the winner all inside ONE evaluate so
  // the selection is snapshot-consistent (no check-to-use gap on the DOM).
  // NOTE: scoreElement is serialized via .toString() and rebuilt in the page
  // context. Do NOT run this module under a coverage instrumenter (c8 / nyc /
  // --experimental-test-coverage): instrumentation injects cov_*() counter calls
  // into the function body that reference a module-scope global absent in the
  // browser, so the rebuilt scorer throws ReferenceError. The project runs plain
  // `node --test` (no coverage), so this is latent; keep it that way for this file.
  const scoreFnSrc = scoreElement.toString();
  const CANDIDATE_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

  const outcome = await page.evaluate(
    ({ fnSrc, intent: targetIntent, threshold, weights, negativeMarkerSrc, candidateSelector, markerAttr }) => {
      // Reconstruct scoreElement inside the browser context (closure-free).
      // eslint-disable-next-line no-new-func
      const scoreFn = new Function('return (' + fnSrc + ')')();
      const candidates = Array.from(document.querySelectorAll(candidateSelector));

      // Clear any stale marker GLOBALLY (not just on candidates). A marker left
      // on a now-non-candidate element (e.g. one that became hidden between runs)
      // or pre-planted by a hostile page on a non-candidate would otherwise make
      // the returned '[markerAttr="1"]' locator match 2 elements -> a strict-mode
      // fill failure that silently defeats the resolver. Matches clearResolveMarker.
      document.querySelectorAll('[' + markerAttr + ']').forEach(el => el.removeAttribute(markerAttr));

      const scored = candidates.map(el => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && !el.hidden && el.type !== 'hidden';
        const score = visible ? scoreFn(el, targetIntent, weights, negativeMarkerSrc) : 0;
        return { el, score };
      });

      const above = scored.filter(s => s.score >= threshold);
      if (above.length === 0) return { found: false };
      above.sort((a, b) => b.score - a.score);
      // Tie on the top score → ambiguous → abstain.
      if (above.length >= 2 && above[1].score === above[0].score) return { found: false };

      // Tag the unique winner so we fill THIS exact element, not nth(index).
      above[0].el.setAttribute(markerAttr, '1');
      return { found: true, score: above[0].score };
    },
    {
      fnSrc: scoreFnSrc,
      intent,
      threshold: MATCH_THRESHOLD,
      weights: SIGNAL_WEIGHTS,
      negativeMarkerSrc: NEGATIVE_MARKER_SRC,
      candidateSelector: CANDIDATE_SELECTOR,
      markerAttr: RESOLVE_MARKER,
    }
  );

  if (!outcome || !outcome.found) {
    warnNoMatch(intent, selector);
    return null;
  }

  // Locate by the marker attribute set on the SAME snapshot we scored.
  return page.locator('[' + RESOLVE_MARKER + '="1"]');
}

/**
 * Remove the resolve marker the resolver set on the winning element. Best-effort
 * — a failure here is non-fatal (the marker is inert) but is swallowed so a
 * detached node after fill does not throw.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function clearResolveMarker(page) {
  await page
    .evaluate((markerAttr) => {
      document.querySelectorAll('[' + markerAttr + ']').forEach(el => el.removeAttribute(markerAttr));
    }, RESOLVE_MARKER)
    .catch(() => {});
}

/**
 * Emit one observability line when the resolver abstains after every CSS
 * selector already missed, so production misses are debuggable. The pre-existing
 * catch(_) {} in forms.js stays untouched; this is the new path's own signal.
 *
 * @param {string} intent
 * @param {string} selector
 */
function warnNoMatch(intent, selector) {
  // eslint-disable-next-line no-console
  console.warn('field-resolver: no match for intent=' + intent + ' selector=' + selector);
}

module.exports = {
  resolveField,
  deriveIntent,
  clearResolveMarker,
  MATCH_THRESHOLD,
  SIGNAL_WEIGHTS,
  RESOLVE_MARKER,
};
