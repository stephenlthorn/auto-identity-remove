/**
 * test/heartbeat-offline-outcome.test.js
 *
 * A run on a machine whose resolver is broken (or on a captive network that answers
 * NXDOMAIN for everything) sees every host as gone: every row lands in the `dead`
 * bucket, which counts as neither an error nor progress. The run used to end `ok`,
 * exit 0, and `aidr schedule status` reported a healthy last run while the monthly
 * opt-out had silently done nothing.
 *
 * outcomeFromResults now treats a run in which most of the hosts it actually tried
 * were fresh dead answers as an OFFLINE run: those rows count as errors, so a run
 * with no progress is `failed` and one with some is `partial`. Rows skipped because
 * the host is already in data/dead-urls.json are a cache hit, not an observation.
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { outcomeFromResults } = require('../lib/heartbeat');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');
const brokers = require('../brokers');
const logger = require('../lib/logger');

const rows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ broker: `B${i}`, ...extra }));
const freshDead = (n) => rows(n, { status: 'dead', detail: 'ERR_NAME_NOT_RESOLVED' });
const cachedDead = (n) => rows(n, { status: 'dead', detail: 'cached dead-url, skipped' });

describe('outcomeFromResults when most hosts could not be resolved', () => {
  it('is failed and offline when 12 hosts were tried, all dead, and nothing else happened', () => {
    const end = outcomeFromResults({ dead: freshDead(12) });
    assert.equal(end.outcome, 'failed');
    assert.equal(end.offline, true);
  });

  it('is partial and offline when 12 fresh dead hosts sit beside 3 submissions', () => {
    const end = outcomeFromResults({ dead: freshDead(12), succeeded: rows(3) });
    assert.equal(end.outcome, 'partial');
    assert.equal(end.offline, true);
  });

  it('counts the generic pass by its stats too, when no rows were logged for it', () => {
    const end = outcomeFromResults({ dead: freshDead(12), genericStats: { attempted: 15, submitted: 3, dead: 12 } });
    assert.equal(end.outcome, 'partial');
    assert.equal(end.offline, true);
  });

  it('is ok when the dead rows are cache hits (hosts already in dead-urls.json), not new observations', () => {
    const end = outcomeFromResults({ dead: cachedDead(12), succeeded: rows(3) });
    assert.equal(end.outcome, 'ok');
    assert.notEqual(end.offline, true);
  });

  it('is ok for a few really dead hosts among many that answered', () => {
    const end = outcomeFromResults({ dead: freshDead(3), succeeded: rows(20) });
    assert.equal(end.outcome, 'ok');
    assert.notEqual(end.offline, true);
  });

  it('is ok when fewer than 10 hosts were tried, even if every one was dead', () => {
    const end = outcomeFromResults({ dead: freshDead(9) });
    assert.equal(end.outcome, 'ok');
    assert.notEqual(end.offline, true);
  });

  it('is not offline at exactly half: more than half of the tried hosts must be dead', () => {
    const end = outcomeFromResults({ dead: freshDead(10), succeeded: rows(10) });
    assert.equal(end.outcome, 'ok');
    assert.notEqual(end.offline, true);
  });

  it('does not let skipped rows dilute the share: a skip made no request, so it is not a host that answered', () => {
    const end = outcomeFromResults({ dead: freshDead(12), skipped: rows(300) });
    assert.equal(end.offline, true);
    assert.equal(end.outcome, 'partial', 'skipped rows are still progress for failed vs partial');
  });

  it('does not count cache hits in the tried total either', () => {
    const end = outcomeFromResults({ dead: [...freshDead(6), ...cachedDead(200)], succeeded: rows(4) });
    assert.equal(end.offline, true, '6 of the 10 hosts that were really tried were dead');
    assert.equal(end.outcome, 'partial');
  });

  it('keeps the counts numbers-only and unchanged: the dead count is still every dead row', () => {
    const end = outcomeFromResults({ dead: [...freshDead(12), ...cachedDead(5)], succeeded: rows(3) });
    assert.equal(end.counts.dead, 17);
    assert.deepEqual(Object.keys(end.counts).sort(), ['dead', 'succeeded']);
    for (const value of Object.values(end.counts)) assert.equal(typeof value, 'number');
  });

  it('carries no offline flag on a normal run', () => {
    assert.deepEqual(outcomeFromResults({ succeeded: rows(5), dead: freshDead(1) }), {
      outcome: 'ok',
      counts: { succeeded: 5, dead: 1 },
    });
  });
});

describe('the run summary', () => {
  const quietly = (fn) => {
    const log = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = log; }
  };

  it('says plainly that most sites could not be resolved, and to check the network or DNS', () => {
    const summary = quietly(() => {
      logger.resetResults();
      for (let i = 0; i < 12; i++) logger.logResult(`Dead ${i}`, 'dead', 'ERR_NAME_NOT_RESOLVED');
      logger.logResult('Ok 1', 'success', 'done');
      return logger.buildSummary();
    });
    assert.match(summary, /Most sites could not be resolved/);
    assert.match(summary, /Check the network or DNS/);
  });

  it('stays quiet about it for a normal run with a few dead hosts', () => {
    const summary = quietly(() => {
      logger.resetResults();
      for (let i = 0; i < 3; i++) logger.logResult(`Dead ${i}`, 'dead', 'HTTP 404');
      for (let i = 0; i < 20; i++) logger.logResult(`Ok ${i}`, 'success', 'done');
      return logger.buildSummary();
    });
    assert.doesNotMatch(summary, /could not be resolved/);
  });

  after(() => logger.resetResults());
});

// ── Seen from outside: the real watcher.js, every host answering "no such host" ──

describe('a whole run on a machine that cannot resolve any host', () => {
  it('exits 1, says the network is the likely cause, and leaves a failed heartbeat', async () => {
    const sandbox = createSandbox();
    try {
      // The fake network refuses every lookup with ENOTFOUND (its default): the
      // explicit pass has nowhere to go and every generic row is a dead host.
      const run = await runWatcher(sandbox, [], { env: { AIDR_FAKE_DNS_CODE: 'ENOTFOUND' }, timeoutMs: 120000 });
      assert.equal(run.timedOut, false);
      assert.equal(run.code, 1, run.stderr);
      assert.match(run.stdout, /most sites could not be resolved/i);
      assert.match(run.stdout, /check the network or DNS/i);
      assert.doesNotMatch(run.stdout, /every broker ended in an error/, 'the cause is the network, not every broker');
      assert.match(sandbox.notificationCalls().join('\n'), /most sites could not be resolved/i, 'the desktop notification says so too');

      const heartbeat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
      assert.equal(heartbeat.outcome, 'failed');
      assert.ok(heartbeat.counts.dead >= 10, `the dead rows are counted (${heartbeat.counts.dead})`);
      assert.doesNotMatch(JSON.stringify(heartbeat), /https?:|\.com|\.org/, 'numbers only, no host names');
    } finally {
      sandbox.cleanup();
    }
  });

  it('no longer reads as a healthy run when only the generic pass is dead and the explicit brokers were all fresh', async () => {
    const day = 86400000;
    const stamp = new Date(Date.now() - 3 * day).toISOString();
    const optOuts = {};
    for (const broker of brokers) {
      optOuts[broker.name] = { lastSuccess: stamp, lastAttempt: stamp };
      optOuts[`${broker.name}|Alan Turing`] = { lastSuccess: stamp, lastAttempt: stamp };
    }
    const sandbox = createSandbox({ state: { optOuts } });
    try {
      // Before: no errors and no progress counted, so outcome ok, exit 0, with ~900 dead hosts.
      const run = await runWatcher(sandbox, [], { timeoutMs: 120000 });
      assert.equal(run.timedOut, false);
      assert.match(run.stdout, /most sites could not be resolved/i);

      const heartbeat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
      assert.equal(heartbeat.outcome, 'partial', 'the fresh explicit brokers are progress, the dead generic rows are errors');
      assert.ok(heartbeat.counts.dead >= 10);
      assert.equal(heartbeat.counts.errors, 0, 'the heartbeat counts stay what the run logged');
    } finally {
      sandbox.cleanup();
    }
  });
});
