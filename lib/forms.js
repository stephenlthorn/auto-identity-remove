/**
 * lib/forms.js
 *
 * Smart form filler + listing-URL discovery.
 *
 * International support: applyRegionAliases() expands a formFields map so that
 * values mapped to US state/zip selectors also get attempted against common
 * province/postal/postcode variants and a country <select>. fillForm() calls
 * this automatically when a `person` context is present.
 */

const { jitterSleep } = require('./timing');
const { resolveField, clearResolveMarker, isFillableElement } = require('./field-resolver');

// Playwright's default wait is 30 s per call, and a miss costs the full wait.
// A field that cannot take input within a few seconds never will, so every
// fill/check/select below carries its own short timeout (BRK-12). Navigation
// keeps its own longer timeouts.
const FILL_TIMEOUT_MS = 5000;
const SELECT_TIMEOUT_MS = 1500;

// Input types that are not free-text boxes. The bot-trap and email-field guards
// only apply to text entry; a visually hidden native <select> or checkbox behind
// a styled widget is legitimate and must stay fillable.
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color',
]);

/**
 * Augment a formFields map for non-US users so that province/postal/postcode
 * selectors are tried in addition to the usual state/zip selectors, and a
 * country <select> is targeted when the person's country is non-US.
 *
 * For US users the map is returned unchanged (fast path, no allocation).
 *
 * This is a pure transform - no side effects, no Playwright calls.
 *
 * @param {Record<string,string>} formFields  Selector→value map
 * @param {{ country?: string, state?: string, zip?: string }} person  Person config
 * @returns {Record<string,string>}  Possibly-augmented map (new object for non-US)
 */
function applyRegionAliases(formFields, person) {
  const country = (person.country || 'US').toUpperCase();
  if (country === 'US') return formFields;

  const augmented = { ...formFields };

  // Find the value currently mapped to a state-style selector and also map it
  // to province/region selectors
  for (const [sel, val] of Object.entries(formFields)) {
    if (/state/i.test(sel)) {
      augmented[
        'input[name*="province" i],input[name*="region" i],input[placeholder*="province" i]'
      ] = val;
    }
    if (/zip/i.test(sel) || /postal/i.test(sel)) {
      augmented[
        'input[name*="postal" i],input[name*="postcode" i],input[placeholder*="postal" i],input[placeholder*="postcode" i]'
      ] = val;
    }
  }

  // Target a country <select> when present. The value stays the ISO code;
  // fillForm matches it against the option VALUES (and, via the region name,
  // the option labels) instead of sending the bare code to a label match that
  // waited 30 s per non-US run on every broker (BRK-12).
  augmented['select[name*="country" i]'] = country;

  return augmented;
}

/**
 * Keywords too generic for safe getByLabel() fallback.
 * 'first' matches 'First Observed Date', 'first_name_on_account', etc.
 * 'last'  matches 'Last Modified', 'Last Login', etc.
 * 'name'  matches 'Username', 'Company Name', 'File Name', etc.
 * 'address' matches 'Billing Address', 'IP Address', 'Email address', etc.
 * 'addr' is the same word cut short and matches 'Email address' too (BRK-8).
 * 'number' matches 'Order Number', 'Phone Number (hidden field)', etc.
 * Specific keywords like 'email', 'zip', 'phone', 'city' are safe to keep.
 */
const AMBIGUOUS_KEYWORDS = new Set(['first', 'last', 'name', 'middle', 'address', 'addr', 'number']);

/**
 * Returns true when a keyword is too generic for a safe getByLabel() fallback.
 * @param {string} kw
 */
function isAmbiguousKeyword(kw) {
  return AMBIGUOUS_KEYWORDS.has((kw || '').toLowerCase());
}

/**
 * Extracts the substring-match keyword from a CSS attribute selector.
 * Returns null when no *="..." pattern is found.
 * @param {string} selector
 * @returns {string|null}
 */
