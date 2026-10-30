/**
 * test/config-check-roadmap.test.js
 *
 * `aidr config check` grew with the roadmap: the CAPTCHA settings (R1), the browser
 * section (R7) and retention.days (R6). A bad browser section stops a run
 * (the launch throws rather than start without its proxy), so it is a problem. A
 * bad captcha or retention value runs fine and quietly does something else (a
 * typo in captcha.manual means "auto"; an unusable retention.days means "keep
 * everything"), which is exactly what a warning is for: it says what is used instead.
 *
 * The output is made to be pasted into a bug report, so a proxy password never
 * appears in it.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkConfig, formatConfigCheck } = require('../lib/config-check');
const { captchaConfigWarnings } = require('../lib/manual-captcha');
const h = require('./config-check-helpers');

function check(extra) {
  const root = h.makeRoot();
  try {
    h.writePlain(root, h.goodConfig(extra));
    const result = checkConfig({ env: {}, root });
    return { result, text: h.everything(result, formatConfigCheck) };
  } finally {
    h.cleanup(root);
  }
}

// ── captcha ──────────────────────────────────────────────────────────────────

test('the documented captcha settings are clean', () => {
  for (const captcha of [undefined, {}, { manual: 'auto' }, { manual: true }, { manual: false }, { manual: 'true' }, { manualTimeoutSec: 30 }, { manual: 'auto', manualTimeoutSec: 180 }]) {
    const { result } = check(captcha === undefined ? {} : { captcha });
    assert.equal(result.ok, true, JSON.stringify(captcha));
    assert.deepEqual(result.warnings.filter(w => /captcha/.test(w)), [], JSON.stringify(captcha));
  }
});

test('captcha.manual outside auto/true/false is a warning that says what is used instead', () => {
  const { result } = check({ captcha: { manual: 'yes' } });
  assert.equal(result.ok, true, 'it runs: the value is read as "auto"');
  const warning = result.warnings.find(w => /captcha\.manual/.test(w));
  assert.ok(warning, result.warnings.join('\n'));
  assert.match(warning, /"auto"/);
  assert.match(warning, /yes/);
});

test('captcha.manualTimeoutSec must be a positive number of seconds', () => {
  for (const bad of [0, -5, 'abc', null, NaN, {}, true]) {
    const warnings = captchaConfigWarnings({ captcha: { manualTimeoutSec: bad } });
    if (bad === null) { assert.deepEqual(warnings, [], 'null is the same as leaving it out'); continue; }
    assert.ok(warnings.some(w => /captcha\.manualTimeoutSec/.test(w) && /180/.test(w)), `${String(bad)}: ${warnings.join('|')}`);
  }
  assert.deepEqual(captchaConfigWarnings({ captcha: { manualTimeoutSec: 45 } }), []);
});

test('a captcha.manualTimeoutSec above the limit says it is capped', () => {
  const warnings = captchaConfigWarnings({ captcha: { manualTimeoutSec: 99999 } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /3600/);
});

test('a captcha section that is not an object is ignored with a warning', () => {
  const warnings = captchaConfigWarnings({ captcha: 'manual' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /captcha must be an object/);
  assert.deepEqual(captchaConfigWarnings({}), []);
  assert.deepEqual(captchaConfigWarnings(null), []);
});

// ── browser ──────────────────────────────────────────────────────────────────

test('a valid browser section with a proxy is clean', () => {
  const { result } = check({ browser: { userAgent: 'Mozilla/5.0 Test', proxy: { server: 'http://proxy.example.net:8080', username: 'u', password: 'proxy-pass-7731' } } });
  assert.equal(result.ok, true, result.problems.join('\n'));
});

test('a bad browser section is a problem and never echoes the proxy password', () => {
  const { result, text } = check({ browser: { proxy: { server: 'ftp://proxy.example.net:21', username: 'proxy-user-5521', password: 'proxy-pass-7731' } } });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /proxy/i.test(p)), result.problems.join('\n'));
  assert.ok(!text.includes('proxy-pass-7731'), 'the password must not reach the report');
});

test('a misspelt browser key is a problem (a typo in "proxy" would otherwise launch without one)', () => {
  const { result } = check({ browser: { proxxy: { server: 'http://proxy.example.net:8080' } } });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => /proxxy/.test(p)), result.problems.join('\n'));
});

// ── retention ────────────────────────────────────────────────────────────────

test('retention.days is clean when usable or absent', () => {
  for (const retention of [undefined, { days: 180 }, { days: '6m' }, { _comment: 'off' }]) {
    const { result } = check(retention === undefined ? {} : { retention });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.filter(w => /retention/.test(w)), [], JSON.stringify(retention));
  }
});

test('an unusable retention.days is a warning that says nothing is purged', () => {
  const { result } = check({ retention: { days: 3 } });
  assert.equal(result.ok, true);
  const warning = result.warnings.find(w => /retention/.test(w));
  assert.ok(warning, result.warnings.join('\n'));
  assert.match(warning, /kept|nothing|no files/i);

  const garbage = check({ retention: { days: 'soon' } });
  assert.ok(garbage.result.warnings.some(w => /retention/.test(w)));
});
