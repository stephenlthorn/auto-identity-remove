/**
 * test/run-browser-recovery.test.js
 *
 * CLI2-5: the watcher asked for a person's browser context ONCE per pass and used
 * it for every broker. When Chromium died in the middle (an out-of-memory kill, a
 * window closed under a headed run) context.newPage() threw outside any try, the
 * whole run aborted with exit 1, the second person never ran, the generic pass
 * never ran, no run log was written and the heartbeat said "failed" with empty
 * counts.
 *
 * Now the context is asked for before EVERY broker (the provider relaunches one that
 * has closed), a broker whose browser cannot be had is an error result of its own,
 * and a browser that will not start again stops being tried after three failures in
 * a row instead of costing a launch timeout per broker.
 *
 * Black-box: the real watcher.js in the sandbox, with a context that dies on its
 * (n+1)th newPage() (test/helpers/cli2-preload.js).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const PRELOAD = path.join(__dirname, 'helpers', 'cli2-preload.js');
const BROKERS = ['Radaris', 'Intelius', 'PeopleFinders', 'PeopleSmart', 'MyLife', 'Nuwber', 'FamilyTreeNow', 'CheckPeople'];
const PERSONS = ['Ada Lovelace', 'Alan Turing'];

async function inSandbox(fn) {
  const sandbox = createSandbox({ config: runnableConfig() });
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

function injected(sandbox, extra) {
  const log = path.join(sandbox.dir, 'cli2.log');
  return {
    env: { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`, AIDR_TEST_LOG: log, ...extra },
    events: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  };
}

const runLog = (sandbox) => {
  const [file] = sandbox.runLogs();
  return file ? JSON.parse(fs.readFileSync(path.join(sandbox.logs, file), 'utf8')) : null;
};

test('a browser that dies mid-pass is relaunched and every broker still gets a result', async () => {
  await inSandbox(async (sandbox) => {
    const extra = injected(sandbox, { AIDR_TEST_CLOSE_AFTER: '2' });
    const r = await runWatcher(sandbox, ['--only', BROKERS.join(',')], { env: extra.env, timeoutMs: 90000 });

    assert.doesNotMatch(r.stderr, /Fatal/, 'a dead browser is not a crash of the run');
    assert.equal(r.timedOut, false);
    const log = runLog(sandbox);
    assert.ok(log, 'the run wrote its log: it was not aborted half way');

    // Every broker of both persons has its own result, none was lost with the browser.
    for (const person of PERSONS) {
      const mine = log.errors.filter(e => e.person === person).map(e => e.broker).sort();
      assert.deepEqual(mine, [...BROKERS].sort(), `${person}: one result per broker`);
    }
    assert.ok(extra.events().filter(e => e.event === 'context-died').length >= 2, 'the browser really did die more than once');
    assert.ok(sandbox.fakeEvents().filter(e => e.event === 'launch').length > 2, 'and was relaunched, not just launched once per person');

    // The run went on to the generic pass of BOTH persons, and the run ended as a run.
    assert.equal(sandbox.fakeEvents().filter(e => e.event === 'generic').length, 2);
    assert.equal(r.code, 1, 'every broker errored against the fake browser: a failed run');
    const beat = JSON.parse(fs.readFileSync(path.join(sandbox.home, 'last-run.json'), 'utf8'));
    assert.ok(beat.counts.errors >= BROKERS.length * 2, 'the heartbeat counted them');
  });
});

test('a browser that will not start again is given up on after three tries, not one per broker', async () => {
  await inSandbox(async (sandbox) => {
    const extra = injected(sandbox, { AIDR_TEST_CLOSE_AFTER: '2', AIDR_TEST_RELAUNCH_FAILS: '1' });
    const r = await runWatcher(sandbox, ['--only', BROKERS.join(',')], { env: extra.env, timeoutMs: 90000 });

    assert.doesNotMatch(r.stderr, /Fatal/);
    const log = runLog(sandbox);
    assert.ok(log, 'the run still finished and wrote its log');
    for (const person of PERSONS) {
      const mine = log.errors.filter(e => e.person === person && e.broker !== 'Generic brokers').map(e => e.broker).sort();
      assert.deepEqual(mine, [...BROKERS].sort(), `${person}: every broker is accounted for as an error`);
      const generic = log.errors.filter(e => e.person === person && e.broker === 'Generic brokers');
      assert.equal(generic.length, 1, `${person}: the generic pass that could not start says so, once`);
      assert.match(generic[0].detail, /browser unavailable/);
    }
    assert.equal(extra.events().filter(e => e.event === 'launch-failed').length, 3, 'three failed launches, then it stopped asking');
    assert.match(log.errors.map(e => e.detail).join('\n'), /not being restarted again|failed to start/);
    assert.equal(r.code, 1);
  });
});

test('the browser is launched once per person when nothing dies (no churn from asking per broker)', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', BROKERS.join(',')], { timeoutMs: 90000 });
    assert.equal(r.code, 1);
    const launches = sandbox.fakeEvents().filter(e => e.event === 'launch');
    assert.equal(launches.length, 4, 'one launch per person for the explicit pass and one for the generic pass');
  });
});
