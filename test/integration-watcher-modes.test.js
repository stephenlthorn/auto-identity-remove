/**
 * test/integration-watcher-modes.test.js
 *
 * The one-shot modes of watcher.js that write files or launch a browser:
 * --complaints, --report, --know and --confirm-emails. Same sandbox as
 * integration-watcher-run.test.js: temp repo copy, temp config and state, fake
 * `playwright`, stubbed notifiers. Nothing is sent, nothing leaves the machine.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

const mode = (p) => fs.statSync(p).mode & 0o777;

// Alan asked Spokeo to delete his data 100 days ago and a check 40 days ago
// still found him: past the response window, with the evidence a complaint needs.
const overdueForAlan = {
  optOuts: {
    'Spokeo|Alan Turing': {
      lastSuccess: daysAgo(100),
      lastAttempt: daysAgo(100),
      verifiedStillListedAt: daysAgo(40),
    },
  },
};

// ── --complaints ──────────────────────────────────────────────────────────────

test('--complaints writes the complaint under the right person, in a private directory', async () => {
  await inSandbox({ state: overdueForAlan }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--complaints', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Spokeo\s+generic\s+55/);

    const dir = path.join(sandbox.logs, 'complaints');
    assert.equal(mode(dir), 0o700, 'complaints hold name, address and phone');
    const [file, ...rest] = fs.readdirSync(dir);
    assert.equal(rest.length, 0);
    assert.match(file, /^Alan-Turing-Spokeo-/, 'named for the person it is about');
    assert.equal(mode(path.join(dir, file)), 0o600);

    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(body, /Alan Turing/);
    assert.doesNotMatch(body, /Ada Lovelace|lovelace-test/, 'the other person\'s details are not in it');
    assert.deepEqual(sandbox.fakeEvents(), [], 'a dry run renders no PDF, so it never needs a browser');
  });
});

test('--complaints without verification evidence says exactly what is missing and writes nothing', async () => {
  const state = { optOuts: { 'Spokeo|Alan Turing': { lastSuccess: daysAgo(100), lastAttempt: daysAgo(100) } } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--complaints', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No broker qualifies for a complaint/);
    assert.match(r.stdout, /run --verify/);
    assert.equal(fs.existsSync(path.join(sandbox.logs, 'complaints')), false);
  });
});

test('--complaints reports an unanswered right-to-know request without filing it as a deletion complaint', async () => {
  const state = { optOuts: { 'Pipl|Alan Turing': { knowRequestedAt: daysAgo(80) } } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--complaints', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Pipl \(Alan Turing\): \d+ day\(s\) past the response window/);
    assert.match(r.stdout, /No broker qualifies for a complaint/);
    assert.equal(fs.existsSync(path.join(sandbox.logs, 'complaints')), false);
  });
});

test('a real --complaints run renders its PDFs in a browser with the shared launch options and closes it', async () => {
  await inSandbox({ state: overdueForAlan }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--complaints']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 text, 1 PDF/);
    const events = sandbox.fakeEvents().map(e => e.event);
    assert.deepEqual(events, ['launch', 'newPage', 'close']);
    const pdf = fs.readdirSync(path.join(sandbox.logs, 'complaints')).find(f => f.endsWith('.pdf'));
    assert.equal(mode(path.join(sandbox.logs, 'complaints', pdf)), 0o600);
  });
});

// ── --report ──────────────────────────────────────────────────────────────────

test('--report writes a private PDF, snapshots the exposure score, and does not notify in a dry run', async () => {
  await inSandbox({ state: overdueForAlan }, async (sandbox) => {
    const history = path.join(sandbox.repo, 'data', 'exposure-history.json');

    const dry = await runWatcher(sandbox, ['--report', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const reports = path.join(sandbox.logs, 'reports');
    assert.equal(mode(reports), 0o700);
    const [pdf] = fs.readdirSync(reports);
    assert.equal(mode(path.join(reports, pdf)), 0o600);
    assert.equal(fs.existsSync(history), false, 'a dry run saves no snapshot');
    assert.deepEqual(sandbox.notificationCalls(), [], 'a dry run raises no desktop notification');
    assert.equal(fs.existsSync(sandbox.lock), false);

    const real = await runWatcher(sandbox, ['--report']);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(JSON.parse(fs.readFileSync(history, 'utf8')).length, 1, 'the report records the score it showed');
    assert.equal(sandbox.notificationCalls().length, 1);
  });
});

test('--report does not email the report in a dry run', async () => {
  const config = runnableConfig({
    email: { smtp: { host: '127.0.0.1', port: 9, user: 'sender@lovelace-test.example', pass: 'x', from: 'sender@lovelace-test.example' } },
    notify: { textTo: '', emailReportTo: 'ada@lovelace-test.example' },
  });
  await inSandbox({ config }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--report', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN - report not emailed to ada@lovelace-test\.example/);
    assert.doesNotMatch(r.stdout + r.stderr, /Report email failed|Report emailed/);
  });
});

// ── --know ────────────────────────────────────────────────────────────────────

test('--know --dry-run previews a request per person and broker, and changes nothing', async () => {
  await inSandbox({}, async (sandbox) => {
    const before = fs.readFileSync(sandbox.state, 'utf8');
    const r = await runWatcher(sandbox, ['--know', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN - previews only/);
    assert.match(r.stdout, /4 email broker\(s\) x 2 person\(s\)/);
    assert.equal((r.stdout.match(/\[preview\] Right-to-know/g) || []).length, 8);
    assert.match(r.stdout, /already sent: 0/);
    assert.equal(fs.readFileSync(sandbox.state, 'utf8'), before);
    assert.deepEqual(sandbox.fakeEvents(), [], 'right-to-know needs no browser');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('--know does not re-send a request that is still inside its response window', async () => {
  const state = { optOuts: { 'Pipl|Alan Turing': { knowRequestedAt: daysAgo(3) }, 'Pipl|Ada Lovelace': { knowRequestedAt: daysAgo(3) } } };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already sent: 2/);
    assert.equal((r.stdout.match(/\[preview\] Right-to-know/g) || []).length, 6);
  });
});

// ── --confirm-emails ──────────────────────────────────────────────────────────

test('--confirm-emails on an empty directory launches no browser, finds nothing, and releases the lock', async () => {
  await inSandbox({}, async (sandbox) => {
    const dir = path.join(sandbox.dir, 'confirms');
    fs.mkdirSync(dir);
    const r = await runWatcher(sandbox, ['--confirm-emails', dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Processing confirmation emails from: .*confirms/);
    assert.match(r.stdout, /Done: 0 confirmed, 0 unmatched, 0 failed \(0 \.eml files\)/);
    // Every click gets a browser of its own (BRK2-11), so with no link there is no launch.
    assert.deepEqual(sandbox.fakeEvents().map(e => e.event), []);
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

const pendingForAlan = {
  optOuts: { 'Spokeo|Alan Turing': { pendingConfirm: { since: daysAgo(2), snippet: '' }, lastAttempt: daysAgo(2) } },
  relayAliases: { 'alan@turing-test.example': 'alan.alias@relay.test' },
};

// Delivered to Alan's masked alias: nothing in the message names him.
function writeConfirmationTo(dir, address) {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'confirm.eml'), [
    'From: Spokeo <no-reply@spokeo.com>',
    `To: ${address}`,
    'Subject: Confirm your opt-out',
    'Message-ID: <abc123@spokeo.com>',
    'Content-Type: text/plain',
    '',
    'Click to confirm: https://www.spokeo.com/optout/confirm?token=abc',
    '',
  ].join('\r\n'));
}

test('--confirm-emails matches a confirmation sent to a relay alias to the person who owns it', async () => {
  await inSandbox({ state: pendingForAlan }, async (sandbox) => {
    const dir = path.join(sandbox.dir, 'confirms');
    writeConfirmationTo(dir, 'alan.alias@relay.test');

    const r = await runWatcher(sandbox, ['--confirm-emails', dir, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would confirm: Spokeo \(Alan Turing\) -> https:\/\/www\.spokeo\.com\/optout\/confirm/);
    assert.doesNotMatch(r.stdout, /\[object Object\]/);
    assert.match(r.stdout, /DRY RUN - no link was opened/);
    assert.deepEqual(sandbox.readState(), pendingForAlan, 'a dry run changes no state');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('--confirm-emails reports a link it could not open as failed and leaves the broker pending', async () => {
  await inSandbox({ state: pendingForAlan }, async (sandbox) => {
    const dir = path.join(sandbox.dir, 'confirms');
    writeConfirmationTo(dir, 'alan.alias@relay.test');

    // The fake browser refuses every navigation, which is what a dead link looks like.
    const r = await runWatcher(sandbox, ['--confirm-emails', dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /failed: Spokeo \(navigation_error\)/);
    assert.match(r.stdout, /Done: 0 confirmed, 0 unmatched, 1 failed/);
    assert.ok(sandbox.readState().optOuts['Spokeo|Alan Turing'].pendingConfirm, 'still waiting for a confirmation that never happened');
    assert.equal(sandbox.readState().optOuts['Spokeo|Alan Turing'].lastSuccess, undefined);
  });
});
