/**
 * test/dashboard-runs.test.js
 *
 * R8: the dashboard's run-history tab reads logs/run-*.json (the end-of-run
 * summary) and logs/run-*.jsonl (the crash-safe journal another package adds).
 * dashboard/runs.js is the pure half: list, summarize and read one run. The
 * log directory is user-writable and its files hold PII, so it must survive
 * garbage and must never hand a full URL back out.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns, readRun, latestRun, redactDetail, isRunId, MAX_LIMIT, MAX_ROWS } = require('../dashboard/runs');

function tmpLogs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-runs-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const entry = (broker, status, extra = {}) => ({ broker, status, detail: '', time: '10:00:00 AM', ...extra });

function runLog(over = {}) {
  return {
    runAt: '2026-10-29T03:30:00.000Z',
    succeeded: [], skipped: [], notFound: [], captchaFailed: [], manual: [], errors: [], dead: [], pendingConfirm: [], unverified: [],
    ...over,
  };
}

function write(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
}
const lines = (...objs) => objs.map(o => JSON.stringify(o)).join('\n') + '\n';

test('a missing logs directory is an empty history, not an error', () => {
  assert.deepEqual(listRuns(path.join(os.tmpdir(), 'aidr-no-such-dir-xyz')), { runs: [], total: 0, limit: 20, offset: 0, hasMore: false });
  assert.equal(latestRun(path.join(os.tmpdir(), 'aidr-no-such-dir-xyz')), null);
});

test('counts per status come from the run log buckets', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      succeeded: [entry('A', 'success'), entry('B', 'success')],
      pendingConfirm: [entry('C', 'pending_confirm')],
      unverified: [entry('D', 'unverified')],
      notFound: [entry('E', 'notFound')],
      manual: [entry('F', 'manual')],
      captchaFailed: [entry('G', 'captcha_failed')],
      errors: [entry('H', 'error'), entry('I', 'error')],
      dead: [entry('J', 'dead')],
      skipped: [entry('K', 'skipped')],
    }));
    const { runs } = listRuns(dir);
    assert.equal(runs.length, 1);
    const r = runs[0];
    assert.equal(r.id, 'run-2026-10-29T03-30-00');
    assert.equal(r.startedAt, '2026-10-29T03:30:00.000Z');
    assert.equal(r.source, 'summary');
    assert.equal(r.complete, true);
    assert.equal(r.mode, 'full');
    assert.equal(r.partial, false);
    assert.equal(r.filter, null);
    assert.deepEqual(r.counts, {
      submitted: 2, pendingConfirm: 1, unverified: 1, notListed: 1, manual: 1, captchaFailed: 1, errors: 2, dead: 1, skipped: 1,
    });
    assert.equal(r.total, 11);
    assert.deepEqual(r.people, []);
  } finally { done(); }
});

test('a partial run carries its filter marker', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      partial: true, filter: { only: 'Spokeo,MyLife', skip: null, retryFailed: false, resume: false },
      succeeded: [entry('Spokeo', 'success')],
    }));
    const [r] = listRuns(dir).runs;
    assert.equal(r.mode, 'partial');
    assert.equal(r.partial, true);
    assert.deepEqual(r.filter, { only: 'Spokeo,MyLife', skip: null, retryFailed: false, resume: false });
  } finally { done(); }
});

test('a filter with hostile or non-string fields is normalised, never passed through', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      partial: true, filter: { only: { evil: 1 }, skip: 'X'.repeat(5000), retryFailed: 'yes', resume: 1, extra: '<script>' },
    }));
    const [r] = listRuns(dir).runs;
    assert.equal(r.filter.only, null);
    assert.ok(r.filter.skip.length <= 300);
    assert.equal(r.filter.retryFailed, true);
    assert.equal(r.filter.resume, true);
    assert.equal('extra' in r.filter, false);
  } finally { done(); }
});

test('per-person counts appear when entries carry a person, with unique initials', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      succeeded: [entry('A', 'success', { person: 'Alice Smith' }), entry('B', 'success', { person: 'Adam Stone' }), entry('C', 'success', { person: 'Alice Smith' })],
      errors: [entry('A', 'error', { person: 'Adam Stone' })],
    }));
    const [r] = listRuns(dir).runs;
    assert.deepEqual(r.people.map(p => [p.person, p.initials, p.counts.submitted, p.counts.errors]), [
      ['Alice Smith', 'AS', 2, 0],
      ['Adam Stone', 'AS2', 1, 1],
    ]);
  } finally { done(); }
});

test('a run with no person tags has no people breakdown', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({ succeeded: [entry('A', 'success')] }));
    assert.deepEqual(listRuns(dir).runs[0].people, []);
  } finally { done(); }
});

test('runs are newest first and paginated, and the page size is capped', () => {
  const { dir, done } = tmpLogs();
  try {
    for (let d = 1; d <= 25; d++) {
      const day = String(d).padStart(2, '0');
      write(dir, `run-2026-09-${day}T03-30-00.json`, runLog({ runAt: `2026-09-${day}T03:30:00.000Z`, succeeded: [entry('A', 'success')] }));
    }
    const first = listRuns(dir, { limit: 10 });
    assert.equal(first.total, 25);
    assert.equal(first.runs.length, 10);
    assert.equal(first.runs[0].id, 'run-2026-09-25T03-30-00');
    assert.equal(first.hasMore, true);
    const last = listRuns(dir, { limit: 10, offset: 20 });
    assert.deepEqual(last.runs.map(r => r.id), [
      'run-2026-09-05T03-30-00', 'run-2026-09-04T03-30-00', 'run-2026-09-03T03-30-00', 'run-2026-09-02T03-30-00', 'run-2026-09-01T03-30-00',
    ]);
    assert.equal(last.hasMore, false);
    assert.equal(listRuns(dir).limit, 20, 'default page size');
    assert.equal(listRuns(dir, { limit: 100000 }).limit, MAX_LIMIT);
    assert.equal(listRuns(dir, { limit: -3, offset: -9 }).offset, 0);
    assert.equal(listRuns(dir, { limit: 'abc', offset: 'x' }).limit, 20);
    assert.deepEqual(listRuns(dir, { offset: 999 }).runs, []);
  } finally { done(); }
});

test('only run-*.json and run-*.jsonl regular files are runs', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog());
    write(dir, 'audit-2026-10-29T03-30-00.md', '# audit');
    write(dir, 'run-2026-10-29T03-30-00.txt', 'x');
    write(dir, 'notes.json', '{}');
    write(dir, 'run-.json', '{}');
    write(dir, 'run-bad name.json', '{}');
    fs.mkdirSync(path.join(dir, 'run-2026-01-01T00-00-00.json'));
    const outside = path.join(dir, '..', `aidr-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(runLog()));
    fs.symlinkSync(outside, path.join(dir, 'run-2026-02-02T00-00-00.json'));
    try {
      assert.deepEqual(listRuns(dir).runs.map(r => r.id), ['run-2026-10-29T03-30-00']);
    } finally { fs.rmSync(outside, { force: true }); }
  } finally { done(); }
});

test('a crash-safe journal alone is listed as an incomplete run', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.jsonl', lines(
      entry('A', 'success', { person: 'Alice Smith' }),
      entry('B', 'error'),
      entry('C', 'captcha_failed'),
      entry('D', 'pending_confirm'),
      entry('E', 'preview'),
    ));
    const [r] = listRuns(dir).runs;
    assert.equal(r.source, 'journal');
    assert.equal(r.complete, false);
    assert.equal(r.mode, 'incomplete');
    assert.equal(r.startedAt, '2026-10-29T03:30:00.000Z', 'taken from the file name');
    assert.equal(r.counts.submitted, 1);
    assert.equal(r.counts.errors, 1);
    assert.equal(r.counts.captchaFailed, 1);
    assert.equal(r.counts.pendingConfirm, 1);
    assert.equal(r.counts.skipped, 1, 'preview rows land in skipped, as the logger buckets them');
    assert.equal(r.total, 5);
  } finally { done(); }
});

test('a torn last journal line and garbage lines are skipped, not fatal', () => {
  const { dir, done } = tmpLogs();
  try {
    const good = lines(entry('A', 'success'), entry('B', 'error'));
    write(dir, 'run-2026-10-29T03-30-00.jsonl', `${good}not json at all\n${JSON.stringify(entry('C', 'success')).slice(0, 18)}`);
    const [r] = listRuns(dir).runs;
    assert.equal(r.total, 2);
    assert.equal(r.counts.submitted, 1);
    assert.equal(r.counts.errors, 1);
    assert.equal(r.error, undefined);
  } finally { done(); }
});

test('journal lines that are not result entries are ignored', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.jsonl', lines({ hello: 'world' }, [1, 2], 'str', null, entry('A', 'success'), { broker: 5, status: 'success' }));
    assert.equal(listRuns(dir).runs[0].total, 1);
  } finally { done(); }
});

test('when both files exist the summary wins, one run per stem', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({ succeeded: [entry('A', 'success'), entry('B', 'success')] }));
    write(dir, 'run-2026-10-29T03-30-00.jsonl', lines(entry('A', 'success')));
    const { runs, total } = listRuns(dir);
    assert.equal(total, 1);
    assert.equal(runs[0].source, 'summary');
    assert.equal(runs[0].total, 2);
  } finally { done(); }
});

test('an unreadable summary falls back to the journal beside it', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', '{"runAt": "2026-10-29T03:30:00.000Z", "succe');
    write(dir, 'run-2026-10-29T03-30-00.jsonl', lines(entry('A', 'success'), entry('B', 'success')));
    const [r] = listRuns(dir).runs;
    assert.equal(r.source, 'journal');
    assert.equal(r.counts.submitted, 2);
  } finally { done(); }
});

test('garbage and oversized summaries are listed as errored rows, never thrown', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-01T00-00-00.json', 'not json');
    write(dir, 'run-2026-10-02T00-00-00.json', '[1,2,3]');
    write(dir, 'run-2026-10-03T00-00-00.json', '{"unrelated": true}');
    write(dir, 'run-2026-10-04T00-00-00.json', 'null');
    const { runs } = listRuns(dir);
    assert.equal(runs.length, 4);
    for (const r of runs) {
      assert.equal(typeof r.error, 'string', r.id);
      assert.equal(r.total, 0);
      assert.deepEqual(r.people, []);
      assert.ok(r.startedAt, 'still dated, from the file name');
    }
  } finally { done(); }
});

test('a log with non-array buckets or non-object entries still summarises what it can', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({ succeeded: [entry('A', 'success'), null, 5, 'x'], errors: 'nope', manual: { a: 1 } }));
    const [r] = listRuns(dir).runs;
    assert.equal(r.counts.submitted, 1);
    assert.equal(r.counts.errors, 0);
    assert.equal(r.total, 1);
  } finally { done(); }
});

test('startedAt falls back to the file name stamp, then to the file time', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-28T04-05-06.json', { succeeded: [entry('A', 'success')] });
    write(dir, 'run-weird.json', { succeeded: [entry('A', 'success')], runAt: 'not a date' });
    const byId = Object.fromEntries(listRuns(dir).runs.map(r => [r.id, r]));
    assert.equal(byId['run-2026-10-28T04-05-06'].startedAt, '2026-10-28T04:05:06.000Z');
    assert.ok(!Number.isNaN(Date.parse(byId['run-weird'].startedAt)), 'falls back to mtime');
  } finally { done(); }
});

test('latestRun is the newest run and counts unique CAPTCHA sites', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-01T00-00-00.json', runLog({ captchaFailed: [entry('Old', 'captcha_failed')] }));
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      captchaFailed: [entry('Site A', 'captcha_failed', { person: 'Alice Smith' }), entry('Site A', 'captcha_failed', { person: 'Bob Jones' }), entry('Site B', 'captcha_failed', { person: 'Alice Smith' })],
    }));
    const latest = latestRun(dir);
    assert.equal(latest.id, 'run-2026-10-29T03-30-00');
    assert.equal(latest.counts.captchaFailed, 3, 'entries');
    assert.equal(latest.captchaSites, 2, 'sites: the same broker for two people is one site');
  } finally { done(); }
});

// ---- one run ----------------------------------------------------------------------

test('readRun returns one row per broker result with the status classified for display', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      succeeded: [entry('Spokeo', 'success', { person: 'Alice Smith', detail: 'done', host: 'spokeo.com' })],
      errors: [entry('MyLife', 'error', { person: 'Alice Smith', detail: 'timeout' })],
      unverified: [entry('Acme', 'unverified', { person: 'Alice Smith' })],
      notFound: [entry('Intelius', 'notFound')],
    }));
    const r = readRun(dir, 'run-2026-10-29T03-30-00');
    assert.equal(r.ok, true);
    assert.equal(r.run.id, 'run-2026-10-29T03-30-00');
    assert.equal(r.rows.length, 4);
    const spokeo = r.rows.find(x => x.broker === 'Spokeo');
    assert.deepEqual(spokeo, { broker: 'Spokeo', person: 'Alice Smith', initials: 'AS', status: 'success', key: 'ok', detail: 'done', host: 'spokeo.com', time: '10:00:00 AM' });
    assert.equal(r.rows.find(x => x.broker === 'MyLife').key, 'error');
    assert.equal(r.rows.find(x => x.broker === 'Acme').key, 'pending');
    assert.equal(r.rows.find(x => x.broker === 'Intelius').key, 'notfound');
    assert.equal(r.rows.find(x => x.broker === 'Intelius').person, null);
    assert.equal(r.truncated, false);
  } finally { done(); }
});

test('readRun reads a journal-only run in the order it was written', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.jsonl', lines(entry('First', 'success'), entry('Second', 'error'), entry('Third', 'manual')));
    const r = readRun(dir, 'run-2026-10-29T03-30-00');
    assert.equal(r.ok, true);
    assert.equal(r.run.source, 'journal');
    assert.deepEqual(r.rows.map(x => x.broker), ['First', 'Second', 'Third']);
  } finally { done(); }
});

test('readRun never returns a full URL: details are reduced to the host', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      pendingConfirm: [entry('Spokeo', 'pending_confirm', { detail: 'optOutUrl:https://www.spokeo.com/optout?email=jane.doe%40example.com&zip=73301#frag' })],
      manual: [entry('Intelius', 'manual', { detail: 'https://intelius.example/privacy/request/jane-doe-austin-tx?token=abc123' })],
    }));
    const r = readRun(dir, 'run-2026-10-29T03-30-00');
    const raw = JSON.stringify(r);
    assert.doesNotMatch(raw, /https?:\/\//);
    assert.doesNotMatch(raw, /jane|73301|token|abc123|\?|#frag/i);
    assert.equal(r.rows.find(x => x.broker === 'Spokeo').detail, 'optOutUrl:www.spokeo.com');
    assert.equal(r.rows.find(x => x.broker === 'Intelius').detail, 'intelius.example');
  } finally { done(); }
});

test('redactDetail reduces every URL in a string to its host and keeps the other words', () => {
  assert.equal(redactDetail('see https://a.example/x?y=1 and http://b.example:8080/p#q now'), 'see a.example and b.example now');
  assert.equal(redactDetail('(https://a.example/x?y=1)'), '(a.example)');
  assert.equal(redactDetail('"https://user:secret@a.example/x"'), '"a.example"');
  assert.equal(redactDetail('HTTPS://A.EXAMPLE/Path'), 'a.example');
  assert.equal(redactDetail('plain text only'), 'plain text only');
});

test('redactDetail strips the query of a mailto link, which can carry a pre-filled body', () => {
  assert.equal(redactDetail('mailto:privacy@x.example?subject=Remove%20Jane&body=Jane%20Doe%2C%2073301'), 'mailto:privacy@x.example');
  assert.equal(redactDetail('write to mailto:privacy@x.example'), 'write to mailto:privacy@x.example');
});

test('redactDetail survives hostile input and caps the length', () => {
  assert.equal(redactDetail('https://'), '[url]');
  assert.equal(redactDetail(undefined), '');
  assert.equal(redactDetail(null), '');
  assert.equal(redactDetail({ a: 1 }), '');
  assert.equal(redactDetail(42), '');
  const long = redactDetail('x'.repeat(5000));
  assert.ok(long.length <= 303);
  assert.match(long, /\.\.\.$/);
  assert.doesNotMatch(redactDetail('a\u0000b\nc'), /[\u0000-\u001f]/);
});

test('rows expose only known fields: unexpected keys on an entry are dropped', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({
      succeeded: [{ ...entry('A', 'success'), email: 'jane@example.com', url: 'https://x.example/?e=1', host: 'a b <script>', password: 'hunter2' }],
    }));
    const r = readRun(dir, 'run-2026-10-29T03-30-00');
    assert.deepEqual(Object.keys(r.rows[0]).sort(), ['broker', 'detail', 'initials', 'key', 'person', 'status', 'time']);
    assert.doesNotMatch(JSON.stringify(r), /jane@|hunter2|x\.example/);
  } finally { done(); }
});

test('readRun caps the rows it returns and says so', () => {
  const { dir, done } = tmpLogs();
  try {
    const many = Array.from({ length: MAX_ROWS + 50 }, (_, i) => entry(`Broker ${i}`, 'success'));
    write(dir, 'run-2026-10-29T03-30-00.json', runLog({ succeeded: many }));
    const r = readRun(dir, 'run-2026-10-29T03-30-00');
    assert.equal(r.rows.length, MAX_ROWS);
    assert.equal(r.truncated, true);
    assert.equal(r.rowCount, MAX_ROWS + 50);
    assert.equal(r.run.counts.submitted, MAX_ROWS + 50, 'the counts still cover every row');
  } finally { done(); }
});

test('readRun refuses ids that are not run ids, so no path can be built from them', () => {
  const { dir, done } = tmpLogs();
  try {
    write(dir, 'run-2026-10-29T03-30-00.json', runLog());
    fs.mkdirSync(path.join(dir, 'run-x'));
    fs.writeFileSync(path.join(dir, '..', `aidr-outside-${process.pid}.json`), JSON.stringify(runLog({ succeeded: [entry('OUT', 'success')] })));
    for (const id of [`run-x/../../aidr-outside-${process.pid}`, '../state', '..', '../../etc/passwd', 'run-../x', 'run-a/b', 'run-a\\b', '/etc/passwd', 'run-2026-10-29T03-30-00.json',
      'run-', 'run', 'audit-2026', 'run-a\u0000b', 'run-' + 'a'.repeat(200), '', undefined, null, 5, {}, ['run-x']]) {
      const r = readRun(dir, id);
      assert.equal(r.ok, false, JSON.stringify(id));
      assert.equal(r.status, 400, JSON.stringify(id));
    }
  } finally { fs.rmSync(path.join(dir, '..', `aidr-outside-${process.pid}.json`), { force: true }); done(); }
});

test('readRun is a 404 for a well-formed id with no file', () => {
  const { dir, done } = tmpLogs();
  try {
    const r = readRun(dir, 'run-2030-01-01T00-00-00');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally { done(); }
});

test('readRun does not follow a symlink out of the logs directory', () => {
  const { dir, done } = tmpLogs();
  const outside = path.join(dir, '..', `aidr-outside-${process.pid}.json`);
  try {
    fs.writeFileSync(outside, JSON.stringify(runLog({ succeeded: [entry('Secret', 'success')] })));
    fs.symlinkSync(outside, path.join(dir, 'run-2026-02-02T00-00-00.json'));
    const r = readRun(dir, 'run-2026-02-02T00-00-00');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally { fs.rmSync(outside, { force: true }); done(); }
});

test('isRunId accepts the names the watcher writes and nothing path-like', () => {
  assert.equal(isRunId('run-2026-10-29T03-30-00'), true);
  assert.equal(isRunId('run-fixture_1'), true);
  assert.equal(isRunId('run-a/b'), false);
  assert.equal(isRunId('run-..'), false);
  assert.equal(isRunId('run-a..b'), false);
});
