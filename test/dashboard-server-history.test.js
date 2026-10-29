/**
 * test/dashboard-server-history.test.js
 *
 * R8 over HTTP, through the dashboard's own test harness (temp dir, stub
 * credentials, fs-guard): GET /api/runs, GET /api/runs/:id and the people,
 * generic-broker and CAPTCHA additions to GET /api/summary.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HAS_EXPRESS = fs.existsSync(path.join(__dirname, '..', 'dashboard', 'node_modules', 'express'));
const skipNoExpress = HAS_EXPRESS ? false : 'dashboard dependencies are not installed (run: cd dashboard && npm ci)';

const harness = HAS_EXPRESS ? require('../dashboard/support/harness') : null;

async function withServer(opts, fn) {
  const h = await harness.startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: '10:00:00 AM', ...extra });
const runLog = (over = {}) => ({
  runAt: '2026-10-29T03:30:00.000Z',
  succeeded: [], skipped: [], notFound: [], captchaFailed: [], manual: [], errors: [], dead: [], pendingConfirm: [], unverified: [],
  ...over,
});
function writeRun(h, name, body) {
  fs.mkdirSync(h.paths.logs, { recursive: true });
  fs.writeFileSync(path.join(h.paths.logs, name), typeof body === 'string' ? body : JSON.stringify(body));
}

const TWO_PEOPLE = {
  persons: [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.org', zip: '73301' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.org', zip: '02108' },
  ],
};
const BROKERS = [
  { name: 'Spokeo', method: 'search-form', priority: 1 },
  { name: 'MyLife', method: 'direct-form', priority: 2 },
];
const GENERIC = [{ name: 'Acme Data' }, { name: 'Bolt Search' }, { name: 'Cedar Records' }];

// ---- auth ---------------------------------------------------------------------------

test('the run history routes require auth like every other API route', { skip: skipNoExpress }, async () => {
  await withServer({}, async ({ rawRequest }) => {
    assert.equal((await rawRequest({ pathname: '/api/runs' })).status, 401);
    assert.equal((await rawRequest({ pathname: '/api/runs/run-2026-10-29T03-30-00' })).status, 401);
  });
});

// ---- GET /api/runs --------------------------------------------------------------------

test('GET /api/runs with no logs directory is an empty page', { skip: skipNoExpress }, async () => {
  await withServer({}, async ({ request }) => {
    const r = await request({ pathname: '/api/runs' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { runs: [], total: 0, limit: 20, offset: 0, hasMore: false });
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

test('GET /api/runs lists run summaries and journals newest first', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    writeRun(h, 'run-2026-09-01T03-30-00.json', runLog({ runAt: '2026-09-01T03:30:00.000Z', succeeded: [entry('A', 'success')] }));
    writeRun(h, 'run-2026-10-01T03-30-00.json', runLog({
      runAt: '2026-10-01T03:30:00.000Z', partial: true, filter: { only: 'Spokeo', skip: null, retryFailed: false, resume: false },
      errors: [entry('Spokeo', 'error', { person: 'Alice Smith' })],
    }));
    writeRun(h, 'run-2026-10-29T03-30-00.jsonl', `${JSON.stringify(entry('A', 'success'))}\n${JSON.stringify(entry('B', 'captcha_failed'))}\n{"torn`);
    const r = await h.request({ pathname: '/api/runs' });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 3);
    assert.deepEqual(r.json.runs.map(x => [x.id, x.mode, x.source]), [
      ['run-2026-10-29T03-30-00', 'incomplete', 'journal'],
      ['run-2026-10-01T03-30-00', 'partial', 'summary'],
      ['run-2026-09-01T03-30-00', 'full', 'summary'],
    ]);
    assert.equal(r.json.runs[0].counts.captchaFailed, 1);
    assert.equal(r.json.runs[1].filter.only, 'Spokeo');
    assert.equal(r.json.runs[1].people[0].initials, 'AS');
  });
});

test('GET /api/runs paginates with limit and offset and caps the page size', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    for (let d = 1; d <= 12; d++) writeRun(h, `run-2026-09-${String(d).padStart(2, '0')}T03-30-00.json`, runLog());
    const a = (await h.request({ pathname: '/api/runs?limit=5' })).json;
    assert.equal(a.runs.length, 5);
    assert.equal(a.runs[0].id, 'run-2026-09-12T03-30-00');
    assert.equal(a.hasMore, true);
    const c = (await h.request({ pathname: '/api/runs?limit=5&offset=10' })).json;
    assert.deepEqual(c.runs.map(x => x.id), ['run-2026-09-02T03-30-00', 'run-2026-09-01T03-30-00']);
    assert.equal(c.hasMore, false);
    assert.equal((await h.request({ pathname: '/api/runs?limit=999999' })).json.limit, 100);
    assert.equal((await h.request({ pathname: '/api/runs?limit=abc&offset=-4' })).json.limit, 20);
    assert.equal((await h.request({ pathname: '/api/runs?limit[a]=1&offset[]=2' })).status, 200);
    assert.equal((await h.request({ pathname: '/api/runs?limit=1&limit=2' })).status, 200);
  });
});

test('GET /api/runs survives garbage files in the logs directory', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    writeRun(h, 'run-2026-10-01T03-30-00.json', 'this is not json');
    writeRun(h, 'run-2026-10-02T03-30-00.json', runLog({ succeeded: [entry('A', 'success')] }));
    const r = await h.request({ pathname: '/api/runs' });
    assert.equal(r.status, 200);
    assert.equal(r.json.runs.length, 2);
    assert.equal(r.json.runs[0].total, 1);
    assert.equal(typeof r.json.runs[1].error, 'string');
  });
});

// ---- GET /api/runs/:id ------------------------------------------------------------------

test('GET /api/runs/:id returns the per-broker rows with each person as initials',{ skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    writeRun(h, 'run-2026-10-29T03-30-00.json', runLog({
      succeeded: [entry('Spokeo', 'success', { person: 'Alice Smith' })],
      errors: [entry('MyLife', 'error', { person: 'Bob Jones', detail: 'timeout' })],
    }));
    const r = await h.request({ pathname: '/api/runs/run-2026-10-29T03-30-00' });
    assert.equal(r.status, 200);
    assert.equal(r.json.run.id, 'run-2026-10-29T03-30-00');
    assert.equal(r.json.run.counts.errors, 1);
    assert.deepEqual(r.json.rows.map(x => [x.broker, x.initials, x.status, x.key, x.detail]), [
      ['Spokeo', 'AS', 'success', 'ok', ''],
      ['MyLife', 'BJ', 'error', 'error', 'timeout'],
    ]);
    assert.equal(r.json.truncated, false);
  });
});

test('GET /api/runs/:id never returns a full URL or a query string', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    writeRun(h, 'run-2026-10-29T03-30-00.json', runLog({
      pendingConfirm: [entry('Spokeo', 'pending_confirm', { detail: 'optOutUrl:https://www.spokeo.com/optout?email=alice%40example.org&zip=73301' })],
      manual: [entry('Intelius', 'manual', { detail: 'https://intelius.example/request/alice-smith?token=SECRET123' })],
      errors: [entry('MyLife', 'error', { detail: 'mailto:privacy@mylife.example?body=Alice%20Smith%2073301' })],
    }));
    const r = await h.request({ pathname: '/api/runs/run-2026-10-29T03-30-00' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.raw, /https?:\/\//);
    assert.doesNotMatch(r.raw, /SECRET123|73301|alice%40|alice-smith|Alice%20/i);
    assert.equal(r.json.rows.find(x => x.broker === 'Spokeo').detail, 'optOutUrl:www.spokeo.com');
    assert.equal(r.json.rows.find(x => x.broker === 'MyLife').detail, 'mailto:privacy@mylife.example');
  });
});

test('GET /api/runs/:id for an unknown run is a JSON 404, for an unreadable one a JSON 422', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    const missing = await h.request({ pathname: '/api/runs/run-2030-01-01T00-00-00' });
    assert.equal(missing.status, 404);
    assert.equal(typeof missing.json.error, 'string');
    writeRun(h, 'run-2026-10-29T03-30-00.json', 'garbage');
    const bad = await h.request({ pathname: '/api/runs/run-2026-10-29T03-30-00' });
    assert.equal(bad.status, 422);
    assert.doesNotMatch(bad.raw, /\/Users\/|\/tmp\/|\/var\//);
  });
});

test('GET /api/runs/:id rejects path traversal and never reads outside the logs directory', { skip: skipNoExpress }, async () => {
  await withServer({ stateContent: { optOuts: { Marker: { history: ['success'] } } } }, async (h) => {
    fs.mkdirSync(h.paths.logs, { recursive: true });
    writeRun(h, 'run-2026-10-29T03-30-00.json', runLog());
    // Valid-looking run logs OUTSIDE the logs directory, reachable only by traversal.
    fs.writeFileSync(path.join(h.paths.dir, 'run-outside.json'), JSON.stringify(runLog({ succeeded: [entry('OUTSIDE-MARKER', 'success')] })));
    fs.writeFileSync(path.join(h.paths.dir, 'secret.json'), JSON.stringify({ leak: 'OUTSIDE-MARKER' }));
    // run-x/ exists, so "run-x/../../run-outside" resolves to the file above when
    // nothing but a "run-" prefix is checked.
    fs.mkdirSync(path.join(h.paths.logs, 'run-x'));
    const attempts = [
      '/api/runs/run-x%2F..%2F..%2Frun-outside',
      '/api/runs/run-x%5C..%5C..%5Crun-outside',
      '/api/runs/..%2Frun-outside',
      '/api/runs/%2e%2e%2frun-outside',
      '/api/runs/run-..%2Frun-outside',
      '/api/runs/..%2fstate',
      '/api/runs/..%5Csecret',
      '/api/runs/..%2Fsecret',
      '/api/runs/%2Fetc%2Fpasswd',
      '/api/runs/run-2026-10-29T03-30-00.json',
      '/api/runs/run-%00x',
      '/api/runs/run-a%2Fb',
      '/api/runs/../run-outside',
      '/api/runs/....//run-outside',
      '/api/runs/' + encodeURIComponent('run-' + 'a'.repeat(300)),
    ];
    for (const pathname of attempts) {
      const r = await h.request({ pathname });
      assert.ok(r.status === 400 || r.status === 404, `${pathname} -> ${r.status}`);
      assert.doesNotMatch(r.raw, /OUTSIDE-MARKER|Marker/, pathname);
      assert.doesNotMatch(r.raw, /\/Users\/|\/tmp\/|\/var\/folders/, pathname);
    }
    assert.equal((await h.request({ pathname: '/api/runs/run-2026-10-29T03-30-00' })).status, 200, 'a real id still works');
  });
});

test('a symlinked run log is not served', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    fs.mkdirSync(h.paths.logs, { recursive: true });
    const outside = path.join(h.paths.dir, 'elsewhere.json');
    fs.writeFileSync(outside, JSON.stringify(runLog({ succeeded: [entry('OUTSIDE-MARKER', 'success')] })));
    fs.symlinkSync(outside, path.join(h.paths.logs, 'run-2026-10-29T03-30-00.json'));
    const r = await h.request({ pathname: '/api/runs/run-2026-10-29T03-30-00' });
    assert.equal(r.status, 404);
    assert.doesNotMatch(r.raw, /OUTSIDE-MARKER/);
    assert.equal((await h.request({ pathname: '/api/runs' })).json.total, 0);
  });
});

test('the raw log viewer still lists the same files it did', { skip: skipNoExpress }, async () => {
  await withServer({}, async (h) => {
    writeRun(h, 'run-2026-10-29T03-30-00.json', runLog());
    const files = (await h.request({ pathname: '/api/logs' })).json;
    assert.deepEqual(files.map(f => f.name), ['run-2026-10-29T03-30-00.json']);
  });
});

// ---- GET /api/summary additions -----------------------------------------------------------

test('summary lists the config people with initials', { skip: skipNoExpress }, async () => {
  await withServer({ cfgContent: TWO_PEOPLE, options: { brokers: BROKERS, genericBrokers: GENERIC } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.deepEqual(s.people, [{ name: 'Alice Smith', initials: 'AS' }, { name: 'Bob Jones', initials: 'BJ' }]);
  });
});

test('summary people is empty with no config, and falls back to state when the config is locked', { skip: skipNoExpress }, async () => {
  await withServer({ options: { brokers: BROKERS, genericBrokers: GENERIC } }, async ({ request }) => {
    assert.deepEqual((await request({ pathname: '/api/summary' })).json.people, []);
  });
  const stateContent = { optOuts: { 'Spokeo|Alice Smith': { history: ['success'] }, 'Spokeo|Bob Jones': { history: ['error'] } } };
  const encContent = { v: 1, locked: 'not a real envelope' };
  await withServer({ encContent, stateContent, options: { brokers: BROKERS, genericBrokers: GENERIC } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.configLocked, true);
    assert.deepEqual(s.people.map(p => p.initials), ['AS', 'BJ']);
  });
});

test('summary counts the generic brokers and totals their state', { skip: skipNoExpress }, async () => {
  const stateContent = {
    optOuts: {
      'Acme Data|Alice Smith': { history: ['success'] },
      'Acme Data|Bob Jones': { history: ['success'] },
      'Bolt Search|Alice Smith': { history: ['error'] },
      'Spokeo|Alice Smith': { history: ['success'] },
    },
  };
  await withServer({ cfgContent: TWO_PEOPLE, stateContent, options: { brokers: BROKERS, genericBrokers: GENERIC } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.deepEqual(s.generic, { total: 3, optedOut: 1, pending: 0, error: 1, notListed: 0, manual: 0, other: 0, untried: 1 });
    assert.equal(s.brokers, 2, 'the explicit broker count is unchanged');
    assert.equal(s.optedOut, 1, 'and so is its opted-out count: generic rows are not mixed in');
  });
});

test('summary reports generic as null when the datasets cannot be loaded', { skip: skipNoExpress }, async () => {
  await withServer({ options: { brokers: BROKERS, genericBrokers: () => { throw new Error('no data'); } } }, async ({ request }) => {
    const r = await request({ pathname: '/api/summary' });
    assert.equal(r.status, 200);
    assert.equal(r.json.generic, null);
  });
});

test('summary generic total comes from the shipped datasets when nothing is injected', { skip: skipNoExpress }, async () => {
  await withServer({ options: { brokers: BROKERS } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.ok(s.generic.total > 400, `got ${s.generic && s.generic.total}`);
    assert.equal(s.generic.untried, s.generic.total, 'an empty state has run none of them');
  });
});

test('summary says how many sites the latest run left at a CAPTCHA', { skip: skipNoExpress }, async () => {
  await withServer({ options: { brokers: BROKERS, genericBrokers: GENERIC } }, async (h) => {
    assert.deepEqual((await h.request({ pathname: '/api/summary' })).json.captchas, { sites: 0, runId: null });
    writeRun(h, 'run-2026-10-01T03-30-00.json', runLog({ captchaFailed: [entry('Old A', 'captcha_failed'), entry('Old B', 'captcha_failed')] }));
    writeRun(h, 'run-2026-10-29T03-30-00.json', runLog({
      captchaFailed: [entry('Site A', 'captcha_failed', { person: 'Alice Smith' }), entry('Site A', 'captcha_failed', { person: 'Bob Jones' }), entry('Site B', 'captcha_failed', { person: 'Alice Smith' })],
    }));
    assert.deepEqual((await h.request({ pathname: '/api/summary' })).json.captchas, { sites: 2, runId: 'run-2026-10-29T03-30-00' });
    writeRun(h, 'run-2026-10-30T03-30-00.json', runLog({ succeeded: [entry('Site A', 'success')] }));
    assert.deepEqual((await h.request({ pathname: '/api/summary' })).json.captchas, { sites: 0, runId: 'run-2026-10-30T03-30-00' }, 'the latest run is the one that counts');
  });
});

test('the existing summary fields are unchanged', { skip: skipNoExpress }, async () => {
  const stateContent = { optOuts: { 'Spokeo|A B': { history: ['success'] }, MyLife: { history: ['pending_confirm'] } } };
  await withServer({ stateContent, options: { brokers: BROKERS, genericBrokers: GENERIC } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/summary' })).json;
    assert.equal(s.brokers, 2);
    assert.equal(s.optedOut, 1);
    assert.equal(s.pending, 1);
    assert.equal(s.stateExists, true);
  });
});
