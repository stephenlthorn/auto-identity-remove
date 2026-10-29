/**
 * test/integration-watcher-run.test.js
 *
 * The real watcher.js orchestration, start to finish, against a fake browser.
 * Each run happens in a sandbox (see test/helpers/watcher-sandbox.js): temp repo
 * copy, temp config and state, `playwright` replaced by a fake that records what
 * it is asked and refuses to navigate, notifiers stubbed. Nothing here can reach
 * the network, a real browser, a real mailbox or the developer's files.
 *
 * The brokers are driven through their SKIP path (a fresh success in state), so
 * a run produces real per-person results without ever needing a page.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
const fresh = (n = 3) => ({ lastSuccess: daysAgo(n), lastAttempt: daysAgo(n) });

const ADA = 'Ada Lovelace';
const ALAN = 'Alan Turing';

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

function readRunLog(sandbox) {
  const [file] = sandbox.runLogs();
  assert.ok(file, 'a run log should have been written');
  const full = path.join(sandbox.logs, file);
  return { file: full, body: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

const mode = (p) => fs.statSync(p).mode & 0o777;

// ── a complete run ────────────────────────────────────────────────────────────

test('a run launches the browser once, closes it, writes private logs and releases the lock', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assert.equal(r.code, 0, r.stderr);

    const events = sandbox.fakeEvents().map(e => e.event);
    assert.equal(events.filter(e => e === 'launch').length, 1);
    assert.ok(events.includes('close'), 'the browser context is closed');
    assert.deepEqual(sandbox.networkAttempts(), [], 'a filter that matches nothing must reach nowhere');
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released');

    // Both persons ran, in the same run.
    assert.match(r.stdout, new RegExp(`Running for: ${ADA}`));
    assert.match(r.stdout, new RegExp(`Running for: ${ALAN}`));
    assert.match(r.stdout, new RegExp(`Generic brokers for ${ADA}`));
    assert.match(r.stdout, new RegExp(`Generic brokers for ${ALAN}`));

    // The run log and the audit report hold PII: 0600 files in a 0700 directory.
    const { file, body } = readRunLog(sandbox);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(sandbox.logs), 0o700);
    const audit = fs.readdirSync(sandbox.logs).find(f => /^audit-.*\.md$/.test(f));
    assert.ok(audit, 'an audit report should have been written');
    assert.equal(mode(path.join(sandbox.logs, audit)), 0o600);

    // A filtered run is marked so the next full run does not diff against it.
    assert.equal(body.partial, true);
    assert.deepEqual(body.filter, { only: 'zzz-no-such-broker', skip: null, retryFailed: false, resume: false });
  });
});

test('the end-of-run notification says "submitted", not "removed"', async () => {
  await inSandbox({}, async (sandbox) => {
    await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    const calls = sandbox.notificationCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Done - 0 submitted, 0 awaiting email confirmation, 0 need manual action/);
    assert.doesNotMatch(calls[0], /removed/);
  });
});

// ── people and their history ──────────────────────────────────────────────────

test('each person is processed with their own history: persons[0]\'s pre-upgrade bare key and persons[1]\'s composite key both count', async () => {
  const state = { optOuts: { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(5) } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);

    const { body } = readRunLog(sandbox);
    const spokeo = body.skipped.filter(e => e.broker === 'Spokeo');
    assert.deepEqual(spokeo.map(e => e.person), [ADA, ALAN], 'results are tagged with the person they belong to');
    assert.match(spokeo[0].detail, /Last removed 3d ago/);
    assert.match(spokeo[1].detail, /Last removed 5d ago/);
    assert.equal(sandbox.fakeEvents().some(e => e.event === 'goto'), false, 'a fresh success needs no navigation');

    // The audit report is split per person.
    const audit = fs.readdirSync(sandbox.logs).find(f => /^audit-.*\.md$/.test(f));
    assert.ok(audit);
  });
});

test('persons[1] does not inherit persons[0]\'s bare-key history', async () => {
  const state = { optOuts: { Spokeo: fresh(3) } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    // Ada is skipped on her own history; Alan has none, so the runner tries him
    // (and, against the fake browser, cannot reach the site).
    const adaLine = r.stdout.split('Running for: ')[1];
    assert.match(adaLine, /Spokeo\] skipped - Last removed 3d ago/);
    const alanSection = r.stdout.split(`Running for: ${ALAN}`)[1];
    assert.doesNotMatch(alanSection.split('Generic brokers')[0], /skipped - Last removed/);
    assert.equal(sandbox.fakeEvents().filter(e => e.event === 'goto').length, 1, 'only Alan is looked up');
  });
});

// ── --only / --skip / --retry-failed reach every runner ──────────────────────

test('--retry-failed re-runs the last log\'s errors AND unconfirmed submissions, and only those', async () => {
  const state = { optOuts: { Spokeo: fresh(3), WhitePages: fresh(3), 'Spokeo|Alan Turing': fresh(3), 'WhitePages|Alan Turing': fresh(3), FastPeopleSearch: fresh(3), 'FastPeopleSearch|Alan Turing': fresh(3) } };
  await inSandbox({ state }, async (sandbox) => {
    fs.mkdirSync(sandbox.logs, { recursive: true });
    fs.writeFileSync(path.join(sandbox.logs, 'run-2026-01-01T00-00-00.json'), JSON.stringify({
      errors: [{ broker: 'Spokeo', status: 'error' }],
      unverified: [{ broker: 'WhitePages', status: 'unverified' }],
      succeeded: [{ broker: 'FastPeopleSearch', status: 'success' }],
    }));

    const r = await runWatcher(sandbox, ['--retry-failed']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--retry-failed: 2 broker\(s\) from last log/);

    const newest = sandbox.runLogs().sort().pop();
    const body = JSON.parse(fs.readFileSync(path.join(sandbox.logs, newest), 'utf8'));
    const names = [...new Set(body.skipped.map(e => e.broker))].sort();
    assert.deepEqual(names, ['Spokeo', 'WhitePages'], 'FastPeopleSearch succeeded last time and is not retried');
    assert.equal(body.skipped.length, 4, 'both brokers for both persons');
    assert.equal(body.partial, true);
    assert.equal(body.filter.retryFailed, true);
    assert.equal(body.genericStats.attempted, 0, 'the generic pass honours the filter too');
    assert.deepEqual(sandbox.networkAttempts(), [], 'not one DNS lookup, fetch or navigation');
  });
});

test('--only reaches the email opt-outs too: only the named email broker is handled, once per person', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo (email)']);
    assert.equal(r.code, 0, r.stderr);

    // No SMTP is configured, so an email broker is logged for the user to send by hand.
    const { body } = readRunLog(sandbox);
    assert.deepEqual(
      body.manual.map(e => [e.broker, e.person]),
      [['Spokeo (email)', ADA], ['Spokeo (email)', ALAN]],
      'Hiya, Eyecon and Pipl must not be touched by --only Spokeo (email)',
    );
    assert.equal(body.skipped.length + body.errors.length, 0, 'no form broker ran');
  });
});

// ── dry run guards every side effect ─────────────────────────────────────────

test('--dry-run writes no log, state, checkpoint or audit, and sends no notification', async () => {
  const state = { optOuts: { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(3) } };
  await inSandbox({ state }, async (sandbox) => {
    const before = fs.readFileSync(sandbox.state, 'utf8');
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(fs.readFileSync(sandbox.state, 'utf8'), before, 'state.json is byte-for-byte unchanged');
    assert.equal(fs.existsSync(`${sandbox.state}.checkpoint`), false);
    assert.equal(fs.existsSync(sandbox.logs), false, 'no logs directory is even created');
    assert.deepEqual(sandbox.notificationCalls(), [], 'no desktop notification in a dry run');
    assert.match(r.stdout, /Log: not written \(dry run\)/);
    assert.match(r.stdout, /State: not saved \(dry run\)/);
  });
});

test('--dry-run does not delete the checkpoint of an interrupted real run', async () => {
  await inSandbox({}, async (sandbox) => {
    const checkpoint = `${sandbox.state}.checkpoint`;
    fs.writeFileSync(checkpoint, 'Spokeo|Alan Turing\n');
    await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--dry-run']);
    assert.equal(fs.readFileSync(checkpoint, 'utf8'), 'Spokeo|Alan Turing\n');
  });
});

test('--preview implies a dry run', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--preview']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /PREVIEW/);
    assert.deepEqual(sandbox.runLogs(), []);
    assert.deepEqual(sandbox.notificationCalls(), []);
  });
});

// ── the masked-email relay fails closed, once per person ─────────────────────

const freshForBoth = { Spokeo: fresh(3), 'Spokeo|Alan Turing': fresh(3) };

test('a relay that cannot serve anyone skips every person everywhere, says so, and fails the run', async () => {
  const config = runnableConfig({ relay: { provider: 'carrier-pigeon', apiKey: 'k' } });
  await inSandbox({ config, state: { optOuts: freshForBoth } }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 1, 'a run that skipped people did not complete');
    assert.match(r.stderr, new RegExp(`Relay unavailable for ${ADA}: unsupported relay provider`));
    assert.match(r.stderr, new RegExp(`Relay unavailable for ${ALAN}`));

    const { body } = readRunLog(sandbox);
    assert.equal(body.skipped.length, 0, 'no broker was processed for anyone');
    assert.deepEqual(body.errors.map(e => [e.broker, e.person]), [['Masked-email relay', ADA], ['Masked-email relay', ALAN]]);
    assert.match(body.errors[0].detail, /nothing was submitted for Ada Lovelace/);
    assert.equal(sandbox.fakeEvents().some(e => e.event === 'newPage'), false, 'not even the generic pass opened a page');
  });
});

test('relay.failOpen: true is the explicit opt-in to the real address, with a loud warning', async () => {
  const config = runnableConfig({ relay: { provider: 'carrier-pigeon', apiKey: 'k', failOpen: true } });
  await inSandbox({ config, state: { optOuts: freshForBoth } }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /relay\.failOpen is true, so your REAL email address is being sent/);
    const { body } = readRunLog(sandbox);
    assert.equal(body.skipped.filter(e => e.broker === 'Spokeo').length, 2, 'both persons ran');
    assert.deepEqual(sandbox.networkAttempts(), []);
  });
});

test('a cached alias is used for every path and no second one is created', async () => {
  const config = runnableConfig({ relay: { provider: 'simplelogin', apiKey: 'k' } });
  const state = {
    optOuts: freshForBoth,
    relayAliases: { 'ada@lovelace-test.example': 'ada.alias@relay.test', 'alan@turing-test.example': 'alan.alias@relay.test' },
  };
  await inSandbox({ config, state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Spokeo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Using masked email for ${ADA}'s submissions: ada\\.alias@relay\\.test`));
    assert.match(r.stdout, new RegExp(`Using masked email for ${ALAN}'s submissions: alan\\.alias@relay\\.test`));
    assert.deepEqual(sandbox.readState().relayAliases, state.relayAliases);
    assert.deepEqual(sandbox.networkAttempts(), [], 'the cached alias means no call to the relay provider');
  });
});

test('the generic pass gets each person\'s own alias, index and the run\'s include test', async () => {
  const config = runnableConfig({ relay: { provider: 'simplelogin', apiKey: 'k' } });
  const state = {
    optOuts: {},
    relayAliases: { 'ada@lovelace-test.example': 'ada.alias@relay.test', 'alan@turing-test.example': 'alan.alias@relay.test' },
  };
  await inSandbox({ config, state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assert.equal(r.code, 0, r.stderr);

    const generic = sandbox.fakeEvents().filter(e => e.event === 'generic');
    assert.deepEqual(generic.map(e => [e.person, e.personIndex, e.personCount, e.submissionEmail]), [
      [ADA, 0, 2, 'ada.alias@relay.test'],
      [ALAN, 1, 2, 'alan.alias@relay.test'],
    ], 'the masked address, never person.email, reaches every generic form');
    for (const e of generic) {
      assert.deepEqual(e.includeNamed, ['zzz-no-such-broker'], '--only is applied to the generic pass');
      assert.ok(e.explicitBrokers > 10, 'the explicit list is passed so same-company rows are not run twice');
    }
  });
});

test('without a relay the generic pass uses each person\'s own email', async () => {
  await inSandbox({}, async (sandbox) => {
    await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    const generic = sandbox.fakeEvents().filter(e => e.event === 'generic');
    assert.deepEqual(generic.map(e => e.submissionEmail), ['ada@lovelace-test.example', 'alan@turing-test.example']);
  });
});

test('a dry run never mints a relay alias: it shows the placeholder and saves nothing', async () => {
  const config = runnableConfig({ relay: { provider: 'simplelogin', apiKey: 'k' } });
  await inSandbox({ config, state: { optOuts: freshForBoth } }, async (sandbox) => {
    const before = fs.readFileSync(sandbox.state, 'utf8');
    const r = await runWatcher(sandbox, ['--only', 'Spokeo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /relay-alias-would-be-created@example\.invalid/);
    assert.equal(fs.readFileSync(sandbox.state, 'utf8'), before);
  });
});

test('--know refuses, sending nothing, when the relay cannot serve a person', async () => {
  const config = runnableConfig({ relay: { provider: 'carrier-pigeon', apiKey: 'k' } });
  await inSandbox({ config }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not sending any right-to-know request/);
    assert.doesNotMatch(r.stdout, /Right-to-know results/);
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released');
  });
});

// ── verify: per-person broker lists, nothing "clear" without proof ───────────

test('--verify reads persons[0]\'s bare-key history, searches per person, and never calls an unreachable site "clear"', async () => {
  const state = { optOuts: { Spokeo: { lastSuccess: daysAgo(10), lastAttempt: daysAgo(10) } } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--verify']);
    assert.equal(r.code, 0, r.stderr);

    assert.match(r.stdout, /verified_clear : 0/);
    assert.match(r.stdout, /unverifiable   : 1/, 'Ada\'s search could not load, which is not "not listed"');
    assert.equal(sandbox.fakeEvents().filter(e => e.event === 'goto').length, 1, 'only Ada has a recorded submission to verify');
    const entry = sandbox.readState().optOuts['Spokeo|Ada Lovelace'];
    assert.equal(entry, undefined, 'nothing was recorded as verified for Ada');
    assert.equal(sandbox.readState().optOuts.Spokeo.verifiedDeletedAt, undefined);
  });
});

// ── signals ───────────────────────────────────────────────────────────────────

test('SIGTERM mid-run closes the browser, saves state, releases the lock and exits 143', async () => {
  await inSandbox({ state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker'], {
      env: { AIDR_FAKE_HANG: 'init' },
      signalWhen: { match: /FAKE_BROWSER_HANGING/, signal: 'SIGTERM' },
      timeoutMs: 30000,
    });

    assert.equal(r.timedOut, false, 'the shutdown must not hang');
    assert.equal(r.code, 143);
    assert.match(r.stderr, /shutdown: SIGTERM received/);
    assert.ok(sandbox.fakeEvents().some(e => e.event === 'close'), 'the browser is closed');
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released');
    assert.ok(fs.existsSync(sandbox.state), 'state is saved on the way out');
    assert.deepEqual(sandbox.runLogs(), [], 'an interrupted run does not pretend to have finished');
  });
});

// ── SERP: a search that could not run is not a clean bill of health ──────────

test('--serp-scan with every engine unreachable is INCONCLUSIVE, exits 2, and never says "effective"', async () => {
  await inSandbox({}, async (sandbox) => {
    const dry = await runWatcher(sandbox, ['--serp-scan', '--dry-run']);
    assert.equal(dry.code, 2);
    assert.match(dry.stdout, /INCONCLUSIVE: no search engine returned usable results/);
    assert.match(dry.stdout, /NOT evidence that your opt-outs worked/);
    assert.doesNotMatch(dry.stdout, /appear to be effective/);
    assert.equal(fs.existsSync(path.join(sandbox.repo, 'data', 'serp-history.json')), false, 'a dry run writes no history');

    const real = await runWatcher(sandbox, ['--serp-scan']);
    assert.equal(real.code, 2);
    const history = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'data', 'serp-history.json'), 'utf8'));
    assert.ok(history.some(row => row.scan === true && row.conclusive === false), 'the history records that the scan proved nothing');
  });
});

test('--serp-watch in a dry run neither writes history nor claims to have alerted', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--serp-watch', '--dry-run']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /INCONCLUSIVE/);
    assert.doesNotMatch(r.stdout, /No new broker domains since the last scan\./);
    assert.equal(fs.existsSync(path.join(sandbox.repo, 'data', 'serp-history.json')), false);
    assert.deepEqual(sandbox.notificationCalls(), []);
  });
});