function extractKeyword(selector) {
  const m = selector.match(/\*="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Returns true when a CSS selector targets an email input field.
 * Matches name/id/placeholder substrings of "email" and type="email".
 * @param {string} selector
 * @returns {boolean}
 */
function isEmailSelector(selector) {
  // :not([type="email"]) says what the field is NOT, so it does not make this an
  // email selector.
  return /type=["']?email|\bemail\b/i.test((selector || '').replace(/:not\([^)]*\)/gi, ''));
}

/**
 * Closure-free probe (runs inside the page via el.evaluate): is this control an
 * email field? True for type=email, or when its own name/id/placeholder/
 * aria-label/autocomplete or an associated <label> says "email". Used so a
 * selector that is not about email never types into one: input[name*="addr"]
 * matches name="email_addr", and a label regex /addr/ matches "Email address".
 *
 * @param {Element} n
 * @returns {boolean}
 */
function isEmailLikeControl(n) {
  if ((n.type || '').toLowerCase() === 'email') return true;
  let text = [n.name, n.id, n.placeholder, n.getAttribute('autocomplete'), n.getAttribute('aria-label')]
    .filter(Boolean).join(' ');
  if (n.labels) {
    for (const label of Array.from(n.labels)) text += ' ' + (label.textContent || '');
  }
  return /e-?mail/i.test(text);
}

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? '' : v).trim());

/**
 * evaluate() that never throws: a stubbed or detached element yields `fallback`.
 * @param {import('playwright').Locator} el
 * @param {Function} fn
 * @param {*} fallback
 */
async function probe(el, fn, fallback) {
  try {
    return await el.evaluate(fn);
  } catch (_) {
    return fallback;
  }
}

/**
 * Why a matched control must NOT be filled, or null when it is fine.
 *
 *   'hidden' - a bot trap: off-screen, 0-1px, aria-hidden, tabindex=-1 or faded
 *              out. Playwright's isVisible() accepts an off-screen field, so
 *              without this the trap is filled and the real field is not.
 *   'email'  - an email box reached by a selector that is not about email.
 *
 * Only a definite answer blocks a fill. A probe that cannot run (stub, detached
 * node) must never stop a legitimate fill, so anything but `false`/`true` is
 * read as "no objection".
 */
async function refusalFor(el, { tag, type, selector, value }) {
  const textEntry = tag === 'textarea' || (tag === 'input' && !NON_TEXT_INPUT_TYPES.has(type));
  if (!textEntry) return null;
  if ((await probe(el, isFillableElement, true)) === false) return 'hidden';
  if (!isEmailSelector(selector) && !looksLikeEmail(value)
      && (await probe(el, isEmailLikeControl, false)) === true) return 'email';
  return null;
}

// Region names that Intl.DisplayNames words differently from how country
// <select>s usually do.
const REGION_ALIASES = Object.freeze({
  GB: ['UK', 'Great Britain'],
  US: ['USA', 'United States of America'],
});

/**
 * Country names a 2-letter ISO code may appear under in an option label.
 * @param {string} code  lower- or upper-case ISO 3166-1 alpha-2
 * @returns {string[]}
 */
function regionNames(code) {
  const upper = String(code).toUpperCase();
  const names = [];
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(upper);
    if (name && name !== upper && name !== 'Unknown Region') names.push(name);
  } catch (_) {
    // Not a region code Intl knows: only the aliases (if any) apply.
  }
  return names.concat(REGION_ALIASES[upper] || []);
}

/**
 * Pick the <option> a value refers to, WITHOUT waiting on the page.
 *
 * Order: option value, then option label, then - only for a country select given
 * a 2-letter code - the country's name. A bare code is therefore matched against
 * option values/codes first and never fed to a label match that cannot succeed
 * (that miss cost 30 s per non-US run, BRK-12). Returns the option's index, or
 * -1 when nothing matches.
 *
 * @param {{ value: string, label: string }[]} options
 * @param {string} wanted
 * @param {{ countryHint?: boolean }} [opts]
 * @returns {number}
 */
function matchSelectOption(options, wanted, opts) {
  const w = String(wanted == null ? '' : wanted).trim().toLowerCase();
  if (!w || !Array.isArray(options)) return -1;
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

  let i = options.findIndex(o => norm(o.value) === w);
  if (i >= 0) return i;
  i = options.findIndex(o => norm(o.label) === w);
  if (i >= 0) return i;

  if (opts && opts.countryHint && /^[a-z]{2}$/.test(w)) {
    for (const name of regionNames(w).map(norm)) {
      i = options.findIndex(o => norm(o.label) === name || norm(o.value) === name);
      if (i >= 0) return i;
      // "United States of America" for "United States": only when unambiguous.
      const prefixed = options.map((o, k) => [o, k]).filter(([o]) => norm(o.label).startsWith(name));
      if (prefixed.length === 1) return prefixed[0][1];
    }
  }
  return -1;
}

