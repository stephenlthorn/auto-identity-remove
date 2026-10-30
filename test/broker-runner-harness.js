/**
 * test/broker-runner-harness.js - shared stubs for the broker-runner tests.
 *
 * Not a test file (no .test.js suffix), so `node --test test/*.test.js` does not
 * run it. Loads a fresh lib/broker-runner.js with its relative dependencies
 * swapped for recorders, and models a page as a list of elements so the
 * selector-scoping and "did anything change after the click" behaviour is
 * exercised against CSS-like semantics instead of asserting on source text.
 */

'use strict';

const Module = require('module');

const RUNNER_PATH = require.resolve('../lib/broker-runner');

/** Split a selector list on top-level commas (independent of the runner's own splitter). */
function alternatives(selector) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * element: { id, matches: string[], inForm?: boolean, visible?: boolean, submits?: boolean }
 * `matches` lists the bare selectors this element answers to; "form <sel>" only
 * matches when the element sits inside a <form>.
 */
function findElement(elements, selector) {
  return elements.find(el => alternatives(selector).some(alt => {
    if (alt.startsWith('form ')) return el.inForm && el.matches.includes(alt.slice(5).trim());
    return el.matches.includes(alt);
  }));
}

/**
 * @param {object} spec
 * @param {object[]} [spec.elements]
 * @param {string} [spec.before]  body text before a submitting click
 * @param {string} [spec.after]   body text after a submitting click
 * @param {string|null} [spec.lang]
 * @param {object[]} [spec.fields] rows returned to the preview field dump
 * @param {number} [spec.status]  HTTP status of page.goto()
 */
function makePage(spec = {}) {
  const {
    elements = [],
    before = 'Opt out of this site',
    after = before,
    lang = '',
    fields = [],
    status,
  } = spec;
  const page = {
    clicks: [],
    fills: [],
    gotos: [],
    handlers: {},
    timeouts: {},
    submitted: false,
    closed: false,
    async goto(url, opts) {
      page.gotos.push({ url, opts });
      return typeof status === 'number' ? { status: () => status } : {};
    },
    locator(selector) {
      const target = () => findElement(elements, selector);
      return {
        first() {
          return {
            async count() { return target() ? 1 : 0; },
            async isVisible() { const el = target(); return !!el && el.visible !== false; },
            async click() {
              const el = target();
              if (!el) throw new Error(`no element for ${selector}`);
              page.clicks.push({ id: el.id, selector });
              if (el.submits) page.submitted = true;
            },
            async fill(value) {
              const el = target();
              if (!el) throw new Error(`no element for ${selector}`);
              page.fills.push({ id: el.id, selector, value });
            },
          };
        },
      };
    },
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("getAttribute('lang')") || src.includes('getAttribute("lang")')) return lang || '';
      if (src.includes('innerText')) return page.submitted ? after : before;
      if (src.includes('input,select,textarea')) return fields;
      return '';
    },
    setDefaultTimeout(ms) { page.timeouts.default = ms; },
    on(event, handler) { page.handlers[event] = handler; },
    async close() { page.closed = true; },
  };
  return page;
}

function makeContext(page) {
  return { pages: [], async newPage() { return page; } };
}

/**
 * Load a fresh broker-runner. `stubs` replaces any relative dependency by its
 * request string (e.g. './forms'). Without an override the real ./success,
 * ./confirm, ./locale-patterns, ./filter and ./snapshot modules are used so the
 * classification path is the production one.
 */
function stateKeyOf(brokerName, person, total) {
  return !person || (total || 1) <= 1 ? brokerName : `${brokerName}|${person.firstName} ${person.lastName}`;
}

function loadRunner(stubs = {}) {
  const logged = [];
  const recorded = { success: [], pending: [], failure: [], checkpoints: [], skipChecks: [], skipOpts: [], stamps: [] };
  const calls = { fillForm: [], findListingUrl: [], captcha: [] };

  const map = {
    './config': {
      // The third argument the real writers take ({ person }, R5) is kept apart in
      // recorded.stamps, so a test can see whose identity fingerprint a write would
      // carry without changing the shape of the arrays older tests compare.
      recordSuccess: (name, detail, opts) => { recorded.success.push({ name, detail }); recorded.stamps.push({ writer: 'success', name, opts }); },
      recordPendingConfirmation: (name, snippet, opts) => { recorded.pending.push({ name, snippet }); recorded.stamps.push({ writer: 'pending', name, opts }); },
      recordFailure: (name, kind, opts) => { recorded.failure.push({ name, kind }); recorded.stamps.push({ writer: 'failure', name, kind, opts }); },
      // shouldSkip(brokerName, { person, personCount, personIndex }): skipChecks keeps
      // the state key the lookup resolves to, skipOpts the raw call.
      shouldSkip: (name, o) => {
        recorded.skipOpts.push([name, o]);
        recorded.skipChecks.push(o && o.person ? stateKeyOf(name, o.person, o.personCount) : name);
        return null;
      },
      saveCheckpoint: (key) => recorded.checkpoints.push(key),
      stateKey: stateKeyOf,
    },
    './logger': {
      logResult: (name, status, detail) => logged.push({ name, status, detail }),
      STATUS_BUCKET: {},
    },
    './forms': {
      fillForm: async (page, formFields, person, submissionEmail) => {
        calls.fillForm.push({ formFields, person, submissionEmail });
      },
      findListingUrl: async (page, broker) => {
        calls.findListingUrl.push(broker);
        return null;
      },
    },
    './captcha': {
      detectAndSolveCaptcha: async (page, capsolver, broker) => {
        calls.captcha.push({ capsolver, broker });
        return true;
      },
    },
    './retry': { withRetry: fn => fn() },
    './timing': { jitterSleep: async () => {} },
    ...stubs,
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && parent.filename === RUNNER_PATH && Object.prototype.hasOwnProperty.call(map, request)) {
      return map[request];
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[RUNNER_PATH];
  let runner;
  try {
    runner = require(RUNNER_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[RUNNER_PATH];
  }
  return { runner, logged, recorded, calls };
}

const PERSON = {
  firstName: 'Test',
  lastName: 'User',
  fullName: 'Test User',
  email: 'test.user@example.com',
  state: 'TX',
  city: 'Austin',
  zip: '78701',
  country: 'US',
};

const SUBMIT_BROKER = {
  name: 'ClickTestBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

module.exports = { loadRunner, makePage, makeContext, alternatives, findElement, PERSON, SUBMIT_BROKER };
