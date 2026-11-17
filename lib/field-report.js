'use strict';

/**
 * lib/field-report.js
 *
 * Q4: say WHICH of the person's details go into WHICH form field, by name.
 *
 * Users worry that their details go to hundreds of sites, and that a broken
 * selector could put one in the wrong place. This module answers "which detail
 * went where" without ever needing the value: it works out the NAME of a detail
 * ("first name", "email", "ZIP") and renders those names.
 *
 * How the name is found. brokers.js interpolates the person into every form
 * value, so the value alone cannot say which detail it is ("Austin" could be a
 * city or a first name). Instead the broker list is built a second time for a
 * SENTINEL person whose every detail is a unique token, and the tokens that show
 * up in each field's template say what that field carries. That also handles a
 * composed value such as `${city}, ${state}`. A value with no token in it is a
 * fixed choice ("Delete my data") and is shown as "fixed text". When the broker
 * cannot be rebuilt the field is labelled "unmapped" and never "fixed text":
 * claiming a field is harmless when we could not tell would be the wrong way to
 * be wrong.
 *
 * Pure functions plus a small collector with an injected `log`. Nothing here
 * reads config or touches the network.
 */

// The tokens must not contain each other ("qxfullqx" is not inside "qxfirstqx"),
// and the phone token is digits only because brokers.js reduces a phone number to
// digits (phoneParts) before using it.
const SENTINEL = Object.freeze({
  firstName: 'qxfirstqx',
  lastName: 'qxlastqx',
  fullName: 'qxfullqx',
  email: 'qxemailqx@qx.invalid',
  phoneDigits: '7375550142',
  city: 'qxcityqx',
  state: 'qxstateqx',
  zip: 'qxzipqx',
});

// Canonical order of the details, which is also the order they are listed in.
const DETAIL_ORDER = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'state', 'zip', 'country'];
const DETAIL_LABEL = {
  firstName: 'first name',
  lastName: 'last name',
  fullName: 'full name',
  email: 'email',
  phone: 'phone',
  city: 'city',
  state: 'state',
  zip: 'ZIP',
  country: 'country',
};
const MASKED_EMAIL = 'masked email';
const FIXED_TEXT = 'fixed text';
const UNMAPPED = 'unmapped';

// How the closing table orders the names in a row and in the totals.
const LABEL_ORDER = [
  'first name', 'last name', 'full name', 'email', MASKED_EMAIL, 'phone', 'city', 'state', 'ZIP', 'country', FIXED_TEXT, UNMAPPED,
];

/**
 * A person whose every detail is a unique token. The country is kept because
 * lib/forms.js applyRegionAliases adds different selectors for a non-US person.
 *
 * @param {{ country?: string }} [base]
 */
function sentinelPerson(base) {
  return {
    firstName: SENTINEL.firstName,
    lastName: SENTINEL.lastName,
    fullName: SENTINEL.fullName,
    email: SENTINEL.email,
    phone: `+1${SENTINEL.phoneDigits}`,
    city: SENTINEL.city,
    state: SENTINEL.state,
    zip: SENTINEL.zip,
    country: (base && base.country) || 'US',
  };
}

/**
 * The details whose token appears in a template value, in canonical order.
 *
 * @param {string} value
 * @returns {string[]} keys of DETAIL_LABEL
 */
function detailsIn(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  const digits = text.replace(/\D/g, '');
  const found = new Set();
  if (text.includes(SENTINEL.firstName)) found.add('firstName');
  if (text.includes(SENTINEL.lastName)) found.add('lastName');
  if (text.includes(SENTINEL.fullName)) found.add('fullName');
  if (text.includes('qxemailqx')) found.add('email');
  if (digits.includes(SENTINEL.phoneDigits)) found.add('phone');
  if (text.includes(SENTINEL.city)) found.add('city');
  if (text.includes(SENTINEL.state)) found.add('state');
  if (text.includes(SENTINEL.zip)) found.add('zip');
  return DETAIL_ORDER.filter(k => found.has(k));
}

/**
 * Names for a set of detail keys. `masked` says the email that goes in is a relay
 * alias, not the person's own address. No keys at all is a fixed choice.
 *
 * @param {string[]} keys
 * @param {{ masked?: boolean }} [opts]
 * @returns {string[]}
 */
function detailLabels(keys, opts = {}) {
  const ordered = DETAIL_ORDER.filter(k => keys.includes(k));
  if (ordered.length === 0) return [FIXED_TEXT];
  return ordered.map(k => (k === 'email' && opts.masked ? MASKED_EMAIL : DETAIL_LABEL[k]));
}

