/**
 * dashboard/validate.test.js
 *
 * Security regression tests for the dashboard run-request validation, added
 * after a security review of the web-dashboard PR. These cover:
 *   1. Flag-injection via --only/--skip filter values.
 *   2. Server-side confirmation requirement for live (real-action) modes.
 *
 * Pure logic only - no express dependency - so it runs under the repo's
 * top-level `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLiveMode, modeHonorsFilters, classifyStatus, resolveEnvCreds, validateFilter, validateRunRequest } = require('./validate');

// Mirror of server.js MODE_ARGS keys (values irrelevant to validation).
const MODE_ARGS = {
  preview: ['--preview'],
  real: [],
  verify: ['--verify'],
  doctor: ['--doctor'],
  list: ['--list'],
  pending: ['--pending'],
  confirm: ['--confirm-emails'],
  retry: ['--retry-failed'],
  serp: ['--serp-scan'],
  snapshot: ['--snapshot'],
};

// ── validateFilter ───────────────────────────────────────────────────────────

test('validateFilter: undefined/empty is allowed and yields undefined', () => {
  for (const v of [undefined, null, '', '   ', ',']) {
    const r = validateFilter(v);
    assert.equal(r.ok, true, `value ${JSON.stringify(v)} should be ok`);
    assert.equal(r.value, undefined);
  }
});

test('validateFilter: plain broker names pass through trimmed', () => {
  const r = validateFilter(' Spokeo , BeenVerified ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Spokeo,BeenVerified');
});

test('validateFilter: rejects a value that starts with "-" (flag injection)', () => {
  for (const bad of ['--no-capsolver', '--serp-scan', '--snapshot', '--resume', '--pollute', '-x']) {
    const r = validateFilter(bad);
    assert.equal(r.ok, false, `"${bad}" must be rejected`);
    assert.match(r.error, /flag injection|cannot start/i);
  }
});

test('validateFilter: rejects an injected flag hidden among valid names', () => {
  const r = validateFilter('Spokeo,--pollute,BeenVerified');
  assert.equal(r.ok, false, 'a "-"-prefixed token anywhere must reject the whole value');
});

test('validateFilter: rejects non-string values', () => {
  for (const bad of [42, {}, ['x'], true]) {
    const r = validateFilter(bad);
    assert.equal(r.ok, false);
  }
});

// ── isLiveMode ───────────────────────────────────────────────────────────────

test('isLiveMode: real/retry/snapshot/confirm are live; others are not', () => {
  for (const m of ['real', 'retry', 'snapshot', 'confirm']) assert.equal(isLiveMode(m), true, `${m} live`);
  for (const m of ['preview', 'verify', 'doctor', 'list', 'pending', 'serp']) assert.equal(isLiveMode(m), false, `${m} not live`);
});

// ── validateRunRequest ───────────────────────────────────────────────────────

test('validateRunRequest: defaults to preview when no mode given', () => {
  const r = validateRunRequest({}, MODE_ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'preview');
});

test('validateRunRequest: rejects an unknown mode', () => {
  const r = validateRunRequest({ mode: 'evil' }, MODE_ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /unknown mode/);
});

test('validateRunRequest: live mode WITHOUT confirm is rejected', () => {
  for (const mode of ['real', 'retry', 'snapshot', 'confirm']) {
    const r = validateRunRequest({ mode }, MODE_ARGS);
    assert.equal(r.ok, false, `${mode} without confirm must be rejected`);
    assert.equal(r.status, 400);
    assert.match(r.error, /confirm/);
  }
});

test('validateRunRequest: live mode WITH confirm:true is accepted', () => {
  for (const mode of ['real', 'retry', 'snapshot', 'confirm']) {
    const r = validateRunRequest({ mode, confirm: true }, MODE_ARGS);
    assert.equal(r.ok, true, `${mode} with confirm should pass`);
    assert.equal(r.mode, mode);
  }
});

test('validateRunRequest: confirm must be exactly true (not truthy)', () => {
  for (const c of ['true', 1, 'yes', {}]) {
    const r = validateRunRequest({ mode: 'real', confirm: c }, MODE_ARGS);
    assert.equal(r.ok, false, `confirm=${JSON.stringify(c)} must not satisfy the gate`);
  }
});

test('validateRunRequest: non-live modes do not require confirm', () => {
  for (const mode of ['preview', 'verify', 'doctor', 'list', 'pending', 'serp']) {
    const r = validateRunRequest({ mode }, MODE_ARGS);
    assert.equal(r.ok, true, `${mode} should not require confirm`);
  }
});

test('validateRunRequest: flag-injection in only/skip is rejected even for a safe mode', () => {
  const r1 = validateRunRequest({ mode: 'preview', only: '--pollute' }, MODE_ARGS);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  const r2 = validateRunRequest({ mode: 'preview', skip: '--serp-scan' }, MODE_ARGS);
  assert.equal(r2.ok, false);
});

test('validateRunRequest: clean filters are normalized onto the result', () => {
  const r = validateRunRequest({ mode: 'preview', only: ' Spokeo , Radaris ', skip: 'MyLife' }, MODE_ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.only, 'Spokeo,Radaris');
  assert.equal(r.skip, 'MyLife');
});

// ── modeHonorsFilters ────────────────────────────────────────────────────────

test('modeHonorsFilters: preview/real/retry honor filters', () => {
  for (const m of ['preview', 'real', 'retry']) {
    assert.equal(modeHonorsFilters(m), true, `${m} should honor filters`);
  }
});

test('modeHonorsFilters: list/pending/confirm/doctor/verify/serp do not honor filters', () => {
  for (const m of ['list', 'pending', 'confirm', 'doctor', 'verify', 'serp', 'snapshot']) {
    assert.equal(modeHonorsFilters(m), false, `${m} should not honor filters`);
  }
});

// ── classifyStatus ───────────────────────────────────────────────────────────

test('classifyStatus: success -> ok', () => {
  assert.equal(classifyStatus('success'), 'ok');
});

test('classifyStatus: notFound -> notfound', () => {
  assert.equal(classifyStatus('notFound'), 'notfound');
});

test('classifyStatus: pending_confirm -> pending', () => {
  assert.equal(classifyStatus('pending_confirm'), 'pending');
});

test('classifyStatus: unverified -> pending', () => {
  assert.equal(classifyStatus('unverified'), 'pending');
});

test('classifyStatus: error -> error', () => {
  assert.equal(classifyStatus('error'), 'error');
});

test('classifyStatus: captcha_failed -> error', () => {
  assert.equal(classifyStatus('captcha_failed'), 'error');
});

test('classifyStatus: dead -> error', () => {
  assert.equal(classifyStatus('dead'), 'error');
});

test('classifyStatus: manual -> manual', () => {
  assert.equal(classifyStatus('manual'), 'manual');
});

test('classifyStatus: unknown string -> other', () => {
  assert.equal(classifyStatus('bogus'), 'other');
  assert.equal(classifyStatus(''), 'other');
  assert.equal(classifyStatus(undefined), 'other');
  assert.equal(classifyStatus(null), 'other');
});

test('classifyStatus: case-insensitive matching', () => {
  assert.equal(classifyStatus('SUCCESS'), 'ok');
  assert.equal(classifyStatus('Pending_Confirm'), 'pending');
  assert.equal(classifyStatus('CAPTCHA_FAILED'), 'error');
});

// ── resolveEnvCreds ──────────────────────────────────────────────────────────

test('resolveEnvCreds: both set -> envConfigured true, no warning', () => {
  const r = resolveEnvCreds('admin', 'secret');
  assert.equal(r.envConfigured, true);
  assert.equal(r.envUser, 'admin');
  assert.equal(r.envPass, 'secret');
  assert.equal(r.warning, undefined);
});

test('resolveEnvCreds: neither set -> envConfigured false, no warning', () => {
  const r = resolveEnvCreds('', '');
  assert.equal(r.envConfigured, false);
  assert.equal(r.warning, undefined);
});

test('resolveEnvCreds: only user set -> envConfigured false, warning emitted', () => {
  const r = resolveEnvCreds('admin', '');
  assert.equal(r.envConfigured, false);
  assert.equal(r.envUser, '');
  assert.equal(r.envPass, '');
  assert.ok(r.warning, 'should emit a warning');
  assert.match(r.warning, /AIDR_USER|AIDR_PASS/);
});

test('resolveEnvCreds: only pass set -> envConfigured false, warning emitted', () => {
  const r = resolveEnvCreds('', 'secret');
  assert.equal(r.envConfigured, false);
  assert.ok(r.warning, 'should emit a warning');
});
