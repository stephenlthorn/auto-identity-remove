/**
 * test/helpers/generic-fake-page.js
 *
 * A form-aware stand-in for a Playwright page, used by the generic-runner tests.
 * Not a test file (the suite glob is test/*.test.js), just shared scaffolding.
 *
 * The generic runner fills and submits INSIDE one <form> and judges the result
 * from the text that appeared after the click, so a fake page has to know about
 * forms, the body text before/after a submit, and where the page "is".
 *
 *   makeFakePage({
 *     url: 'https://broker.example/opt-out',
 *     body: 'text shown before any click',
 *     forms: [{
 *       desc: { text: 'Opt out of the sale of your information', ... },  // partial describeFormElement() result
 *       fields: ['email', 'firstName'],      // which FIELD_SELECTORS exist in this form
 *       hasSubmit: true,
 *       afterSubmit: { body: 'Your request has been received.' },
 *     }],
 *   })
 *
 * The page records everything it was asked to do in `page.filled`, `page.clicked`
 * and `page.gotos` so tests can assert on behaviour instead of source text.
 */

'use strict';

// Selector strings generic-runner's getFieldMap() looks for, by field name.
const FIELD_SELECTORS = {
  email: 'input[type="email"]',
  firstName: 'input[name="firstName"]',
  lastName: 'input[name="lastName"]',
  fullName: 'input[name="name"]',
  state: 'select[name*="state" i]',
  zip: 'input[name*="zip" i]',
  phone: 'input[type="tel"]',
};

const SUBMIT_MARKER = 'button[type="submit"]';

const DEFAULT_DESC = {
  visible: true,
  text: '',
  legends: '',
  heading: '',
  dialogLabel: '',
  action: '',
  id: '',
  className: '',
  name: '',
  ariaLabel: '',
  submitTexts: [],
  fieldHints: '',
  hasPassword: false,
  hasSearch: false,
  hasPayment: false,
  chrome: false,
  fillable: 1,
};

/** A form that clearly reads as an opt-out request. */
function optOutForm(overrides = {}) {
  return {
    desc: { text: 'Opt out of the sale of your personal information. Email', heading: 'Opt Out Request', submitTexts: ['Submit request'] },
    fields: ['email', 'firstName', 'lastName'],
    hasSubmit: true,
    ...overrides,
  };
}

/** A footer newsletter signup, the form the old runner would happily submit. */
function newsletterForm(overrides = {}) {
  return {
    desc: { text: 'Subscribe to our newsletter. Email', heading: 'Stay in touch', submitTexts: ['Subscribe'], chrome: true },
    fields: ['email'],
    hasSubmit: true,
    ...overrides,
  };
}

function makeFakePage(spec = {}) {
  const page = {
    filled: [],
    clicked: [],
    gotos: [],
    timeouts: [],
    body: spec.body || '',
    lang: spec.lang || '',
    currentUrl: spec.url || 'https://broker.example/opt-out',
    title_: spec.title || '',
  };

  const forms = (spec.forms || []).map((f) => ({
    desc: { ...DEFAULT_DESC, ...(f.desc || {}) },
    present: new Set((f.fields || []).map((n) => FIELD_SELECTORS[n] || n)),
    hasSubmit: f.hasSubmit !== false,
    clickThrows: f.clickThrows,
    afterSubmit: f.afterSubmit || {},
    submitted: false,
  }));
  page.forms = forms;

  function submit(form) {
    form.submitted = true;
    const after = form.afterSubmit;
    if (after.body !== undefined) page.body = after.body;
    else if (after.appendBody !== undefined) page.body += `\n${after.appendBody}`;
    if (after.url) page.currentUrl = after.url;
    if (after.lang !== undefined) page.lang = after.lang;
  }

  // A locator over a scope. `scope` is a form (or null for page level). A page
  // level field/submit lookup answers from the FIRST form, like a document with
  // one real form on it; that is what an unscoped runner would have hit first.
  // Pass pageScope: false to make page-level lookups find nothing.
  function makeLocator(sel, scope) {
    const isSubmitSel = sel.includes(SUBMIT_MARKER);
    const effective = scope || (spec.pageScope === false ? null : forms[0] || null);
    let present = false;
    if (effective) {
      present = isSubmitSel ? effective.hasSubmit : effective.present.has(sel);
    }
    if (!present && !scope && spec.pageSelectors) {
      present = spec.pageSelectors(sel) === true;
    }
    const self = {
      first: () => self,
      nth: () => self,
      all: async () => (present && spec.toggles && !scope ? spec.toggles(sel) : []),
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      getAttribute: async () => null,
      evaluate: async (fn) => {
        if (fn && fn.name === 'describeFormElement') return effective ? effective.desc : null;
        return fn({ tagName: 'INPUT', type: 'text' });
      },
      fill: async (value) => { page.filled.push({ sel, value, form: effective ? forms.indexOf(effective) : -1 }); },
      selectOption: async () => {},
      check: async () => {},
      click: async () => {
        page.clicked.push({ sel, form: effective ? forms.indexOf(effective) : -1 });
        if (effective && isSubmitSel && present) {
          if (effective.clickThrows) throw new Error(effective.clickThrows);
          submit(effective);
        }
        if (!scope && spec.onPageClick) spec.onPageClick(sel, page);
      },
      locator: (inner) => makeLocator(inner, scope),
      allTextContents: async () => [],
    };
    return self;
  }

  page.locator = (sel) => {
    if (sel === 'form') {
      return {
        count: async () => forms.length,
        nth: (i) => ({
          ...makeLocator('form', forms[i]),
          evaluate: async (fn) => (fn && fn.name === 'describeFormElement' ? forms[i].desc : fn({})),
          locator: (inner) => makeLocator(inner, forms[i]),
        }),
        first: () => makeLocator('form', forms[0]),
      };
    }
    return makeLocator(sel, null);
  };

  page.goto = async (url) => {
    page.gotos.push(url);
    if (spec.gotoThrows) throw new Error(spec.gotoThrows);
    page.currentUrl = (spec.redirects && spec.redirects[url]) || url;
    return { status: () => spec.status || 200 };
  };
  page.url = () => page.currentUrl;
  page.title = async () => page.title_;
  page.waitForTimeout = async () => {};
  page.setDefaultTimeout = (ms) => { page.timeouts.push(ms); };
  page.close = async () => {};
  page.isClosed = () => false;
  page.evaluate = async (fn) => {
    if (fn && fn.name === 'readBodyInPage') return page.body;
    if (fn && fn.name === 'readLangInPage') return page.lang;
    return '';
  };
  return page;
}

/** Minimal Playwright-like context that hands out the given page. */
function makeContext(page) {
  return { newPage: async () => page, pages: () => [page] };
}

module.exports = { makeFakePage, makeContext, optOutForm, newsletterForm, FIELD_SELECTORS, DEFAULT_DESC };
