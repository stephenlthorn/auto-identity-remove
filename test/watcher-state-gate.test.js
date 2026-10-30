/**
 * test/watcher-state-gate.test.js
 *
 * CFG2-2 made saveState refuse to replace a state.json it could not read (EACCES,
 * typically root-owned after a `sudo` run). The refusal came late: the watcher took
 * the lock, wrote a heartbeat, launched a browser per person and worked through the
 * first broker before the first save threw, and a --confirm-emails run had already
 * clicked the confirmation link by then, with nothing recorded.
 *
 * A run that will submit or confirm now stops before it starts, with the fix for
 * the permissions. A dry run saves nothing, so it is not stopped.
 *
 * Black box: the real watcher.js in the sandbox, state.json chmod 000.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const skipReason = process.platform === 'win32' || (process.getuid && process.getuid() === 0)
  ? 'needs a non-root POSIX user: chmod 000 does not block root'
  : false;

const HISTORY = { optOuts: { Spokeo: { lastSuccess: new Date().toISOString(), totalRuns: 7 } } };

async function withUnreadableState(fn) {
  const sandbox = createSandbox({ state: HISTORY });
  const before = fs.readFileSync(sandbox.state, 'utf8');
  fs.chmodSync(sandbox.state, 0o000);
  try {
    return await fn(sandbox, before);
  } finally {
    fs.chmodSync(sandbox.state, 0o600);
    sandbox.cleanup();
  }
}

function assertNothingStarted(sandbox, r) {
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot be read/);
  assert.match(r.stderr, /chown/, 'says how to fix the permissions');
  assert.doesNotMatch(r.stdout, /starting run/, 'the run never began');
  assert.deepEqual(sandbox.fakeEvents(), [], 'no browser was launched and nothing was fetched');
  assert.deepEqual(sandbox.runLogs(), [], 'no run log or journal was opened');
  assert.deepEqual(sandbox.notificationCalls(), [], 'no notification: this is a setup problem, not a crash');
}

test('a run on an unreadable state.json stops before it takes the lock or launches anything', { skip: skipReason }, async () => {
  await withUnreadableState(async (sandbox, before) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker']);
    assertNothingStarted(sandbox, r);
    assert.equal(fs.existsSync(sandbox.lock), false);
    fs.chmodSync(sandbox.state, 0o600);
    assert.equal(fs.readFileSync(sandbox.state, 'utf8'), before, 'the history is untouched');
  });
});

test('--confirm-emails on an unreadable state.json stops before it opens a confirmation link', { skip: skipReason }, async () => {
  await withUnreadableState(async (sandbox) => {
    const dir = path.join(sandbox.dir, 'confirms');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'confirm.eml'), [
      'From: Spokeo <no-reply@spokeo.com>',
      'To: ada@lovelace-test.example',
      'Subject: Confirm your opt-out',
      'Content-Type: text/plain',
      '',
      'Click to confirm: https://www.spokeo.com/optout/confirm?token=abc',
      '',
    ].join('\r\n'));

    const r = await runWatcher(sandbox, ['--confirm-emails', dir]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be read/);
    assert.doesNotMatch(r.stdout, /Processing confirmation emails/);
    assert.deepEqual(sandbox.fakeEvents(), [], 'no link was opened');
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('a dry run is not stopped by an unreadable state.json: it saves nothing', { skip: skipReason }, async () => {
  await withUnreadableState(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'zzz-no-such-broker', '--dry-run']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /starting run/);
  });
});
