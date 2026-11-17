'use strict';

/**
 * test/broker-runner-fields.test.js - Q4: `aidr preview --fields` for explicit brokers.
 *
 * The runner is run against a fixture broker with the REAL lib/forms.js, so what
 * the report lists is what fillForm really typed. Every detail of the person is a
 * sentinel string, which lets the tests assert the safety property directly: no
 * detail's value appears anywhere in the output unless --show-values was given.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext } = require('./broker-runner-harness');
const realForms = require('../lib/forms');
const fr = require('../lib/field-report');

const PERSON = {
  firstName: 'ZqFirstNameZq',
  lastName: 'ZqLastNameZq',
  fullName: 'ZqFirstNameZq ZqLastNameZq',
  email: 'zq.email.zq@example.com',
  phone: '+1 737 555 0142',
  city: 'ZqCityZq',
  state: 'ZqStateZq',
  zip: 'ZqZipZq',
  country: 'US',
};
const VALUES = [PERSON.firstName, PERSON.lastName, PERSON.fullName, PERSON.email, PERSON.city, PERSON.state, PERSON.zip, '7375550142'];
const ALIAS = 'alias.zq@relay.example';

// A fixture broker as brokers.js would build it: values are interpolated from the person.
const build = (p) => [{
  name: 'FixtureBroker',
  method: 'direct-form',
  optOutUrl: 'https://example.com/optout?first=' + p.firstName,
  submitSelector: 'button[type="submit"]',
  formFields: {
    '#first': p.firstName,
    '#last': p.lastName,
    '#email': p.email,
    '#where': `${p.city}, ${p.state}`,
    '#zip': p.zip,
    '#request': 'Delete my data',
    '#absent': p.fullName,
    '#phone': '737-555-0142',
  },
}];

// Only these selectors exist on the page, so '#absent' is never typed into.
const PRESENT = ['#first', '#last', '#email', '#where', '#zip', '#request'];

function fieldPage(fills) {
  const page = makePage({ fields: [{ name: 'first', filled: true, type: 'text' }] });
  page.locator = (selector) => ({
    first() {
      return {
        async count() { return PRESENT.includes(selector) ? 1 : 0; },
        async isVisible() { return PRESENT.includes(selector); },
        async evaluate(fn) { return fn({ tagName: 'INPUT', type: 'text' }); },
        async fill(value) { fills.push({ selector, value }); },
        async selectOption() {},
        async check() {},
        async click() {},
      };
    },
  });
  page.getByLabel = () => ({ count: async () => 0, first() { return {}; } });
  return page;
}

function setup({ showValues = false, fieldReport = true, submissionEmail } = {}) {
  const loggedWithExtra = [];
  const h = loadRunner({
    './forms': realForms,
    './logger': {
      logResult: (name, status, detail, extra) => { loggedWithExtra.push({ name, status, detail, extra }); h.logged.push({ name, status, detail }); },
      STATUS_BUCKET: {},
    },
  });
  const lines = [];
  const report = fieldReport ? fr.createFieldReport({ log: (l) => lines.push(l), showValues }) : null;
  h.runner.configure({
    dryRun: true, preview: true, person: PERSON, personCount: 1, capsolver: null,
    brokersFor: build, submissionEmail, ...(report ? { fieldReport: report, showValues } : {}),
  });
  return { h, report, lines, loggedWithExtra };
}

async function runPreview(opts) {
  const s = setup(opts);
  const fills = [];
  const page = fieldPage(fills);
  const out = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => out.push(a.join(' '));
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), build(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  const everything = [...out, ...s.lines, ...(s.report ? s.report.renderTables() : []), JSON.stringify(s.loggedWithExtra)].join('\n');
  return { ...s, fills, everything };
}

test('the table lists exactly the fields the runner typed into, by detail name', async () => {
  const { fills, report, lines } = await runPreview();
  assert.deepEqual(fills.map(f => f.selector), ['#first', '#last', '#email', '#where', '#zip', '#request']);
  const text = lines.join('\n');
  assert.match(text, /first <- first name/);
  assert.match(text, /last <- last name/);
  assert.match(text, /email <- email/);
  assert.match(text, /where <- city \+ state/);
  assert.match(text, /zip <- ZIP/);
  assert.match(text, /request <- fixed text/);
  assert.ok(!/absent|phone/.test(text), 'a field that was not typed is not listed');
  assert.match(report.renderTables().join('\n'), /FixtureBroker\s+\|\s+first name, last name, email, city, state, ZIP, fixed text/);
});

test('no detail value appears anywhere in the output without --show-values', async () => {
  const { everything } = await runPreview();
  for (const v of VALUES) assert.ok(!everything.includes(v), `"${v}" leaked into the output`);
  assert.ok(!/first=ZqFirst/.test(everything));
});

test('with --show-values the values appear on the per-broker lines', async () => {
  const { lines, report, everything } = await runPreview({ showValues: true });
  const text = lines.join('\n');
  assert.ok(text.includes(PERSON.firstName));
  assert.ok(text.includes(PERSON.email));
  assert.ok(text.includes(`${PERSON.city}, ${PERSON.state}`));
  assert.ok(!/ZqFirstNameZq/.test(report.renderTables().join('\n')), 'the closing table never carries values');
  // the run log (logResult) still never carries a value: codex #6 stays true
  const preview = JSON.stringify((everything.match(/\[\{.*\}\]$/s) || [''])[0]);
  assert.ok(!preview.includes(PERSON.firstName));
});

test('--show-values still strips the query string off the target URL', async () => {
  const { loggedWithExtra } = await runPreview({ showValues: true });
  const entry = loggedWithExtra.find(l => l.status === 'preview');
  assert.ok(entry);
  assert.ok(!/ZqFirst|\?first=/.test(entry.detail));
});

test('a relay alias is reported as "masked email" and the real address is never typed', async () => {
  const { fills, lines, everything } = await runPreview({ submissionEmail: ALIAS });
  assert.equal(fills.find(f => f.selector === '#email').value, ALIAS);
  assert.match(lines.join('\n'), /email <- masked email/);
  assert.ok(!everything.includes(ALIAS), 'the alias is a value too');
  assert.ok(!everything.includes(PERSON.email));
});

test('without --fields the preview output is exactly what it was', async () => {
  const { loggedWithExtra, lines, everything } = await runPreview({ fieldReport: false });
  assert.equal(lines.length, 0);
  assert.equal(loggedWithExtra.length, 1);
  assert.deepEqual(
    { name: loggedWithExtra[0].name, status: loggedWithExtra[0].status, detail: loggedWithExtra[0].detail },
    { name: 'FixtureBroker', status: 'preview', detail: 'fields: first=filled → would POST to https://example.com/optout?<params withheld>' },
  );
  assert.ok(!/fields for|<-/.test(everything));
});

test('a broker that cannot be rebuilt is "unmapped", never "fixed text"', async () => {
  const s = setup();
  s.h.runner.configure({ brokersFor: () => [] });
  const page = fieldPage([]);
  const realLog = console.log;
  console.log = () => {};
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), build(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
  }
  const text = s.lines.join('\n');
  assert.match(text, /first <- unmapped/);
  assert.ok(!/fixed text/.test(text));
});

// ── the audit report of a real run ───────────────────────────────────────────

test('a real run attaches the names of the details it typed to every result, never values', async () => {
  const s = setup();
  s.h.runner.configure({ dryRun: false, preview: false, fieldReport: null, showValues: false });
  const submit = { id: 'optout', matches: ['button[type="submit"]'], inForm: true, submits: true };
  const page = fieldPage([]);
  const base = page.locator;
  page.locator = (selector) => (selector.includes('button[type="submit"]')
    ? makePage({ elements: [submit], before: 'Opt out of this site', after: 'Your request has been received. We will remove your listing.' }).locator(selector)
    : base(selector));
  const realLog = console.log;
  console.log = () => {};
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), build(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
  }
  const withFields = s.loggedWithExtra.filter(l => l.extra && l.extra.fields);
  assert.ok(withFields.length > 0, 'the result carries the field names');
  assert.deepEqual(withFields[0].extra.fields, ['first name', 'last name', 'email', 'city', 'state', 'ZIP', 'fixed text']);
  const all = JSON.stringify(s.loggedWithExtra);
  for (const v of VALUES) assert.ok(!all.includes(v), `"${v}" leaked into a logged result`);
});

// ── the search step ──────────────────────────────────────────────────────────

test('the preview shows which details the search URL sends, even when no listing is found', async () => {
  const searchBuild = (p) => [{
    name: 'SearchSite', method: 'search-form',
    searchUrl: `https://search.example/find?q=${encodeURIComponent(p.fullName)}&state=${p.state}`,
    optOutUrl: 'https://search.example/optout', submitSelector: 'button',
    formFields: {},
  }];
  const searched = [];
  const h = loadRunner({
    './forms': { ...realForms, findListingUrl: async (page, broker) => { searched.push(broker.name); return null; } },
  });
  const lines = [];
  const report = fr.createFieldReport({ log: (l) => lines.push(l) });
  h.runner.configure({ dryRun: true, preview: true, person: PERSON, personCount: 1, capsolver: null, brokersFor: searchBuild, fieldReport: report });
  const realLog = console.log;
  console.log = () => {};
  try {
    await h.runner.processBrokerWithPerson(makeContext(makePage()), searchBuild(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(searched, ['SearchSite'], 'the search still runs');
  const out = [...lines, ...report.renderTables()].join('\n');
  assert.match(report.renderTables().join('\n'), /SearchSite\s+\|\s+search: full name, state/);
  for (const v of VALUES) assert.ok(!out.includes(v), `"${v}" leaked`);
});

test('F1: the watcher passes the person\'s own address as submissionEmail when there is no relay; that is "email", not "masked email"', async () => {
  const { lines, report } = await runPreview({ submissionEmail: PERSON.email });
  assert.match(lines.join('\n'), /email <- email$/m);
  assert.ok(!/masked/.test(lines.join('\n') + report.renderTables().join('\n')));
});

// ── F2: every path that fills reaches the report ─────────────────────────────

function previewWith(overrides, brokerOverrides) {
  const s = setup();
  s.h.runner.configure({ noCapsolver: true, ...overrides });
  const broker = { ...build(PERSON)[0], ...brokerOverrides };
  return { s, broker };
}

test('F2: a captchaLikely broker under --no-capsolver is filled and still reaches the report', async () => {
  const { s, broker } = previewWith({}, { captchaLikely: true });
  const page = fieldPage([]);
  const realLog = console.log;
  console.log = () => {};
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), broker, PERSON);
  } finally {
    console.log = realLog;
  }
  assert.match(s.report.renderTables().join('\n'), /FixtureBroker\s+\|\s+first name/);
  assert.ok(!/value/.test(s.lines.join('\n')));
});

test('F2: details in the opt-out URL itself are reported', async () => {
  const urlBuild = (p) => [{ ...build(p)[0], optOutUrl: `https://example.com/optout?n=${encodeURIComponent(p.fullName)}&e=${encodeURIComponent(p.email)}` }];
  const s = setup();
  s.h.runner.configure({ brokersFor: urlBuild });
  const page = fieldPage([]);
  const realLog = console.log;
  console.log = () => {};
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), urlBuild(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
  }
  const out = [...s.lines, ...s.report.renderTables()].join('\n');
  assert.match(out, /opt-out URL: full name, email/);
  for (const v of VALUES) assert.ok(!out.includes(v), `"${v}" leaked`);
});

test('F2: the report names the element that took the value', async () => {
  const s = setup();
  const page = fieldPage([]);
  const base = page.locator;
  page.locator = (sel) => {
    const l = base(sel);
    const first = l.first;
    l.first = () => ({ ...first(), async evaluate(fn) { return fn({ tagName: 'INPUT', type: 'text', name: sel === '#first' ? 'real_first_name' : '', getAttribute: () => null }); } });
    return l;
  };
  const realLog = console.log;
  console.log = () => {};
  try {
    await s.h.runner.processBrokerWithPerson(makeContext(page), build(PERSON)[0], PERSON);
  } finally {
    console.log = realLog;
  }
  assert.match(s.lines.join('\n'), /real_first_name <- first name/);
});