/**
 * Choose an option in a <select> with every wait bounded.
 *
 * Reads the option list once and matches locally, so a value the select does not
 * offer costs nothing instead of Playwright's 30 s label wait plus 30 s value
 * wait. When the options cannot be read (stub, detached element) it falls back
 * to two attempts at SELECT_TIMEOUT_MS each.
 *
 * @returns {Promise<boolean>} true when an option was chosen
 */
async function selectBounded(el, value, selector) {
  const wanted = String(value).trim();
  const info = await probe(el, (n) => ({
    ident: ((n.name || '') + ' ' + (n.id || '')).toLowerCase(),
    options: Array.from(n.options || []).map(o => ({
      value: o.value,
      label: (o.label || o.textContent || '').trim(),
    })),
  }), null);
  const readable = info && Array.isArray(info.options) && info.options.length > 0;
  const countryHint = /country|nation/i.test(selector || '') || Boolean(readable && /country|nation/.test(info.ident));

  try {
    if (readable) {
      const index = matchSelectOption(info.options, wanted, { countryHint });
      if (index < 0) return false;
      await el.selectOption({ index }, { timeout: SELECT_TIMEOUT_MS });
      return true;
    }

    const isCode = /^[A-Za-z]{2}$/.test(wanted);
    const attempts = countryHint && isCode
      ? [wanted, ...regionNames(wanted).map(label => ({ label }))]
      : [{ label: wanted }, wanted];
    for (const attempt of attempts) {
      try {
        await el.selectOption(attempt, { timeout: SELECT_TIMEOUT_MS });
        return true;
      } catch (_) { /* try the next form of the value */ }
    }
  } catch (_) { /* fall through: unmatched */ }
  return false;
}

/**
 * Put `value` into one resolved control. Fill/check failures throw to the caller
 * (the primary path treats that as "try the next selector"); an unmatched select
 * option only warns, as before.
 */
async function applyValue(el, value, { selector, tag, type }) {
  if (tag === 'select') {
    if (!(await selectBounded(el, value, selector))) {
      // Never log `value`: this map carries the user's state, city,
      // zip, country and name, and stdout ends up in logs/, journald,
      // `docker logs` and the dashboard's live run stream. The
      // selector is the half that makes selector drift debuggable.
      console.warn(`[forms] select unmatched: selector="${selector}" (value withheld, ${String(value).length} chars) - neither label nor value found`);
    }
    return;
  }
  if (type === 'checkbox' || type === 'radio') {
    await el.check({ timeout: FILL_TIMEOUT_MS });
    return;
  }
  await el.fill(value, { timeout: FILL_TIMEOUT_MS });
}

/**
 * Fill every field in `formFields` on `page`. When `person` is provided,
 * applyRegionAliases() is called first so non-US province/postal selectors are
 * also attempted. For US users there is zero overhead - the map is returned as-is.
 *
 * When `submissionEmail` is provided, any field whose selector targets an email
 * input is filled with that masked/relay address instead of the value baked
 * into `formFields`. This keeps a real email address out of broker submissions.
 *
 * Every wait is bounded (FILL_TIMEOUT_MS / SELECT_TIMEOUT_MS), text boxes that
 * a human cannot see are skipped (bot traps), and a selector that is not about
 * email never fills an email-like field.
 *
 * @param {import('playwright').Page} page
 * @param {Record<string,string>} formFields
 * @param {{ country?: string, state?: string, zip?: string }} [person]
 * @param {string} [submissionEmail]  Masked/relay email to use for email fields
 */
