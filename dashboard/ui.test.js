/**
 * dashboard/ui.test.js
 *
 * Behavioural tests for dashboard/public/app.js and structural checks that the
 * page works under the Content-Security-Policy the server now sends
 * (default-src 'self': no inline script, no inline style, no data: favicon).
 *
 * app.js runs in a vm context against a tiny fake DOM and a stub fetch, so no
 * browser is needed. Covers DASH-2 (Config tab edits persons[0]), DASH-4 (blank
 * SMTP not sent), DASH-1 (confirm before overwriting an unreadable config),
 * DASH-5 (status comes from the server) and DASH-10 (banner, no wizard).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, 'public');
const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const MASK = '••••••••';

// Elements index.html ships with class="hidden".
const STARTS_HIDDEN = new Set(['#configBanner', '#wizard']);

// ---- fake DOM -------------------------------------------------------------------

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
  };
  return el;
}

/**
 * Load app.js into a fresh context.
 * @param {object} o
 * @param {object} o.routes   { '/config': body | fn, ... } keyed by API path (no /api prefix)
 * @param {Array}  o.configInputs   names of the #configForm inputs
 * @param {Array}  o.wizardInputs   names of the #wizardForm inputs
 */
async function loadApp({ routes = {}, configInputs = [], wizardInputs = [], confirmAnswer = true } = {}) {
  const cache = new Map();
  const els = (sel) => {
    if (!cache.has(sel)) {
      const el = fakeEl();
      if (STARTS_HIDDEN.has(sel)) el.classes.add('hidden');
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
      return [];
    },
  };
  const fetch = async (url, opts) => {
    const key = String(url).replace(/^\/api/, '').split('?')[0];
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ key, method, body });
    const entry = routes[key];
    const reply = typeof entry === 'function' ? entry({ method, body }) : (entry === undefined ? {} : entry);
    return { status: 200, text: async () => JSON.stringify(reply) };
  };
  const ctx = vm.createContext({
    document, fetch, console,
    window: { confirm: (m) => { confirms.push(m); return confirmAnswer; } },
    setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    EventSource: function EventSource() { this.close = () => {}; this.addEventListener = () => {}; },
    Date, JSON, Math, Number, String, Array, Object, Promise, Set, Map, URL, isNaN, parseInt, encodeURIComponent,
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

const CONFIG_INPUTS = ['person.firstName', 'person.lastName', 'person.email', 'person.city', 'person.aliases',
  'allowlist', 'capsolver.apiKey', 'email.smtp.host', 'email.smtp.port', 'email.smtp.user', 'email.smtp.pass', 'email.smtp.from'];

const putRequests = app => app.requests.filter(r => r.method === 'PUT');

// ---- DASH-2 ---------------------------------------------------------------------

const PERSONS_CONFIG = {
  persons: [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.org', city: 'Austin' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.org', city: 'Boston' },
  ],
  capsolver: { apiKey: MASK },
};

test('DASH-2: the Config tab fills the Person section from persons[0]', async () => {
  const app = await loadApp({
    routes: { '/config': { exists: true, config: PERSONS_CONFIG }, '/config/status': { configured: true, missing: [] } },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  assert.equal(app.input(app.configEls, 'person.firstName').value, 'Alice');
  assert.equal(app.input(app.configEls, 'person.city').value, 'Austin');
  assert.match(app.els('#configState').textContent, /person 1 of 2/);
});

test('DASH-2: saving sends the edited person, never a blank one, and no persons array of its own', async () => {
  const app = await loadApp({
    routes: { '/config': { exists: true, config: PERSONS_CONFIG }, '/config/status': { configured: true, missing: [] }, '/summary': {}, '/brokers': [] },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  app.input(app.configEls, 'email.smtp.host').value = 'smtp.example.org';
  await app.els('#saveConfig').click();
  const [put] = putRequests(app);
  assert.ok(put, 'a PUT was sent');
  assert.equal(put.body.config.person.firstName, 'Alice', 'the person section carries persons[0]');
  assert.equal('persons' in put.body.config, false, "persons[] is the server's to edit");
  assert.equal(put.body.config.email.smtp.host, 'smtp.example.org');
  assert.equal('overwrite' in put.body, false);
});

test('DASH-2: the first-run wizard prefills from persons[0] of a persons[] config', async () => {
  const app = await loadApp({
    routes: {
      '/config/status': { configured: false, missing: ['person.email'], locked: false, unreadable: false },
      '/config': { exists: true, config: { persons: [{ firstName: 'Zed', lastName: '', email: '' }] } },
    },
    wizardInputs: ['person.firstName', 'person.lastName', 'person.email'],
  });
  assert.equal(app.input(app.wizardEls, 'person.firstName').value, 'Zed');
});

// ---- DASH-4 ---------------------------------------------------------------------

test('DASH-4: a blank SMTP section the config never had is not sent', async () => {
  const app = await loadApp({
    routes: { '/config': { exists: true, config: { person: { firstName: 'Jane' } } }, '/config/status': { configured: true, missing: [] }, '/summary': {}, '/brokers': [] },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  await app.els('#saveConfig').click();
  const [put] = putRequests(app);
  assert.equal(put.body.config.email, undefined, 'no email.smtp object of empty strings');
});

test('DASH-4: blanking an existing SMTP section is still sent, so it can be cleared', async () => {
  const cfg = { person: { firstName: 'Jane' }, email: { smtp: { host: 'smtp.example.org', user: 'u', pass: MASK } } };
  const app = await loadApp({
    routes: { '/config': { exists: true, config: cfg }, '/config/status': { configured: true, missing: [] }, '/summary': {}, '/brokers': [] },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  app.input(app.configEls, 'email.smtp.host').value = '';
  app.input(app.configEls, 'email.smtp.user').value = '';
  app.input(app.configEls, 'email.smtp.pass').value = ''; // user pressed Clear
  await app.els('#saveConfig').click();
  const [put] = putRequests(app);
  assert.equal(put.body.config.email.smtp.host, '');
  assert.equal(put.body.config.email.smtp.pass, '');
});

test('DASH-4: blank inputs for fields the stored config never had are not sent at all', async () => {
  const app = await loadApp({
    routes: { '/config': { exists: true, config: PERSONS_CONFIG }, '/config/status': { configured: true, missing: [] }, '/summary': {}, '/brokers': [] },
    configInputs: [...CONFIG_INPUTS, 'person.fullName', 'notify.webhook'],
  });
  await app.run('loadConfig()');
  await app.els('#saveConfig').click();
  const [put] = putRequests(app);
  assert.equal(put.body.config.person.fullName, undefined, 'no fullName:"" written into persons[0]');
  assert.equal(put.body.config.notify, undefined);
  assert.equal(put.body.config.allowlist, undefined);
  assert.equal(put.body.config.email, undefined);
});

test('a field that exists can still be cleared by emptying it', async () => {
  const app = await loadApp({
    routes: { '/config': { exists: true, config: PERSONS_CONFIG }, '/config/status': { configured: true, missing: [] }, '/summary': {}, '/brokers': [] },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  app.input(app.configEls, 'person.city').value = '';
  await app.els('#saveConfig').click();
  assert.equal(putRequests(app)[0].body.config.person.city, '');
});

// ---- DASH-1 ---------------------------------------------------------------------

test('DASH-1: an unreadable config asks before it is replaced, then resends with overwrite', async () => {
  let calls = 0;
  const app = await loadApp({
    routes: {
      '/config': ({ method }) => {
        if (method !== 'PUT') return { exists: true, parseError: true, locked: false, config: {} };
        calls += 1;
        return calls === 1 ? { code: 'config_unreadable', locked: false, error: 'unreadable' } : { ok: true, config: {} };
      },
      '/config/status': { configured: false, unreadable: true }, '/summary': {}, '/brokers': [],
    },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  await app.els('#saveConfig').click();
  assert.equal(app.confirms.length, 1, 'the user is asked first');
  assert.equal(putRequests(app).length, 2);
  assert.equal(putRequests(app)[0].body.overwrite, undefined);
  assert.equal(putRequests(app)[1].body.overwrite, true);
  assert.match(app.els('#configState').textContent, /Saved/);
});

test('DASH-1: declining the overwrite sends nothing more', async () => {
  const app = await loadApp({
    routes: {
      '/config': ({ method }) => (method === 'PUT' ? { code: 'config_unreadable', locked: false, error: 'unreadable' } : { exists: true, parseError: true, config: {} }),
      '/config/status': { configured: false, unreadable: true }, '/summary': {}, '/brokers': [],
    },
    configInputs: CONFIG_INPUTS,
    confirmAnswer: false,
  });
  await app.run('loadConfig()');
  await app.els('#saveConfig').click();
  assert.equal(putRequests(app).length, 1);
  assert.match(app.els('#configState').textContent, /Not saved/);
});

test('DASH-1: a locked (encrypted) config is never offered an overwrite', async () => {
  const app = await loadApp({
    routes: {
      '/config': ({ method }) => (method === 'PUT' ? { code: 'config_unreadable', locked: true, error: 'wrong passphrase' } : { exists: true, parseError: true, locked: true, config: {} }),
      '/config/status': { configured: false, locked: true, unreadable: true }, '/summary': {}, '/brokers': [],
    },
    configInputs: CONFIG_INPUTS,
  });
  await app.run('loadConfig()');
  assert.equal(app.els('#saveConfig').disabled, true, 'Save is disabled while locked');
  await app.els('#saveConfig').click();
  assert.equal(app.confirms.length, 0);
  assert.equal(putRequests(app).length, 1);
  assert.match(app.els('#configState').textContent, /wrong passphrase/);
});

// ---- DASH-10 --------------------------------------------------------------------

test('DASH-10: a locked config shows the banner and never opens the wizard', async () => {
  const app = await loadApp({
    routes: { '/config/status': { configured: false, missing: ['person.firstName'], locked: true, unreadable: true }, '/summary': {}, '/brokers': [] },
    wizardInputs: ['person.firstName'],
  });
  assert.equal(app.els('#configBanner').classes.has('hidden'), false, 'banner visible');
  assert.match(app.els('#configBanner').textContent, /AIDR_PASSPHRASE/);
  assert.equal(app.els('#wizard').classes.has('hidden'), true, 'wizard stays hidden');
  assert.ok(!app.requests.some(r => r.key === '/config'), 'the wizard did not even fetch the example to prefill');
});

test('DASH-10: an unreadable (corrupt) config shows its own banner and no wizard', async () => {
  const app = await loadApp({
    routes: { '/config/status': { configured: false, locked: false, unreadable: true }, '/summary': {}, '/brokers': [] },
  });
  assert.equal(app.els('#configBanner').classes.has('hidden'), false);
  assert.match(app.els('#configBanner').textContent, /could not be read/);
  assert.equal(app.els('#wizard').classes.has('hidden'), true);
  assert.ok(!app.requests.some(r => r.key === '/config'));
});

test('DASH-10: a first run (no config at all) still opens the wizard and shows no banner', async () => {
  const app = await loadApp({
    routes: { '/config/status': { configured: false, missing: ['person.firstName'], locked: false, unreadable: false }, '/config': { exists: false, config: {} }, '/summary': {}, '/brokers': [] },
    wizardInputs: ['person.firstName'],
  });
  assert.equal(app.els('#configBanner').classes.has('hidden'), true);
  assert.equal(app.els('#wizard').classes.has('hidden'), false, 'wizard shown');
});

test('DASH-10: the summary says "config locked" instead of "no config"', async () => {
  const app = await loadApp({ routes: { '/summary': { brokers: 1, optedOut: 0, pending: 0, manual: 0, configured: false, configLocked: true }, '/config/status': { configured: true } } });
  await app.run('loadSummary()');
  assert.match(app.els('#summary').innerHTML, /config locked/);
  assert.doesNotMatch(app.els('#summary').innerHTML, /no config/);
});

// ---- DASH-5 ---------------------------------------------------------------------

test('DASH-5: the broker table renders the server-computed status, with per-person detail', async () => {
  const brokers = [
    { name: 'Spokeo', method: 'search-form', priority: 1, usOnly: true, optOutUrl: 'https://x.example/o', status: {
      key: 'ok', label: 'success', date: '2026-01-01T00:00:00.000Z', count: 2,
      people: [{ person: 'A B', key: 'ok', label: 'success' }, { person: 'C D', key: 'ok', label: 'success' }] } },
    { name: 'Intelius', method: 'manual', priority: 3, status: { key: 'manual', label: 'manual', people: [] } },
    { name: 'MyLife', method: 'direct-form', priority: 2, status: { key: 'none', label: '-', date: '', count: 0, people: [] } },
  ];
  const app = await loadApp({ routes: { '/brokers': brokers, '/config/status': { configured: true } } });
  await app.run('loadBrokers()');
  const html = app.els('#brokerTable tbody').innerHTML;
  assert.match(html, /badge ok"[^>]*title="A B: success; C D: success">success \(2 people\)/);
  assert.match(html, /badge manual/);
  assert.match(html, /badge none[^>]*>-</);
  assert.ok(!app.requests.some(r => r.key === '/state'), 'the table no longer needs /api/state');
});

test('DASH-5: a title built from a hostile person name is escaped', async () => {
  const brokers = [{ name: 'Spokeo', method: 'search-form', status: { key: 'ok', label: 'success', count: 1,
    people: [{ person: '"><img src=x onerror=alert(1)>', key: 'ok', label: 'success' }] } }];
  const app = await loadApp({ routes: { '/brokers': brokers, '/config/status': { configured: true } } });
  await app.run('loadBrokers()');
  assert.doesNotMatch(app.els('#brokerTable tbody').innerHTML, /<img/);
});

// ---- CSP compatibility ----------------------------------------------------------

test('CSP: index.html has no inline script, inline style, inline handler or data: resource', () => {
  const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="/, 'every script is external');
    assert.equal(body.trim(), '', 'no inline script body');
  }
  assert.doesNotMatch(HTML, /<style\b/i, 'no <style> element');
  assert.doesNotMatch(HTML, /\sstyle\s*=/i, 'no style="" attribute');
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(HTML, /(?:href|src)\s*=\s*"data:/i, 'default-src self blocks data: resources (the favicon was one)');
  assert.doesNotMatch(HTML, /(?:href|src)\s*=\s*"(?:https?:)?\/\//i, 'no third-party resource');
});

test('CSP: the favicon is a same-origin file that exists', () => {
  const m = HTML.match(/<link rel="icon"[^>]*href="([^"]+)"/);
  assert.ok(m, 'an icon link exists');
  assert.ok(fs.existsSync(path.join(PUBLIC, m[1])), `${m[1]} must exist in public/`);
});

test('CSP: app.js never sets an inline style, handler or dynamic code', () => {
  const dynamicCode = new RegExp(['\\bev', 'al\\(|new Fun', 'ction\\('].join(''));
  assert.doesNotMatch(APP, /\sstyle\s*=\s*["'`\\]/, 'no style="" in a template');
  assert.doesNotMatch(APP, /setAttribute\(\s*['"]style/);
  assert.doesNotMatch(APP, /\.style\.cssText|\.style\s*=/);
  assert.doesNotMatch(APP, /\son[a-z]+\s*=\s*["'`\\]/, 'no inline on*= handler in a template');
  assert.doesNotMatch(APP, dynamicCode);
});

test('CSP: styles.css loads nothing from another origin', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:|data:|\/\/)/i);
  assert.doesNotMatch(css, /@import/);
});
