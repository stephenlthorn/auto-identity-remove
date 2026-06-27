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

/**
 * Augment a formFields map for non-US users so that province/postal/postcode
 * selectors are tried in addition to the usual state/zip selectors, and a
 * country <select> is targeted when the person's country is non-US.
 *
 * For US users the map is returned unchanged (fast path, no allocation).
 *
 * This is a pure transform — no side effects, no Playwright calls.
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

  // Target a country <select> when present — try the full name, then the code
  augmented['select[name*="country" i]'] = country;

  return augmented;
}

/**
 * Keywords too generic for safe getByLabel() fallback.
 * 'first' matches 'First Observed Date', 'first_name_on_account', etc.
 * 'last'  matches 'Last Modified', 'Last Login', etc.
 * 'name'  matches 'Username', 'Company Name', 'File Name', etc.
 * 'address' matches 'Billing Address', 'IP Address', etc.
 * 'number' matches 'Order Number', 'Phone Number (hidden field)', etc.
 * Specific keywords like 'email', 'zip', 'phone', 'city' are safe to keep.
 */
const AMBIGUOUS_KEYWORDS = new Set(['first', 'last', 'name', 'middle', 'address', 'number']);

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
  return /type=["']?email|\bemail\b/i.test(selector || '');
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
 * @param {import('playwright').Page} page
 * @param {Record<string,string>} formFields
 * @param {{ country?: string, state?: string, zip?: string }} [person]
 * @param {string} [submissionEmail]  Masked/relay email to use for email fields
 */
async function fillForm(page, formFields, person, submissionEmail) {
  const fields = person ? applyRegionAliases(formFields, person) : formFields;

  for (const [selector, rawValue] of Object.entries(fields)) {
    const value = (submissionEmail && isEmailSelector(selector)) ? submissionEmail : rawValue;
    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          if (tag === 'select') {
            try {
              await el.selectOption({ label: value });
            } catch (_labelErr) {
              try {
                await el.selectOption(value);
              } catch (_codeErr) {
                console.warn(`[forms] select unmatched: selector="${sel}" value="${value}" - neither label nor value found`);
              }
            }
          } else if (type === 'checkbox' || type === 'radio') {
            await el.check();
          } else {
            await el.fill(value);
          }
          filled = true;
          break;
        }
      } catch(_) {}
    }
    if (!filled) {
      const kw = extractKeyword(selector);
      if (kw && !isAmbiguousKeyword(kw)) {
        // Escape regex metacharacters before constructing the RegExp so that
        // keywords like "na(me" do not cause a SyntaxError.
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await page.getByLabel(new RegExp(escaped, 'i')).first().fill(value).catch(() => {});
      }
    }
  }
}

async function findListingUrl(page, broker) {
  await page.goto(broker.searchUrl, { waitUntil: 'networkidle', timeout: 20000 });
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

module.exports = { fillForm, findListingUrl, applyRegionAliases, isAmbiguousKeyword, extractKeyword, isEmailSelector };
