/**
 * test/dashboard-ui-history.test.js
 *
 * R8 in the browser code (dashboard/public/app.js), run against the fake DOM in
 * dashboard/support/fake-dom.js, the same way dashboard/ui.test.js runs it: the
 * History tab, per-person status columns shown as initials, generic-broker
 * totals in the summary and the CAPTCHA call to action. Everything the server
 * sends is outside data, so every value that reaches innerHTML must be escaped.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, HTML, APP } = require('../dashboard/support/fake-dom');

const PEOPLE = [{ name: 'Alice Smith', initials: 'AS' }, { name: 'Bob Jones', initials: 'BJ' }];
const COUNTS = { submitted: 0, pendingConfirm: 0, unverified: 0, notListed: 0, manual: 0, captchaFailed: 0, errors: 0, dead: 0, skipped: 0 };
const counts = over => ({ ...COUNTS, ...over });

// ---- generic totals in the summary ------------------------------------------------------

test('the summary says how many generic brokers exist and where they stand', async () => {
  const generic = { total: 511, optedOut: 40, pending: 3, error: 1, notListed: 0, manual: 0, other: 0, untried: 467 };
  const app = await loadApp({ routes: { '/summary': { brokers: 54, optedOut: 5, pending: 1, manual: 3, configured: true, generic } } });
  const html = app.els('#summary').innerHTML;
  assert.match(html, /511 generic: 40 opted out, 3 pending, 1 error, 467 not run yet/);
});

test('generic totals leave out the zero buckets and pluralise', async () => {
  const generic = { total: 3, optedOut: 0, pending: 0, error: 2, notListed: 1, manual: 0, other: 0, untried: 0 };
  const app = await loadApp({ routes: { '/summary': { configured: true, generic } } });
  assert.match(app.els('#summary').innerHTML, /3 generic: 2 errors, 1 not listed</);
});

test('no generic pill when the server could not load the datasets', async () => {
  for (const generic of [null, undefined]) {
    const app = await loadApp({ routes: { '/summary': { brokers: 1, configured: true, generic } } });
    assert.doesNotMatch(app.els('#summary').innerHTML, /generic/);
    assert.match(app.els('#summary').innerHTML, /1 brokers/);
  }
});

// ---- CAPTCHA call to action ----------------------------------------------------------------

test('a latest run with CAPTCHA failures shows the count and the exact command', async () => {
  const app = await loadApp({ routes: { '/summary': { configured: true, captchas: { sites: 3, runId: 'run-2026-10-29T03-30-00' } } } });
  const banner = app.els('#captchaBanner');
  assert.equal(banner.classes.has('hidden'), false, 'banner visible');
  assert.match(banner.innerHTML, /3 sites need a CAPTCHA solved/);
  assert.match(banner.innerHTML, /<code>aidr captchas<\/code>/);
});

test('one site is worded in the singular', async () => {
  const app = await loadApp({ routes: { '/summary': { configured: true, captchas: { sites: 1, runId: 'run-x' } } } });
  assert.match(app.els('#captchaBanner').innerHTML, /1 site needs a CAPTCHA solved/);
});

test('no CAPTCHA failures hides the banner, and it hides again once they are solved', async () => {
  let sites = 2;
  const app = await loadApp({ routes: { '/summary': () => ({ configured: true, captchas: { sites, runId: 'run-x' } }) } });
  assert.equal(app.els('#captchaBanner').classes.has('hidden'), false);
  sites = 0;
  await app.run('loadSummary()');
  assert.equal(app.els('#captchaBanner').classes.has('hidden'), true);
  assert.equal(app.els('#captchaBanner').innerHTML, '');
});

test('a summary without captchas, or with nonsense in it, shows no banner', async () => {
  for (const captchas of [undefined, null, {}, { sites: 'many' }, { sites: -4 }, { sites: NaN }]) {
    const app = await loadApp({ routes: { '/summary': { configured: true, captchas } } });
    assert.equal(app.els('#captchaBanner').classes.has('hidden'), true, JSON.stringify(captchas));
  }
});

test('the CAPTCHA banner only offers a command to type: it adds no run button or request', async () => {
  const app = await loadApp({ routes: { '/summary': { configured: true, captchas: { sites: 2, runId: 'x' } } } });
  assert.ok(!app.requests.some(r => r.method === 'POST'), 'nothing is started');
  assert.doesNotMatch(app.els('#captchaBanner').innerHTML, /<button|<a /);
});

// ---- per-person columns in the broker table -----------------------------------------------------

const personBrokers = [
  { name: 'Spokeo', method: 'search-form', priority: 1, usOnly: true, status: {
    key: 'error', label: 'error', date: '2026-02-01T00:00:00.000Z', count: 2,
    people: [{ person: 'Alice Smith', key: 'ok', label: 'success' }, { person: 'Bob Jones', key: 'error', label: 'error' }] } },
  { name: 'MyLife', method: 'direct-form', priority: 2, status: {
    key: 'ok', label: 'success', date: '', count: 1, people: [{ person: null, key: 'ok', label: 'success' }] } },
  { name: 'Intelius', method: 'manual', priority: 3, status: { key: 'manual', label: 'manual', people: [] } },
  { name: 'Whitepages', method: 'email', priority: 2, status: { key: 'none', label: '-', date: '', count: 0, people: [] } },
];

async function tableFor(people, brokers = personBrokers) {
  const app = await loadApp({ routes: { '/summary': { configured: true, people }, '/brokers': brokers, '/config/status': { configured: true } } });
  await app.run('loadBrokers()');
  return { app, head: app.els('#brokerTable thead').innerHTML, body: app.els('#brokerTable tbody').innerHTML };
}

test('more than one person adds a status column per person, headed by initials', async () => {
  const { head } = await tableFor(PEOPLE);
  assert.match(head, /<th class="person-col"[^>]*>AS<\/th>/);
  assert.match(head, /<th class="person-col"[^>]*>BJ<\/th>/);
  assert.ok(head.indexOf('Status') < head.indexOf('>AS<') && head.indexOf('>BJ<') < head.indexOf('Last action'), 'person columns sit between Status and Last action');
});

test('each person cell shows that person\'s own status', async () => {
  const { body } = await tableFor(PEOPLE);
  const spokeo = body.split('</tr>').find(r => r.includes('Spokeo'));
  const cells = [...spokeo.matchAll(/<td class="person-col">(.*?)<\/td>/g)].map(m => m[1]);
  assert.equal(cells.length, 2);
  assert.match(cells[0], /badge ok[^>]*>success</);
  assert.match(cells[1], /badge error[^>]*>error</);
});

test('a state entry with no person tag is the first person\'s, the second has none yet', async () => {
  const { body } = await tableFor(PEOPLE);
  const mylife = body.split('</tr>').find(r => r.includes('MyLife'));
  const cells = [...mylife.matchAll(/<td class="person-col">(.*?)<\/td>/g)].map(m => m[1]);
  assert.match(cells[0], /badge ok[^>]*>success</);
  assert.match(cells[1], /badge none[^>]*>-</);
});

test('manual and never-tried brokers fill the person cells sensibly', async () => {
  const { body } = await tableFor(PEOPLE);
  const intelius = body.split('</tr>').find(r => r.includes('Intelius'));
  assert.equal([...intelius.matchAll(/badge manual/g)].length, 3, 'one aggregate badge and one per person');
  const whitepages = body.split('</tr>').find(r => r.includes('Whitepages'));
  assert.equal([...whitepages.matchAll(/<td class="person-col"><span class="badge none/g)].length, 2);
});

test('the table shows initials only: no full name appears in any row', async () => {
  const { body } = await tableFor(PEOPLE);
  assert.doesNotMatch(body, /Alice|Smith|Bob|Jones/);
  assert.doesNotMatch(body, /\(2 people\)/, 'the aggregate no longer needs the head count');
});

test('with the person columns shown the colspan covers them', async () => {
  const { body } = await tableFor(PEOPLE, []);
  assert.match(body, /colspan="9"/);
});

test('one person keeps the table exactly as it was: no person columns', async () => {
  for (const people of [[], [PEOPLE[0]], undefined]) {
    const { head, body } = await tableFor(people);
    assert.doesNotMatch(head, /person-col/);
    assert.doesNotMatch(body, /person-col/);
    assert.match(body, /badge error[^>]*title="Alice Smith: success; Bob Jones: error">error \(2 people\)/, 'the one-column hover detail is unchanged');
  }
});

test('the table gains its columns when the summary arrives after the brokers', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const app = await loadApp({
    routes: {
      '/brokers': personBrokers,
      '/config/status': { configured: true },
      '/summary': async () => { await gate; return { configured: true, people: PEOPLE }; },
    },
  });
  assert.doesNotMatch(app.els('#brokerTable tbody').innerHTML, /person-col/, 'brokers rendered before anyone is known');
  assert.match(app.els('#brokerTable tbody').innerHTML, /Spokeo/);
  release();
  await app.flush();
  assert.match(app.els('#brokerTable tbody').innerHTML, /person-col/, 're-rendered once the people arrive');
  assert.match(app.els('#brokerTable thead').innerHTML, />AS</);
});

test('the table gains its columns when the brokers arrive after the summary', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const app = await loadApp({
    routes: {
      '/brokers': async () => { await gate; return personBrokers; },
      '/config/status': { configured: true },
      '/summary': { configured: true, people: PEOPLE },
    },
  });
  release();
  await app.flush();
  assert.match(app.els('#brokerTable tbody').innerHTML, /person-col/);
  assert.match(app.els('#brokerTable thead').innerHTML, />BJ</);
});

test('a hostile name or initials from the server is escaped in the header and cells', async () => {
  const hostile = [{ name: '"><img src=x onerror=alert(1)>', initials: '<b>X</b>' }, { name: 'Bob Jones', initials: 'BJ' }];
  const brokers = [{ name: 'Spokeo', method: 'search-form', status: { key: 'ok', label: 'success', count: 1,
    people: [{ person: '"><img src=x onerror=alert(1)>', key: 'ok', label: '<i>success</i>' }] } }];
  const { head, body } = await tableFor(hostile, brokers);
  assert.doesNotMatch(head + body, /<img|<b>|<i>/);
  assert.match(head, /&lt;b&gt;X&lt;\/b&gt;/);
});

test('the person columns survive a failed load: the error row spans them', async () => {
  const app = await loadApp({ routes: { '/summary': { configured: true, people: PEOPLE }, '/brokers': { error: 'boom' }, '/config/status': { configured: true } } });
  await app.run('loadBrokers()');
  assert.match(app.els('#brokerTable tbody').innerHTML, /colspan="9"[^>]*>failed to load brokers: boom/);
});

// ---- History tab -------------------------------------------------------------------------------

const RUNS = {
  runs: [
    {
      id: 'run-2026-10-29T03-30-00', startedAt: '2026-10-29T03:30:00.000Z', source: 'summary', complete: true, mode: 'full', partial: false, filter: null,
      total: 14, counts: counts({ submitted: 9, pendingConfirm: 2, errors: 1, captchaFailed: 2 }), captchaSites: 2,
      people: [
        { person: 'Alice Smith', initials: 'AS', total: 8, counts: counts({ submitted: 5, errors: 1, captchaFailed: 2 }) },
        { person: 'Bob Jones', initials: 'BJ', total: 6, counts: counts({ submitted: 4, pendingConfirm: 2 }) },
      ],
    },
    {
      id: 'run-2026-10-01T03-30-00', startedAt: '2026-10-01T03:30:00.000Z', source: 'summary', complete: true, mode: 'partial', partial: true,
      filter: { only: 'Spokeo', skip: null, retryFailed: true, resume: false }, total: 1, counts: counts({ submitted: 1 }), captchaSites: 0, people: [],
    },
    { id: 'run-2026-09-15T03-30-00', startedAt: '2026-09-15T03:30:00.000Z', source: 'journal', complete: false, mode: 'incomplete', partial: false, filter: null, total: 40, counts: counts({ submitted: 30, errors: 10 }), captchaSites: 0, people: [] },
    { id: 'run-2026-08-01T03-30-00', startedAt: '2026-08-01T03:30:00.000Z', source: 'summary', complete: false, mode: 'unreadable', partial: false, filter: null, total: 0, counts: counts(), captchaSites: 0, people: [], error: 'unreadable' },
  ],
  total: 4, limit: 20, offset: 0, hasMore: false,
};

test('the History tab renders each run: date, kind, counts per status and per person', async () => {
  const app = await loadApp({ routes: { '/runs': RUNS } });
  await app.run('loadHistory()');
  const html = app.els('#historyTable tbody').innerHTML;
  const rows = html.split('</tr>').filter(r => r.includes('<tr'));
  assert.equal(rows.length, 4);
  assert.match(rows[0], /run-2026-10-29T03-30-00/);
  assert.match(rows[0], /full run/);
  assert.match(rows[0], /9 submitted/);
  assert.match(rows[0], /2 pending confirmation/);
  assert.match(rows[0], /2 CAPTCHA failed/);
  assert.match(rows[0], /1 error</, 'one error, not "1 errors"');
  assert.doesNotMatch(rows[0], /0 unverified|0 dead/, 'zero buckets are left out');
  assert.match(rows[0], /AS<\/span>[^]*5 submitted[^]*BJ<\/span>[^]*4 submitted/, 'per-person counts, as initials');
  assert.match(rows[1], /partial: retry failed, only Spokeo/);
  assert.match(rows[2], /incomplete/);
  assert.match(rows[3], /unreadable log \(could not be parsed\)/);
  assert.match(app.els('#historyState').textContent, /Showing 1-4 of 4 runs/);
});

test('History shows initials only, never a person\'s full name', async () => {
  const app = await loadApp({ routes: { '/runs': RUNS } });
  await app.run('loadHistory()');
  assert.doesNotMatch(app.els('#historyTable tbody').innerHTML, /Alice|Smith|Bob|Jones/);
});

test('History says so when there are no runs, and when the load fails', async () => {
  const empty = await loadApp({ routes: { '/runs': { runs: [], total: 0, limit: 20, offset: 0, hasMore: false } } });
  await empty.run('loadHistory()');
  assert.match(empty.els('#historyTable tbody').innerHTML, /No runs yet/);
  assert.equal(empty.els('#historyOlder').disabled, true);
  assert.equal(empty.els('#historyNewer').disabled, true);
  const failed = await loadApp({ routes: { '/runs': { error: 'nope <b>x</b>' } } });
  await failed.run('loadHistory()');
  assert.match(failed.els('#historyTable tbody').innerHTML, /failed to load run history: nope &lt;b&gt;x&lt;\/b&gt;/);
});

test('History pages through the runs with Older and Newer', async () => {
  const app = await loadApp({ routes: { '/runs': ({ query }) => ({ runs: [], total: 45, limit: 20, offset: Number(query.offset), hasMore: Number(query.offset) + 20 < 45 }) } });
  await app.run('loadHistory(0)');
  assert.equal(app.els('#historyNewer').disabled, true, 'nothing newer than the first page');
  assert.equal(app.els('#historyOlder').disabled, false);
  await app.els('#historyOlder').click();
  await app.els('#historyOlder').click();
  assert.deepEqual(app.requests.filter(r => r.key === '/runs').map(r => [r.query.limit, r.query.offset]), [['20', '0'], ['20', '20'], ['20', '40']]);
  assert.equal(app.els('#historyOlder').disabled, true, 'the last page');
  assert.equal(app.els('#historyNewer').disabled, false);
  await app.els('#historyNewer').click();
  assert.equal(app.requests.filter(r => r.key === '/runs').pop().query.offset, '20');
});

test('every run field that reaches the page is escaped', async () => {
  const hostile = {
    runs: [{
      id: 'run-"><img src=x onerror=alert(1)>', startedAt: '<script>alert(1)</script>', source: 'summary', complete: true, mode: 'partial', partial: true,
      filter: { only: '<img src=x onerror=alert(2)>', skip: '"><svg onload=alert(3)>', retryFailed: false, resume: false },
      total: 1, counts: counts({ submitted: 1 }), captchaSites: 0,
      people: [{ person: 'x', initials: '<u>ZZ</u>', total: 1, counts: counts({ submitted: 1 }) }],
    }, { id: 'run-x', startedAt: '2026-10-29T03:30:00.000Z', mode: 'unreadable', error: '<b>bad</b>', counts: counts(), people: [] }],
    total: 2, limit: 20, offset: 0, hasMore: false,
  };
  const app = await loadApp({ routes: { '/runs': hostile } });
  await app.run('loadHistory()');
  const html = app.els('#historyTable tbody').innerHTML;
  assert.doesNotMatch(html, /<img|<script|<svg|<u>|<b>/);
  assert.match(html, /&lt;img/);
});

// ---- one run's rows ----------------------------------------------------------------------------

const DETAIL = {
  run: RUNS.runs[0],
  rows: [
    { broker: 'Spokeo', person: 'Alice Smith', initials: 'AS', status: 'success', key: 'ok', detail: '', host: 'spokeo.com', time: '3:30:01 AM' },
    { broker: 'MyLife', person: 'Bob Jones', initials: 'BJ', status: 'error', key: 'error', detail: 'optOutUrl:www.mylife.com', time: '3:31:00 AM' },
    { broker: 'Acme', person: null, initials: null, status: 'captcha_failed', key: 'error', detail: 'x', time: '' },
  ],
  truncated: false, rowCount: 3,
};

test('opening a run lists its brokers with the person as initials and the status as a badge', async () => {
  const app = await loadApp({ routes: { '/runs/run-2026-10-29T03-30-00': DETAIL } });
  await app.run("viewRun('run-2026-10-29T03-30-00')");
  assert.equal(app.els('#runDetail').classes.has('hidden'), false, 'the detail panel opens');
  const html = app.els('#runDetailTable tbody').innerHTML;
  assert.equal(html.split('</tr>').filter(r => r.includes('<tr')).length, 3);
  assert.match(html, /Spokeo[^]*spokeo\.com[^]*AS[^]*badge ok[^>]*>success</);
  assert.match(html, /MyLife[^]*BJ[^]*badge error[^>]*>error</);
  assert.match(html, /optOutUrl:www\.mylife\.com/);
  assert.doesNotMatch(html, /Alice|Smith|Bob|Jones/);
  assert.match(app.els('#runDetailTitle').textContent, /run-2026-10-29T03-30-00/);
});

test('the run id is encoded into the request path', async () => {
  const app = await loadApp({ routes: {} });
  await app.run("viewRun('run-a/../b')");
  assert.equal(app.requests.find(r => r.url.includes('/runs/')).url, '/api/runs/run-a%2F..%2Fb');
});

test('the status filter narrows the rows shown', async () => {
  const app = await loadApp({ routes: { '/runs/run-x': DETAIL } });
  await app.run("viewRun('run-x')");
  assert.match(app.els('#runDetailFilter').innerHTML, /<option value="all">all/);
  assert.match(app.els('#runDetailFilter').innerHTML, /<option value="captcha_failed">captcha_failed/);
  app.els('#runDetailFilter').value = 'error';
  await app.els('#runDetailFilter').fire('change');
  const rows = app.els('#runDetailTable tbody').innerHTML.split('</tr>').filter(r => r.includes('<tr'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /MyLife/);
});

test('every row field is escaped, and a truncated run says so', async () => {
  const detail = {
    run: RUNS.runs[0], truncated: true, rowCount: 9999,
    rows: [{ broker: '<img src=x onerror=alert(1)>', person: null, initials: '<b>', status: '"><svg onload=1>', key: '"><x>', detail: '<script>1</script>', host: '<h>', time: '' }],
  };
  const app = await loadApp({ routes: { '/runs/run-x': detail } });
  await app.run("viewRun('run-x')");
  const html = app.els('#runDetailTable tbody').innerHTML + app.els('#runDetailFilter').innerHTML;
  assert.doesNotMatch(html, /<img|<b>|<svg|<script|<h>|<x>/);
  assert.match(app.els('#runDetailNote').textContent, /1 of 9999/);
});

test('an unreadable or missing run shows the server message instead of rows', async () => {
  const app = await loadApp({ routes: { '/runs/run-x': { error: 'run log is unreadable <i>' } } });
  await app.run("viewRun('run-x')");
  assert.match(app.els('#runDetailTable tbody').innerHTML, /run log is unreadable &lt;i&gt;/);
});

test('clicking View on a history row opens that run', async () => {
  const app = await loadApp({ routes: { '/runs': RUNS, '/runs/run-2026-10-29T03-30-00': DETAIL } });
  await app.run('loadHistory()');
  const button = { dataset: { run: 'run-2026-10-29T03-30-00' } };
  await app.els('#historyTable').fire('click', { target: { closest: () => button } });
  await app.flush();
  assert.ok(app.requests.some(r => r.key === '/runs/run-2026-10-29T03-30-00'));
  await app.els('#historyTable').fire('click', { target: { closest: () => null } });
  assert.equal(app.requests.filter(r => r.key.startsWith('/runs/')).length, 1, 'a click elsewhere in the table does nothing');
});

test('opening the History tab loads the newest page', async () => {
  const tab = Object.assign(require('../dashboard/support/fake-dom').fakeEl(), { dataset: { tab: 'history' } });
  const app = await loadApp({ routes: { '/runs': RUNS }, lists: { '.tab': [tab] } });
  assert.ok(!app.requests.some(r => r.key === '/runs'), 'nothing is fetched until the tab is opened');
  await tab.click();
  await app.flush();
  const req = app.requests.find(r => r.key === '/runs');
  assert.ok(req);
  assert.equal(req.query.offset, '0');
  assert.equal(app.els('#tab-history').classes.has('hidden'), false);
});

// ---- page structure -----------------------------------------------------------------------------

test('index.html has the History tab, its panel and every element app.js reaches for', () => {
  assert.match(HTML, /<button[^>]*role="tab"[^>]*aria-controls="tab-history"[^>]*data-tab="history"[^>]*>History<\/button>/);
  assert.match(HTML, /<section[^>]*id="tab-history" role="tabpanel" aria-labelledby="tabbtn-history"/);
  for (const id of ['tabbtn-history', 'historyTable', 'historyState', 'historyNewer', 'historyOlder', 'runDetail', 'runDetailTitle',
    'runDetailFilter', 'runDetailTable', 'runDetailNote', 'captchaBanner']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `#${id}`);
    assert.ok(APP.includes(`#${id}`) || id === 'tabbtn-history', `app.js uses #${id}`);
  }
  assert.match(HTML, /class="[^"]*\bhidden\b[^"]*" id="tab-history"/, 'the panel starts hidden');
  assert.match(HTML, /class="[^"]*\bhidden\b[^"]*" id="captchaBanner"/, 'the banner starts hidden');
  assert.match(HTML, /class="[^"]*\bhidden\b[^"]*" id="runDetail"/, 'the detail starts hidden');
});

test('the static table head and the one the script renders use the same column classes', async () => {
  const staticClasses = [...HTML.match(/<table class="grid" id="brokerTable">[^]*?<\/thead>/)[0].matchAll(/<th class="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(staticClasses, ['c-method', 'c-pri', 'c-scope', 'c-last']);
  const { head } = await tableFor(PEOPLE);
  const rendered = [...head.matchAll(/<th class="([^"]*)"/g)].map(m => m[1]).filter(c => c !== 'person-col');
  assert.deepEqual(rendered, staticClasses);
});
