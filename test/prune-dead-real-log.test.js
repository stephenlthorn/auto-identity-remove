/**
 * test/prune-dead-real-log.test.js
 *
 * BRK-11: scripts/prune-dead.js read `raw.results` (the real run log is bucketed:
 * { runAt, succeeded: [], dead: [], errors: [], ... }), treated `entry.broker`
 * (often a company name) as a hostname, and blacklisted a host after ONE run
 * where it was dead. data/dead-urls.json makes every future run skip that host
 * without a request, so a single DNS blip would silently stop opting the user out
 * of a live broker.
 *
 * Now: read the bucketed shape, only consider entries that carry a host, and
 * require >= 3 separate runs spanning >= 14 days of HARD failures (DNS not
 * resolved, HTTP 404, HTTP 410) as the most recent history of that host.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneDeadUrls, MIN_RUNS, MIN_SPAN_DAYS } = require('../scripts/prune-dead');

let tmpDir;
let logsDir;
let deadUrlsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-prune-'));
  logsDir = path.join(tmpDir, 'logs');
  deadUrlsPath = path.join(tmpDir, 'dead-urls.json');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: [] }) + '\n');
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01T03:00:00Z');

/** Write a run log in the REAL bucketed shape. */
function writeRun(name, dayOffset, buckets) {
  const log = {
    runAt: new Date(T0 + dayOffset * DAY).toISOString(),
    succeeded: [], skipped: [], notFound: [], captchaFailed: [], manual: [], errors: [], dead: [], pendingConfirm: [],
    ...buckets,
  };
  fs.writeFileSync(path.join(logsDir, name), JSON.stringify(log));
}

const dead = (host, detail = 'ERR_NAME_NOT_RESOLVED', broker = 'Some Company') =>
  ({ broker, host, status: 'dead', detail, time: '3:00:00 AM' });
const readHosts = () => JSON.parse(fs.readFileSync(deadUrlsPath, 'utf8')).hosts;

test('thresholds are 3 runs over 14 days', () => {
  assert.equal(MIN_RUNS, 3);
  assert.equal(MIN_SPAN_DAYS, 14);
});

test('BRK-11: three hard failures in the real bucketed shape over 14+ days add the host', () => {
  writeRun('run-a.json', 0, { dead: [dead('gone.example')] });
  writeRun('run-b.json', 10, { dead: [dead('gone.example', 'HTTP 404')] });
  writeRun('run-c.json', 20, { dead: [dead('gone.example', 'ENOTFOUND')] });

  const { added, total } = pruneDeadUrls(logsDir, deadUrlsPath);
  assert.deepEqual(added, ['gone.example']);
  assert.equal(total, 1);
  assert.deepEqual(readHosts(), ['gone.example']);
});

