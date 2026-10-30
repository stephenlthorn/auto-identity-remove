/**
 * test/logger-generic-captcha.test.js
 *
 * R2 gave the generic pass a CAPTCHA gate, so a form behind a CAPTCHA that nobody
 * solved is counted as `captcha_failed` in genericStats. The end-of-run summary
 * printed attempted / submitted / no-form-found / error and nothing else, so those
 * brokers vanished from the generic line: the numbers did not add up and nothing
 * pointed at `aidr captchas`.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../lib/logger');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; logger.results.genericStats = undefined; });

const stats = (extra = {}) => ({ attempted: 10, submitted: 5, no_form_found: 3, error: 1, unverified: 0, captcha_failed: 0, ...extra });

test('the generic line counts brokers that stopped at a CAPTCHA', () => {
  logger.results.genericStats = stats({ captcha_failed: 2 });
  const summary = logger.buildSummary();
  assert.match(summary, /Generic runner: 10 attempted \| 5 submitted \| 3 no-form-found \| 1 error \| 2 captcha-failed/);
});

test('with no generic CAPTCHA failures the line is unchanged', () => {
  logger.results.genericStats = stats();
  const line = logger.buildSummary().split('\n').find(l => l.startsWith('Generic runner'));
  assert.equal(line, 'Generic runner: 10 attempted | 5 submitted | 3 no-form-found | 1 error');
});

test('unverified and captcha-failed both show, in that order', () => {
  logger.results.genericStats = stats({ unverified: 4, captcha_failed: 2 });
  const line = logger.buildSummary().split('\n').find(l => l.startsWith('Generic runner'));
  assert.match(line, /1 error \| 4 unverified \| 2 captcha-failed$/);
});
