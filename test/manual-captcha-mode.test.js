/**
 * test/manual-captcha-mode.test.js
 *
 * R1 (issue #16): resolveManualMode decides ONCE per run whether a person at the
 * keyboard may be asked to solve a CAPTCHA. The cases that matter are the ones
 * where a wrong "true" would hang an unattended run (headless, cron) and the
 * ones where a wrong "false" would re-create the bug in #16 (the browser closing
 * before anyone can solve anything).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveManualMode, manualTimeoutSec } = require('../lib/manual-captcha');

const AT_DESKTOP = { headless: false, isTTY: true, hasSolverKey: false };

test('auto (the default) is on for a headed browser with a person at a terminal', () => {
  assert.equal(resolveManualMode({ config: {}, ...AT_DESKTOP }), true);
  assert.equal(resolveManualMode({ config: { captcha: { manual: 'auto' } }, ...AT_DESKTOP }), true);
});

test('auto stays on when a CapSolver key exists: the solver goes first and a person only covers its failures', () => {
  assert.equal(resolveManualMode({ config: {}, ...AT_DESKTOP, hasSolverKey: true }), true);
});

test('auto is off without an interactive terminal (cron, launchd, piped output)', () => {
  assert.equal(resolveManualMode({ config: {}, headless: false, isTTY: false, hasSolverKey: false }), false);
});

test('never on when the browser is headless, whatever the config says', () => {
  for (const manual of ['auto', true, false, 'true']) {
    assert.equal(
      resolveManualMode({ config: { captcha: { manual } }, headless: true, isTTY: true, hasSolverKey: false }),
      false,
      `captcha.manual=${JSON.stringify(manual)} must not wait on a window nobody can see`
    );
  }
});

test('false turns it off even at a desktop', () => {
  assert.equal(resolveManualMode({ config: { captcha: { manual: false } }, ...AT_DESKTOP }), false);
  assert.equal(resolveManualMode({ config: { captcha: { manual: 'false' } }, ...AT_DESKTOP }), false);
});

test('true waits even without a terminal, because a desktop notification still reaches the person', () => {
  assert.equal(
    resolveManualMode({ config: { captcha: { manual: true } }, headless: false, isTTY: false, hasSolverKey: true }),
    true
  );
});

test('force (the --solve-captchas flag) overrides false and a missing terminal, but not headless', () => {
  const off = { captcha: { manual: false } };
  assert.equal(resolveManualMode({ config: off, headless: false, isTTY: false, hasSolverKey: false, force: true }), true);
  assert.equal(resolveManualMode({ config: off, headless: true, isTTY: true, hasSolverKey: false, force: true }), false);
});

test('an unrecognised value falls back to auto instead of silently disabling the feature', () => {
  assert.equal(resolveManualMode({ config: { captcha: { manual: 'yes please' } }, ...AT_DESKTOP }), true);
  assert.equal(resolveManualMode({ config: { captcha: { manual: 7 } }, ...AT_DESKTOP }), true);
});

test('a missing config or missing arguments never throw and never wait', () => {
  assert.equal(resolveManualMode({ headless: false, isTTY: false }), false);
  assert.equal(resolveManualMode(), false);
  assert.equal(resolveManualMode({ config: null, headless: false, isTTY: true }), true);
});

test('manualTimeoutSec defaults to 180 and accepts a sensible override', () => {
  assert.equal(manualTimeoutSec({}), 180);
  assert.equal(manualTimeoutSec(null), 180);
  assert.equal(manualTimeoutSec({ captcha: { manualTimeoutSec: 90 } }), 90);
  assert.equal(manualTimeoutSec({ captcha: { manualTimeoutSec: '45' } }), 45);
});

test('manualTimeoutSec ignores junk, zero and negatives, and caps a runaway value at one hour', () => {
  for (const bad of [0, -5, 'soon', NaN, null, Infinity, {}]) {
    assert.equal(manualTimeoutSec({ captcha: { manualTimeoutSec: bad } }), 180, `${String(bad)} must fall back to the default`);
  }
  assert.equal(manualTimeoutSec({ captcha: { manualTimeoutSec: 999999 } }), 3600);
  assert.equal(manualTimeoutSec({ captcha: { manualTimeoutSec: 0.4 } }), 1);
});
