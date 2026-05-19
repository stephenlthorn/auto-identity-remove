/**
 * test/logger.test.js
 *
 * Covers lib/logger.js: logResult routes each status into the correct bucket,
 * unknown statuses fall back to errors, and buildSummary() reflects counts.
 *
 * logResult console.log's; we silence it during these tests.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../lib/logger');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

function reset() {
  const r = logger.results;
  for (const k of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors']) {
    r[k].length = 0;
  }
}

test('logResult routes each status to its correct bucket', () => {
  reset();
  logger.logResult('A', 'success', 'ok');
  logger.logResult('B', 'skipped');
  logger.logResult('C', 'notFound');
  logger.logResult('D', 'captcha_failed');
  logger.logResult('E', 'manual');
  logger.logResult('F', 'error', 'boom');

  const r = logger.results;
  assert.equal(r.succeeded.length, 1);
  assert.equal(r.succeeded[0].broker, 'A');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.notFound.length, 1);
  assert.equal(r.captchaFailed.length, 1);
  assert.equal(r.manual.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].detail, 'boom');
});

test('logResult: unknown status falls back to errors bucket', () => {
  reset();
  logger.logResult('X', 'totally_unknown_status');
  assert.equal(logger.results.errors.length, 1);
  assert.equal(logger.results.errors[0].status, 'totally_unknown_status');
});

test('STATUS_BUCKET map matches monolith routing', () => {
  assert.equal(logger.STATUS_BUCKET.success, 'succeeded');
  assert.equal(logger.STATUS_BUCKET.captcha_failed, 'captchaFailed');
  assert.equal(logger.STATUS_BUCKET.error, 'errors');
});

test('buildSummary includes expected counts and action-required block', () => {
  reset();
  logger.logResult('A', 'success');
  logger.logResult('B', 'success');
  logger.logResult('C', 'skipped');
  logger.logResult('D', 'notFound');
  logger.logResult('E', 'manual', 'http://example.com/optout');
  logger.logResult('F', 'captcha_failed', 'http://captcha.example');
  logger.logResult('G', 'error');

  const s = logger.buildSummary();
  assert.match(s, /✅ Submitted \(form accepted\):\s+2/);
  assert.match(s, /⏭  Skipped \(fresh\):\s+1/);
  assert.match(s, /🔍 Not listed:\s+1/);
  assert.match(s, /📋 Manual needed:\s+2/); // captchaFailed + manual
  assert.match(s, /❌ Errors:\s+1/);
  assert.match(s, /Action Required/);
  assert.match(s, /• E/);
  assert.match(s, /• F/);
});

test('buildSummary omits action-required block when nothing manual', () => {
  reset();
  logger.logResult('A', 'success');
  const s = logger.buildSummary();
  assert.equal(s.includes('Action Required'), false);
  assert.match(s, /📋 Manual needed:\s+0/);
});

test('resetResults clears every bucket in place and keeps the shared reference', () => {
  reset();
  logger.logResult('A', 'success');
  logger.logResult('B', 'error', 'boom');
  const ref = logger.results;
  const returned = logger.resetResults();

  assert.equal(returned, ref, 'resetResults returns the same shared reference');
  for (const k of ['succeeded', 'skipped', 'notFound', 'captchaFailed', 'manual', 'errors']) {
    assert.equal(logger.results[k].length, 0, `${k} should be empty after reset`);
  }
  assert.equal(typeof logger.results.runAt, 'string');
});

// ── WP3: dead status ──────────────────────────────────────────────────────────

test('logResult routes dead status to dead bucket', () => {
  logger.resetResults();
  logger.logResult('deadsite.com', 'dead', 'HTTP 404');
  assert.equal(logger.results.dead.length, 1);
  assert.equal(logger.results.dead[0].broker, 'deadsite.com');
  assert.equal(logger.results.dead[0].status, 'dead');
  // Must NOT land in errors
  assert.equal(logger.results.errors.length, 0);
});

test('STATUS_BUCKET maps dead to dead bucket', () => {
  assert.equal(logger.STATUS_BUCKET.dead, 'dead');
});

test('ICONS has 💀 for dead', () => {
  assert.equal(logger.ICONS.dead, '💀');
});

test('resetResults clears the dead bucket', () => {
  logger.resetResults();
  logger.logResult('gone.com', 'dead', 'ERR_NAME_NOT_RESOLVED');
  assert.equal(logger.results.dead.length, 1);
  logger.resetResults();
  assert.equal(logger.results.dead.length, 0);
});

// ── WP4: pending_confirm bucket ──────────────────────────────────────────────

test('logResult routes pending_confirm into pendingConfirm bucket', () => {
  logger.resetResults();
  logger.logResult('Pipl', 'pending_confirm', 'check your email to confirm');
  assert.equal(logger.results.pendingConfirm.length, 1);
  assert.equal(logger.results.pendingConfirm[0].broker, 'Pipl');
  // Must NOT be a success
  assert.equal(logger.results.succeeded.length, 0);
});

test('STATUS_BUCKET maps pending_confirm and ICONS has 📧', () => {
  assert.equal(logger.STATUS_BUCKET.pending_confirm, 'pendingConfirm');
  assert.equal(logger.ICONS.pending_confirm, '📧');
});

test('resetResults clears pendingConfirm bucket', () => {
  logger.resetResults();
  logger.logResult('X', 'pending_confirm', 'check your inbox');
  assert.equal(logger.results.pendingConfirm.length, 1);
  logger.resetResults();
  assert.equal(logger.results.pendingConfirm.length, 0);
});

test('buildSummary lists pending-confirmation brokers in their own section', () => {
  logger.resetResults();
  logger.logResult('Pipl', 'pending_confirm', 'Please check your email');
  logger.logResult('Spokeo', 'pending_confirm', 'We have sent you a confirmation');
  logger.logResult('Acxiom', 'success');
  const s = logger.buildSummary();
  assert.match(s, /📧 Awaiting email confirm:\s+2/);
  assert.match(s, /Awaiting email confirmation/);
  assert.match(s, /• Pipl/);
  assert.match(s, /• Spokeo/);
});

// ── WP7: transparency / disclaimer wording ─────────────────────────────────

test('buildSummary uses "Submitted (form accepted)" wording, not "Removed"', () => {
  logger.resetResults();
  logger.logResult('A', 'success');
  const s = logger.buildSummary();
  assert.match(s, /Submitted \(form accepted\)/);
  assert.equal(s.includes('Removed:'), false);
});

test('buildSummary contains honest disclaimer footer', () => {
  logger.resetResults();
  const s = logger.buildSummary();
  assert.match(s, /Submitted ≠ confirmed deleted/);
  assert.match(s, /--verify/);
});

test('DISCLAIMER constant is exported', () => {
  assert.equal(typeof logger.DISCLAIMER, 'string');
  assert.match(logger.DISCLAIMER, /Submitted ≠ confirmed deleted/);
});

// ── WP3 (this WP): inbox checklist for pending_confirm ───────────────────────

test('buildSummary includes Watch your inbox header when pendingConfirm > 0', () => {
  logger.resetResults();
  logger.logResult('Radaris', 'pending_confirm', 'optOutUrl:https://www.radaris.com/optout');
  logger.logResult('InfoTracer', 'pending_confirm', 'optOutUrl:https://infotracer.com/remove');
  const s = logger.buildSummary();
  assert.match(s, /Watch your inbox/);
});

test('buildSummary lists one bullet per pending broker with sender domain', () => {
  logger.resetResults();
  logger.logResult('Radaris', 'pending_confirm', 'optOutUrl:https://www.radaris.com/optout');
  logger.logResult('InfoTracer', 'pending_confirm', 'optOutUrl:https://infotracer.com/remove');
  const s = logger.buildSummary();
  assert.match(s, /• Radaris \(sender: radaris\.com\)/);
  assert.match(s, /• InfoTracer \(sender: infotracer\.com\)/);
});

test('buildSummary inbox checklist falls back to broker name when no optOutUrl in detail', () => {
  logger.resetResults();
  logger.logResult('SomeDataBroker', 'pending_confirm', 'check your inbox');
  const s = logger.buildSummary();
  assert.match(s, /• SomeDataBroker/);
  // Should not crash; sender fallback uses broker name
  assert.match(s, /sender: SomeDataBroker/);
});

test('buildSummary omits Watch your inbox section when pendingConfirm is empty', () => {
  logger.resetResults();
  logger.logResult('A', 'success');
  const s = logger.buildSummary();
  assert.equal(s.includes('Watch your inbox'), false);
});

test('buildSummary shows 💀 Dead line and excludes dead from ❌ Errors count', () => {
  logger.resetResults();
  logger.logResult('ok.com', 'success');
  logger.logResult('gone1.com', 'dead', 'HTTP 404');
  logger.logResult('gone2.com', 'dead', 'ERR_NAME_NOT_RESOLVED');
  logger.logResult('broken.com', 'error', 'Timeout');

  const s = logger.buildSummary();
  // Dead line present with correct count
  assert.match(s, /💀 Dead \(stale URL\):\s+2/);
  // Errors shows only genuine errors, not dead ones
  assert.match(s, /❌ Errors:\s+1/);
  // Sanity-check success
  assert.match(s, /✅ Submitted \(form accepted\):\s+1/);
});