test('BRK-11: one outage is never enough', () => {
  writeRun('run-a.json', 0, { dead: [dead('blip.example')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
  assert.deepEqual(readHosts(), []);
});

test('BRK-11: three runs inside two weeks are not enough', () => {
  writeRun('run-a.json', 0, { dead: [dead('quick.example')] });
  writeRun('run-b.json', 3, { dead: [dead('quick.example')] });
  writeRun('run-c.json', 6, { dead: [dead('quick.example')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
});

test('BRK-11: two runs over a long span are not enough', () => {
  writeRun('run-a.json', 0, { dead: [dead('two.example')] });
  writeRun('run-b.json', 40, { dead: [dead('two.example')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
});

test('BRK-11: entries without a host are ignored, a company name is never a hostname', () => {
  const noHost = { broker: 'Acme Data Co', status: 'dead', detail: 'ERR_NAME_NOT_RESOLVED' };
  const bareName = { broker: 'Acxiom', status: 'dead', detail: 'HTTP 404' };
  for (const [i, day] of [0, 10, 20].entries()) writeRun(`run-${i}.json`, day, { dead: [noHost, bareName] });

  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
});

test('BRK-11: a hostname-shaped broker field (BADBOOL rows are named by host) still counts', () => {
  const entry = { broker: 'old-broker.example', status: 'dead', detail: 'HTTP 410' };
  for (const [i, day] of [0, 10, 20].entries()) writeRun(`run-${i}.json`, day, { dead: [entry] });

  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, ['old-broker.example']);
});

test('BRK-11: soft failures (refused, timeout, 5xx) do not count as hard', () => {
  writeRun('run-a.json', 0, { dead: [dead('flaky.example', 'ERR_CONNECTION_REFUSED')] });
  writeRun('run-b.json', 10, { dead: [dead('flaky.example', 'HTTP 503')] });
  writeRun('run-c.json', 20, { dead: [dead('flaky.example', 'ERR_NAME_NOT_RESOLVED')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
});

test('BRK-11: a host that answered in the latest run is not added', () => {
  writeRun('run-a.json', 0, { dead: [dead('back.example')] });
  writeRun('run-b.json', 10, { dead: [dead('back.example')] });
  writeRun('run-c.json', 20, { dead: [dead('back.example')] });
  writeRun('run-d.json', 25, { succeeded: [{ broker: 'Back Co', host: 'back.example', status: 'success', detail: '' }] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
});

test('BRK-11: a host that was alive earlier and has since gone dead is added', () => {
  writeRun('run-a.json', 0, { succeeded: [{ broker: 'Late Co', host: 'late.example', status: 'success', detail: '' }] });
  writeRun('run-b.json', 30, { dead: [dead('late.example')] });
  writeRun('run-c.json', 45, { dead: [dead('late.example')] });
  writeRun('run-d.json', 60, { dead: [dead('late.example', 'HTTP 404')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, ['late.example']);
});

test('BRK-11: several entries for one host in one run (one per person) are one run', () => {
  writeRun('run-a.json', 0, { dead: [dead('multi.example'), dead('multi.example')] });
  writeRun('run-b.json', 20, { dead: [dead('multi.example'), dead('multi.example')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, [], 'two runs, however many entries each');
});

test('BRK-11: cached "skipped" dead entries are neutral, not evidence', () => {
  writeRun('run-a.json', 0, { dead: [dead('cached.example')] });
  writeRun('run-b.json', 10, { dead: [dead('cached.example', 'cached dead-url, skipped')] });
  writeRun('run-c.json', 20, { dead: [dead('cached.example')] });
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, [], 'only two real observations');
});

test('BRK-11: the run time comes from the file name when runAt is missing', () => {
  for (const name of ['run-2026-09-01T03-00-00.json', 'run-2026-09-12T03-00-00.json', 'run-2026-09-22T03-00-00.json']) {
    fs.writeFileSync(path.join(logsDir, name), JSON.stringify({ dead: [dead('named.example')] }));
  }
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, ['named.example']);
});

test('BRK-11: idempotent, keeps existing hosts, output stays sorted', () => {
  fs.writeFileSync(deadUrlsPath, JSON.stringify({ hosts: ['zombie.example'] }) + '\n');
  for (const [i, day] of [0, 10, 20].entries()) writeRun(`run-${i}.json`, day, { dead: [dead('aaa.example')] });

  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, ['aaa.example']);
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, []);
  assert.deepEqual(readHosts(), ['aaa.example', 'zombie.example']);
});

test('BRK-11: legacy flat arrays and malformed files are tolerated', () => {
  fs.writeFileSync(path.join(logsDir, 'run-bad.json'), 'NOT JSON');
  for (const [i, day] of [0, 10, 20].entries()) {
    fs.writeFileSync(
      path.join(logsDir, `run-flat-${i}.json`),
      JSON.stringify([{ ...dead('flat.example'), time: undefined }]),
    );
    const f = path.join(logsDir, `run-flat-${i}.json`);
    const at = new Date(T0 + day * DAY);
    fs.utimesSync(f, at, at);
  }
  assert.deepEqual(pruneDeadUrls(logsDir, deadUrlsPath).added, ['flat.example']);
});