/**
 * selector -> detail keys for one broker, read from the broker list built for the
 * sentinel person. Region aliases are applied the way fillForm applies them, so a
 * selector fillForm adds for a non-US person is mapped too.
 *
 * @param {string} brokerName
 * @param {(person: object) => object[]} build  brokers.forPerson
 * @param {{ country?: string }} person  the real person (only the country is used)
 * @returns {Record<string, string[]>|null} null when the broker cannot be rebuilt
 */
function templatesFor(brokerName, build, person) {
  try {
    const sentinel = sentinelPerson(person);
    const broker = (build(sentinel) || []).find(b => b && b.name === brokerName);
    if (!broker) return null;
    const { applyRegionAliases } = require('./forms');
    const fields = applyRegionAliases(broker.formFields || {}, sentinel);
    const own = broker.formFields || {};
    const country = String(sentinel.country).toLowerCase();
    const out = {};
    for (const [selector, value] of Object.entries(fields)) {
      // applyRegionAliases adds a country <select> carrying the person's country
      // code for a non-US person: that is the country detail, not a fixed choice (F2).
      const isCountry = !(selector in own) && String(value).toLowerCase() === country;
      out[selector] = isCountry ? ['country'] : detailsIn(value);
    }
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * The details a broker's SEARCH URL carries, read the same way (no network). The
 * search step loads that URL before any form is touched, and it usually holds the
 * person's name and state, so it belongs in "what would be sent".
 *
 * @param {string} brokerName
 * @param {(person: object) => object[]} build  brokers.forPerson
 * @param {{ country?: string }} person
 * @returns {string[]|null} detail keys ([] when no search URL), null when the broker cannot be rebuilt
 */
function searchDetailsFor(brokerName, build, person, urlField = 'searchUrl') {
  try {
    const broker = (build(sentinelPerson(person)) || []).find(b => b && b.name === brokerName);
    if (!broker) return null;
    if (!broker[urlField]) return [];
    let url = String(broker[urlField]);
    try { url = decodeURIComponent(url); } catch (_) { /* keep it raw */ }
    return detailsIn(url);
  } catch (_) {
    return null;
  }
}

/** The details in the opt-out URL itself (F2): same reading as the search URL. */
function optOutUrlDetailsFor(brokerName, build, person) {
  return searchDetailsFor(brokerName, build, person, 'optOutUrl');
}

/**
 * A readable name for a selector: the name or id it targets, else its type, else
 * the id shorthand, else the start of the selector. Selectors are the broker's
 * own template and carry no personal data.
 *
 * @param {string} selector
 */
function fieldLabel(selector) {
  const s = String(selector || '');
  const named = s.match(/\[(?:name|id)[*^$]?="([^"]+)"/);
  if (named) return named[1];
  const typed = s.match(/\[type="?(\w+)"?/);
  if (typed) return typed[1];
  const hash = s.match(/^#([\w-]+)/);
  if (hash) return hash[1];
  const placeholder = s.match(/\[placeholder[*^$]?="([^"]+)"/);
  if (placeholder) return placeholder[1];
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/**
 * Turn what fillForm typed into report entries. A value is carried only when
 * `showValues` is set.
 *
 * @param {Array<{ selector: string, value?: string, masked?: boolean }>} typed
 * @param {Record<string, string[]>|null} templates  from templatesFor
 * @param {{ showValues?: boolean }} [opts]
 * @returns {Array<{ field: string, details: string[], value?: string }>}
 */
function entriesFromTyped(typed, templates, opts = {}) {
  return (typed || []).map(t => {
    const known = templates && Object.prototype.hasOwnProperty.call(templates, t.selector) ? templates[t.selector] : null;
    let details;
    if (known === null) {
      details = [UNMAPPED];
    } else {
      // A relay alias goes wherever an email goes, even into a field whose value
      // was not an email (fillForm substitutes by selector when it has to).
      const keys = t.masked && !known.includes('email') ? [...known, 'email'] : known;
      details = detailLabels(keys, { masked: !!t.masked });
    }
    const entry = { field: t.field || fieldLabel(t.selector), details };
    if (opts.showValues) entry.value = t.value;
    return entry;
  });
}

/**
 * Report entries for the generic pass. There the detail is decided by
 * generic-runner getFieldMap() (and recorded as the field is typed), so no
 * sentinel is needed.
 *
 * @param {Array<{ selector: string, detail: string, value?: string, masked?: boolean }>} typed
 * @param {{ showValues?: boolean }} [opts]
 */
function entriesFromGeneric(typed, opts = {}) {
  return (typed || []).map(t => {
    const entry = { field: fieldLabel(t.selector), details: detailLabels([t.detail], { masked: !!t.masked }) };
    if (opts.showValues) entry.value = t.value;
    return entry;
  });
}

/** Unique detail names across entries, for the audit report (names only). */
function detailNames(entries) {
  const seen = new Set();
  for (const e of entries || []) for (const d of e.details) seen.add(d);
  return LABEL_ORDER.filter(l => seen.has(l));
}

function sortLabels(labels) {
  return LABEL_ORDER.filter(l => labels.has(l));
}

/**
 * Collects per-broker entries during a preview, prints each broker as it comes
 * and renders the closing table(s).
 *
 * @param {{ log?: (line: string) => void, showValues?: boolean }} [opts]
 */
function createFieldReport(opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const showValues = !!opts.showValues;
  const people = new Map(); // person label -> Map(broker -> { labels, search })
  let current = '';

  const rowsFor = () => {
    if (!people.has(current)) people.set(current, new Map());
    return people.get(current);
  };

  const rowOf = (broker) => {
    const rows = rowsFor();
    if (!rows.has(broker)) rows.set(broker, { labels: new Set(), search: new Set(), url: new Set() });
    return rows.get(broker);
  };

  return {
    setPerson(label) {
      current = label || '';
    },

    // What the search step sends (names of details), marked apart from form fields.
    addSearch(broker, labels) {
      const row = rowOf(broker);
      for (const l of labels || []) row.search.add(l);
      log(`   search for ${broker} sends: ${(labels || []).join(', ')}`);
    },

    // Details that sit in the opt-out URL itself (F2).
    addUrl(broker, labels) {
      const row = rowOf(broker);
      for (const l of labels || []) row.url.add(l);
      log(`   opt-out URL for ${broker} carries: ${(labels || []).join(', ')}`);
    },

    add(broker, entries) {
      const row = rowOf(broker);
      for (const e of entries || []) for (const d of e.details) row.labels.add(d);

      if (!entries || entries.length === 0) {
        log(`   fields for ${broker}: none typed`);
        return;
      }
      log(`   fields for ${broker}:`);
      for (const e of entries) {
        // A value is printed only when the user asked for it AND the entry has one.
        const tail = showValues && e.value !== undefined ? ` = ${e.value}` : '';
        log(`     ${e.field} <- ${e.details.join(' + ')}${tail}`);
      }
    },

    renderTables() {
      const lines = [];
      for (const [person, rows] of people) {
        if (rows.size === 0) continue;
        const names = [...rows.keys()];
        const width = Math.max('Broker'.length, ...names.map(n => n.length));
        lines.push('', person ? `Details each broker would receive - ${person}` : 'Details each broker would receive');
        lines.push(`${'Broker'.padEnd(width)} | Details`);
        lines.push(`${'-'.repeat(width)}-+-${'-'.repeat(20)}`);
        const totals = new Map();
        const searchTotals = new Map();
        const urlTotals = new Map();
        for (const name of names) {
          const { labels, search, url } = rows.get(name);
          for (const l of url) urlTotals.set(l, (urlTotals.get(l) || 0) + 1);
          for (const l of labels) totals.set(l, (totals.get(l) || 0) + 1);
          for (const l of search) searchTotals.set(l, (searchTotals.get(l) || 0) + 1);
          const parts = [];
          if (labels.size > 0) parts.push(sortLabels(labels).join(', '));
          if (search.size > 0) parts.push(`search: ${sortLabels(search).join(', ')}`);
          if (url.size > 0) parts.push(`opt-out URL: ${sortLabels(url).join(', ')}`);
          lines.push(`${name.padEnd(width)} | ${parts.length === 0 ? '(nothing typed)' : parts.join('; ')}`);
        }
        lines.push('', `Totals across ${names.length} broker${names.length === 1 ? '' : 's'}:`);
        for (const l of LABEL_ORDER) {
          if (totals.has(l)) lines.push(`  ${l}: ${totals.get(l)} of ${names.length}`);
        }
        for (const l of LABEL_ORDER) {
          if (searchTotals.has(l)) lines.push(`  search sends ${l}: ${searchTotals.get(l)} of ${names.length}`);
        }
        for (const l of LABEL_ORDER) {
          if (urlTotals.has(l)) lines.push(`  opt-out URL sends ${l}: ${urlTotals.get(l)} of ${names.length}`);
        }
      }
      return lines;
    },
  };
}

module.exports = {
  SENTINEL,
  sentinelPerson,
  detailsIn,
  detailLabels,
  templatesFor,
  searchDetailsFor,
  optOutUrlDetailsFor,
  fieldLabel,
  entriesFromTyped,
  entriesFromGeneric,
  detailNames,
  createFieldReport,
};
