'use strict';
/*
 * dashboard/support/fake-dom.js - test support, never loaded by the server.
 *
 * Runs public/app.js in a vm context against a tiny fake DOM and a stub fetch,
 * the same approach dashboard/ui.test.js takes, so UI behaviour can be tested
 * without a browser. Every API path is answered from `routes`; anything not
 * listed answers {}.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Elements index.html ships with class="hidden".
const DEFAULT_STARTS_HIDDEN = ['#configBanner', '#captchaBanner', '#wizard', '#runDetail', '#tab-history'];

function fakeEl() {
  const el = {
    listeners: {}, classes: new Set(), textContent: '', innerHTML: '', value: '', disabled: false, dataset: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    classList: {
      add: c => el.classes.add(c),
      remove: c => el.classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el.classes.has(c) : on) el.classes.add(c); else el.classes.delete(c); },
      contains: c => el.classes.has(c),
    },
    focus() {}, setAttribute() {}, appendChild() {}, scrollTop: 0, scrollHeight: 0,
    click: async () => { for (const fn of el.listeners.click || []) await fn({}); },
    /** Fire this element's listeners for `type` with a hand-built event. */
    fire: async (type, event = {}) => { for (const fn of el.listeners[type] || []) await fn(event); },
  };
  return el;
}

/**
 * @param {object} o
 * @param {object} [o.routes]       { '/runs': body | fn({ method, body, query }) (may be async), ... } keyed by API path (no /api prefix, no query)
 * @param {Array}  [o.configInputs] names of the #configForm inputs
 * @param {Array}  [o.wizardInputs] names of the #wizardForm inputs
 * @param {Object} [o.lists]        extra querySelectorAll results keyed by selector
 * @param {string[]} [o.startsHidden]
 */
async function loadApp({ routes = {}, configInputs = [], wizardInputs = [], lists = {}, startsHidden = DEFAULT_STARTS_HIDDEN, confirmAnswer = true } = {}) {
  const cache = new Map();
  const hidden = new Set(startsHidden);
  const els = (sel) => {
    if (!cache.has(sel)) {
      const el = fakeEl();
      if (hidden.has(sel)) el.classes.add('hidden');
      cache.set(sel, el);
    }
    return cache.get(sel);
  };
  const inputs = names => names.map(name => Object.assign(fakeEl(), { name }));
  const configEls = inputs(configInputs);
  const wizardEls = inputs(wizardInputs);
  const requests = [];
  const confirms = [];

  const document = {
    querySelector: sel => els(sel),
    querySelectorAll: (sel) => {
      if (sel === '#configForm input') return configEls;
      if (sel === '#wizardForm input') return wizardEls;
      return lists[sel] || [];
    },
  };
  const fetch = async (url, opts) => {
    const [pathPart, queryPart = ''] = String(url).replace(/^\/api/, '').split('?');
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    const query = Object.fromEntries(new URLSearchParams(queryPart));
    requests.push({ key: pathPart, method, body, query, url: String(url) });
    const entry = routes[pathPart];
    const reply = await (typeof entry === 'function' ? entry({ method, body, query }) : (entry === undefined ? {} : entry));
    return { status: 200, text: async () => JSON.stringify(reply) };
  };
  const ctx = vm.createContext({
    document, fetch, console,
    window: { confirm: (m) => { confirms.push(m); return confirmAnswer; } },
    setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    EventSource: function EventSource() { this.close = () => {}; this.addEventListener = () => {}; },
    Date, JSON, Math, Number, String, Array, Object, Promise, Set, Map, URL, URLSearchParams, isNaN, parseInt, encodeURIComponent,
  });
  vm.runInContext(APP, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  await flush();
  return {
    ctx, els, requests, confirms, flush, configEls, wizardEls,
    run: code => vm.runInContext(code, ctx),
    input: (list, name) => list.find(i => i.name === name),
  };
}

module.exports = { loadApp, fakeEl, APP, HTML };