async function fillForm(page, formFields, person, submissionEmail) {
  const fields = person ? applyRegionAliases(formFields, person) : formFields;

  for (const [selector, rawValue] of Object.entries(fields)) {
    const value = (submissionEmail && isEmailSelector(selector)) ? submissionEmail : rawValue;
    // Nothing to say for this field: leave it alone. Filling undefined throws
    // into the catch below and then hands undefined to the semantic resolver;
    // filling '' wipes a value the broker may have prefilled. "undefined" as a
    // literal string means a template lost its value upstream - never send it
    // to a third party.
    if (value == null || String(value).trim() === '' || value === 'undefined') continue;
    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          const refusal = await refusalFor(el, { tag, type, selector, value });
          if (refusal) {
            console.warn(`[forms] skipped ${refusal} field: selector="${sel}"`);
            continue;
          }
          await applyValue(el, value, { selector: sel, tag, type });
          filled = true;
          break;
        }
      } catch(_) {}
    }
    if (!filled) {
      // Primary fallback: getByLabel - only fires when the selector contains a
      // *="..." substring match AND the extracted keyword is not ambiguous.
      const kw = extractKeyword(selector);
      if (kw && !isAmbiguousKeyword(kw)) {
        // Escape regex metacharacters before constructing the RegExp so that
        // keywords like "na(me" do not cause a SyntaxError.
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const labelLocator = page.getByLabel(new RegExp(escaped, 'i'));
        // Only flag the field as filled when getByLabel actually matched an
        // element. A silent miss (no associated <label>) must NOT short-circuit
        // the semantic resolver below - otherwise the renamed-attr + no-label
        // failure mode, the exact case the resolver targets, is never reached.
        const matched = await labelLocator.count().catch(() => 0);
        if (matched > 0) {
          const target = labelLocator.first();
          const tag  = await probe(target, n => n.tagName.toLowerCase(), '');
          const type = await probe(target, n => n.type || '', '');
          // A label regex is a loose net: /addr/ matches "Email address".
          const refusal = await refusalFor(target, { tag, type, selector, value });
          if (refusal) {
            console.warn(`[forms] skipped ${refusal} field matched by label: selector="${selector}"`);
          } else {
            try {
              await applyValue(target, value, { selector, tag, type });
              filled = true; // genuine hit - prevent double-fill via semantic fallback
            } catch (_) {
              // The label matched something that cannot take input (hidden,
              // disabled, wrong element): leave `filled` false so the semantic
              // resolver still gets its turn.
            }
          }
        }
      }
    }
    if (!filled) {
      // Secondary fallback: semantic field resolver. Fires when the primary
      // fallback was skipped (selector has no *="..." pattern - i.e. exact
      // selectors like input[name="email"] - or the keyword was ambiguous).
      // resolveField() scores visible elements by multi-signal heuristic and
      // returns the best match above a conservative threshold, or null.
      const resolved = await resolveField(page, selector, value).catch(() => null);
      if (resolved) {
        try {
          const tag  = await resolved.evaluate(n => n.tagName.toLowerCase()).catch(() => '');
          const type = await resolved.evaluate(n => n.type || '').catch(() => '');
          await applyValue(resolved, value, { selector, tag, type }).catch(() => {});
        } finally {
          // Clear the snapshot marker the resolver set on the winning element,
          // so the next field's resolve pass starts from a clean DOM.
          await clearResolveMarker(page);
        }
      }
    }
  }
}

async function findListingUrl(page, broker) {
  // P4: use 'domcontentloaded' rather than 'networkidle'. Tracker-heavy broker
  // sites keep the network busy indefinitely, so 'networkidle' frequently waits
  // the full 20s timeout. domcontentloaded returns once the DOM is parsed; the
  // jitter sleep below gives late-rendered listing links time to appear.
  await page.goto(broker.searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await jitterSleep(1500, 2500);
  // Pass both source and flags so the 'i' (and any other flags) on the original
  // RegExp are preserved inside page.evaluate. Passing only .source drops the flags
  // because new RegExp(src) without a second argument is case-sensitive.
  const links = await page.evaluate(({ src, flags }) => {
    const re = new RegExp(src, flags);
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => re.test(h));
  }, { src: broker.listingPattern.source, flags: broker.listingPattern.flags });
  return links[0] || null;
}

module.exports = {
  fillForm,
  findListingUrl,
  applyRegionAliases,
  isAmbiguousKeyword,
  extractKeyword,
  isEmailSelector,
  matchSelectOption,
};
