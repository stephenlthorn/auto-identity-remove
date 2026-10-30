/**
 * test/watcher-confirm-clicks.test.js
 *
 * BRK2-11 on the watcher side. `--confirm-emails` opened every confirmation link in
 * ONE shared headless profile: each click inherited the cookies of the click before
 * it, including another person's, which links people to each other at a broker. The
 * runner (lib/imap-confirm.js openContext) and the opener (lib/browser.js
 * createThrowawayContexts) were ready; the watcher never handed the runner an opener.
 *
 * Black box: the real watcher.js in the sandbox with the fake playwright, which
 * records the profile directory name of every launch.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const pendingForBoth = {
  optOuts: {
    'Spokeo|Alan Turing': { pendingConfirm: { since: daysAgo(2), snippet: '' }, lastAttempt: daysAgo(2) },
    'Spokeo|Ada Lovelace': { pendingConfirm: { since: daysAgo(2), snippet: '' }, lastAttempt: daysAgo(2) },
  },
  relayAliases: {
    'alan@turing-test.example': 'alan.alias@relay.test',
    'ada@lovelace-test.example': 'ada.alias@relay.test',
  },
};

function writeConfirmations(dir, deliveries) {
  fs.mkdirSync(dir);
  deliveries.forEach(({ to, id }, i) => {
    fs.writeFileSync(path.join(dir, `confirm-${i}.eml`), [
      'From: Spokeo <no-reply@spokeo.com>',
      `To: ${to}`,
      'Subject: Confirm your opt-out',
      `Message-ID: <${id}@spokeo.com>`,
      'Content-Type: text/plain',
      '',
      `Click to confirm: https://www.spokeo.com/optout/confirm?token=${id}`,
      '',
    ].join('\r\n'));
  });
}

const clicksDir = (sandbox) => path.join(sandbox.home, '.config', 'auto-identity-remove', 'utility', 'clicks');
const leftovers = (sandbox) => (fs.existsSync(clicksDir(sandbox)) ? fs.readdirSync(clicksDir(sandbox)) : []);

test('--confirm-emails opens each link in a browser profile of its own, removed afterwards', async () => {
  const sandbox = createSandbox({ state: pendingForBoth });
  try {
    const dir = path.join(sandbox.dir, 'confirms');
    writeConfirmations(dir, [
      { to: 'alan.alias@relay.test', id: 'alan1' },
      { to: 'ada.alias@relay.test', id: 'ada1' },
    ]);

    const r = await runWatcher(sandbox, ['--confirm-emails', dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Done: 0 confirmed, 0 unmatched, 2 failed/);

    const events = sandbox.fakeEvents();
    const launches = events.filter(e => e.event === 'launch');
    assert.equal(launches.length, 2, 'one browser per link');
    assert.ok(launches.every(l => /^c-/.test(l.profile)), `throwaway profiles, got ${launches.map(l => l.profile)}`);
    assert.notEqual(launches[0].profile, launches[1].profile, 'no profile is shared between two clicks');
    assert.ok(launches.every(l => l.profile !== 'utility'), 'the shared utility profile is not used for clicks');
    assert.ok(launches.every(l => l.headless === true));
    assert.equal(events.filter(e => e.event === 'addInitScript').length, 2, 'the stealth script is applied to each');
    assert.equal(events.filter(e => e.event === 'close').length, 2, 'each is closed after its click');
    assert.deepEqual(leftovers(sandbox), [], 'no profile directory outlives its click');
    assert.equal(fs.existsSync(sandbox.lock), false);
  } finally {
    sandbox.cleanup();
  }
});

test('a SIGTERM while a click is being set up closes that browser and removes its profile', async () => {
  const sandbox = createSandbox({ state: pendingForBoth });
  try {
    const dir = path.join(sandbox.dir, 'confirms');
    writeConfirmations(dir, [{ to: 'alan.alias@relay.test', id: 'alan1' }]);

    const r = await runWatcher(sandbox, ['--confirm-emails', dir], {
      env: { AIDR_FAKE_HANG: 'init' },
      signalWhen: { match: /FAKE_BROWSER_HANGING/, signal: 'SIGTERM' },
      timeoutMs: 30000,
    });

    assert.equal(r.timedOut, false, 'the shutdown must not hang');
    assert.equal(r.code, 143);
    assert.ok(sandbox.fakeEvents().some(e => e.event === 'close'), 'the browser is closed');
    assert.deepEqual(leftovers(sandbox), [], 'its profile directory is removed');
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released');
  } finally {
    sandbox.cleanup();
  }
});
