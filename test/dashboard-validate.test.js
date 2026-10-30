/**
 * test/dashboard-validate.test.js
 *
 * Pure-logic regressions for the dashboard hardening pass (DASH-3, DASH-5,
 * DASH-9, DASH-13, DASH-15). No express: this runs under the top-level suite.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateFilter,
  validateRunRequest,
  validateUsername,
  aggregateBrokerStatus,
  hostnameOf,
  buildAllowedHosts,
  isHostAllowed,
  isLoopbackHost,
  checkBindSafety,
  resolveEnvCreds,
} = require('../dashboard/validate');

const MODE_ARGS = {
  preview: ['--preview'], real: [], verify: ['--verify'], doctor: ['--doctor'],
  list: ['--list'], pending: ['--pending'], confirm: ['--confirm-emails'],
  retry: ['--retry-failed'], serp: ['--serp-scan'], snapshot: ['--snapshot'],
};

// ---- DASH-3: mode must be a string ------------------------------------------

test('DASH-3: an array mode cannot bypass the live-mode confirm guard', () => {
  // {"mode":["real"]}: hasOwnProperty coerces the array to "real", the LIVE_MODES
  // Set lookup does not, so the confirm check was skipped and a real run started.
  const r = validateRunRequest({ mode: ['real'] }, MODE_ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /mode must be a string/);
});

test('DASH-3: object, number and boolean modes are rejected too', () => {
  for (const mode of [{ toString: () => 'real' }, 1, true, ['preview']]) {
    const r = validateRunRequest({ mode }, MODE_ARGS);
    assert.equal(r.ok, false, `mode ${JSON.stringify(mode)} must be rejected`);
    assert.equal(r.status, 400);
  }
});

test('DASH-3: a missing mode still defaults to the safe preview mode', () => {
  const r = validateRunRequest({}, MODE_ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'preview');
});

// ---- DASH-9: control characters in filters ----------------------------------

test('DASH-9: a NUL byte in a filter is rejected (spawn() would throw on it)', () => {
  const r = validateFilter('a\u0000b');
  assert.equal(r.ok, false);
  assert.match(r.error, /control character/i);
});

test('DASH-9: newlines and other control characters in filters are rejected', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\u0007b', 'a\u007fb', 'Spokeo,\u001bBeen']) {
    assert.equal(validateFilter(bad).ok, false, JSON.stringify(bad));
  }
});

test('DASH-9: ordinary broker names with spaces, dots and ampersands still pass', () => {
  const r = validateFilter('Been Verified, Radaris.com, AT&T');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Been Verified,Radaris.com,AT&T');
});

// ---- DASH-15: username validation -------------------------------------------

test('DASH-15: a username containing ":" is rejected (Basic auth cannot carry it)', () => {
  const r = validateUsername('a:b');
  assert.equal(r.ok, false);
  assert.match(r.error, /":"/);
});

test('DASH-15: control characters in a username are rejected', () => {
  for (const bad of ['a\u0000b', 'a\nb', 'tab\there']) {
    assert.equal(validateUsername(bad).ok, false, JSON.stringify(bad));
  }
});

test('DASH-15: a normal username is trimmed and accepted; blank means keep current', () => {
  assert.deepEqual(validateUsername('  alice  '), { ok: true, value: 'alice' });
  assert.deepEqual(validateUsername(''), { ok: true, value: undefined });
  assert.deepEqual(validateUsername(undefined), { ok: true, value: undefined });
});

test('DASH-15: an absurdly long username is rejected', () => {
  assert.equal(validateUsername('x'.repeat(200)).ok, false);
});

// ---- DASH-5: status aggregation across composite keys -----------------------

test('DASH-5: a "Broker|First Last" success counts for the bare broker name', () => {
  const optOuts = { 'Spokeo|A B': { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } };
  const s = aggregateBrokerStatus(optOuts, 'Spokeo');
  assert.equal(s.key, 'ok');
  assert.equal(s.label, 'success');
  assert.equal(s.date, '2026-01-01T00:00:00.000Z');
});

test('DASH-5: the bare single-person key still works', () => {
  const s = aggregateBrokerStatus({ Spokeo: { history: ['success'] } }, 'Spokeo');
  assert.equal(s.key, 'ok');
});

test('DASH-5: no entries for the broker yields none', () => {
  const s = aggregateBrokerStatus({ Other: { history: ['success'] } }, 'Spokeo');
  assert.equal(s.key, 'none');
  assert.equal(s.label, '-');
});

test('DASH-5: one person failing outranks another succeeding', () => {
  const optOuts = {
    'Spokeo|A B': { history: ['success'] },
    'Spokeo|C D': { history: ['error'] },
  };
  const s = aggregateBrokerStatus(optOuts, 'Spokeo');
  assert.equal(s.key, 'error');
  assert.equal(s.people.length, 2);
  assert.deepEqual(s.people.map(p => [p.person, p.key]).sort(), [['A B', 'ok'], ['C D', 'error']]);
});

test('DASH-5: not-listed for one person does not hide another person\'s success', () => {
  const optOuts = {
    'Spokeo|A B': { history: ['success'] },
    'Spokeo|C D': { history: ['notFound'] },
  };
  assert.equal(aggregateBrokerStatus(optOuts, 'Spokeo').key, 'ok');
});

test('DASH-5: a broker whose name is a prefix of another does not absorb its entries', () => {
  const optOuts = { 'Spokeo Pro|A B': { history: ['success'] } };
  assert.equal(aggregateBrokerStatus(optOuts, 'Spokeo').key, 'none');
});

test('DASH-5: history wins over the legacy status field; latest history entry is used', () => {
  const optOuts = { Spokeo: { status: 'error', history: ['error', 'success'] } };
  assert.equal(aggregateBrokerStatus(optOuts, 'Spokeo').key, 'ok');
});

test('DASH-5: tolerates a missing/garbage optOuts map', () => {
  for (const bad of [undefined, null, [], 'x', 42]) {
    assert.equal(aggregateBrokerStatus(bad, 'Spokeo').key, 'none');
  }
});

// ---- DASH-13: Host allow-list + bind safety ---------------------------------

test('DASH-13: hostnameOf strips ports and handles IPv6 literals', () => {
  assert.equal(hostnameOf('localhost:8080'), 'localhost');
  assert.equal(hostnameOf('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(hostnameOf('[::1]:8080'), '[::1]');
  assert.equal(hostnameOf('LocalHost'), 'localhost');
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf(undefined), null);
  assert.equal(hostnameOf('evil.com:80/../x'), null);
});

test('DASH-13: loopback names are always allowed, foreign names are not', () => {
  const allowed = buildAllowedHosts({ env: {}, bindHost: '127.0.0.1' });
  for (const h of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'localhost', 'app.localhost:80']) {
    assert.equal(isHostAllowed(h, allowed), true, h);
  }
  for (const h of ['evil.example', 'evil.example:8080', '192.168.1.5:8080', 'localhost.evil.com', undefined, '']) {
    assert.equal(isHostAllowed(h, allowed), false, String(h));
  }
});

test('DASH-13: AIDR_ALLOWED_HOSTS adds names (comma separated, ports ignored)', () => {
  const allowed = buildAllowedHosts({
    env: { AIDR_ALLOWED_HOSTS: 'nas.lan, aidr.example.com:8443 ' },
    bindHost: '0.0.0.0',
  });
  assert.equal(isHostAllowed('nas.lan:8080', allowed), true);
  assert.equal(isHostAllowed('aidr.example.com', allowed), true);
  assert.equal(isHostAllowed('other.lan', allowed), false);
});

test('DASH-13: a concrete (non-wildcard) bind address is allowed as a Host', () => {
  const allowed = buildAllowedHosts({ env: {}, bindHost: '192.168.1.10' });
  assert.equal(isHostAllowed('192.168.1.10:8080', allowed), true);
  const wild = buildAllowedHosts({ env: {}, bindHost: '0.0.0.0' });
  assert.equal(isHostAllowed('0.0.0.0:8080', wild), false);
});

test('DASH-13: isLoopbackHost', () => {
  for (const h of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.1', 'example.com', '']) assert.equal(isLoopbackHost(h), false, h);
});

test('DASH-13: refuses a non-loopback bind with no credentials', () => {
  const r = checkBindSafety({ host: '0.0.0.0', authConfigured: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /AIDR_USER|credentials/);
});

test('DASH-13: any bind with credentials is allowed; no credentials is refused, loopback included (codex #1)', () => {
  assert.equal(checkBindSafety({ host: '127.0.0.1', authConfigured: true }).ok, true);
  assert.equal(checkBindSafety({ host: '0.0.0.0', authConfigured: true }).ok, true);
  const loopback = checkBindSafety({ host: '127.0.0.1', authConfigured: false });
  assert.equal(loopback.ok, false);
  assert.equal(loopback.code, 'AIDR_NO_CREDENTIALS');
  assert.match(loopback.error, /AIDR_DASHBOARD_NO_AUTH/);
});

test('codex #1: the explicit opt-out is honoured on loopback and never on a network bind', () => {
  assert.equal(checkBindSafety({ host: '127.0.0.1', authConfigured: false, allowNoAuth: true }).ok, true);
  assert.equal(checkBindSafety({ host: '::1', authConfigured: false, allowNoAuth: true }).ok, true);
  const open = checkBindSafety({ host: '0.0.0.0', authConfigured: false, allowNoAuth: true });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'AIDR_UNSAFE_BIND');
});

test('the example service password is not accepted as an env credential', () => {
  const r = resolveEnvCreds('admin', 'change-me');
  assert.equal(r.envConfigured, false);
  assert.match(r.warning, /change-me/);
});
