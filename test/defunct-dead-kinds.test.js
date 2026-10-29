/**
 * test/defunct-dead-kinds.test.js
 *
 * BRK-10: the generic runner records 'dead' (DNS failure, 404/410/5xx) but
 * isUnreachable only counted 'error', so a gone site never became "defunct".
 * And 'error' also covered form-validation failures, so a site that answered
 * every time but rejected our form looked unreachable. Validation failures are
 * now recorded as 'form_error' and excluded.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isUnreachable, isDefunct, findDefunct, isUnreachableError, DEFUNCT_THRESHOLD } = require('../lib/defunct');

test('BRK-10: "dead" counts as unreachable', () => {
  assert.equal(isUnreachable('dead'), true);
});

test('BRK-10: five consecutive "dead" runs make a broker defunct', () => {
  assert.equal(isDefunct(Array(DEFUNCT_THRESHOLD).fill('dead')), true);
  assert.deepEqual(findDefunct({ Gone: { history: Array(DEFUNCT_THRESHOLD).fill('dead') } }), ['Gone']);
});

test('BRK-10: "dead" and network "error" entries mix', () => {
  const history = ['success', 'dead', 'error', 'dead', 'error', 'dead'];
  assert.equal(isDefunct(history), true);
});

test('BRK-10: form-validation failures are not unreachability', () => {
  assert.equal(isUnreachable('form_error'), false);
  assert.equal(isDefunct(Array(DEFUNCT_THRESHOLD).fill('form_error')), false);
  assert.deepEqual(findDefunct({ Picky: { history: Array(DEFUNCT_THRESHOLD).fill('form_error') } }), []);
});

test('BRK-10: one validation failure inside the tail breaks the streak', () => {
  const tail = Array(DEFUNCT_THRESHOLD).fill('dead');
  tail[1] = 'form_error';
  assert.equal(isDefunct(tail), false);
});

test('isUnreachableError recognises DNS, connection and HTTP-gone failures', () => {
  for (const msg of [
    'page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_CONNECTION_TIMED_OUT',
    'getaddrinfo ENOTFOUND x.test',
    'connect ECONNREFUSED 127.0.0.1:443',
    'page.goto: Timeout 15000ms exceeded.',
    'opt-out URL returned HTTP 404',
    'HTTP 410',
    'HTTP 503',
  ]) {
    assert.equal(isUnreachableError(msg), true, msg);
  }
});

test('isUnreachableError does not call a bot wall, validation error or odd exception unreachable', () => {
  for (const msg of ['bot wall detected', 'HTTP 403', 'This field is required.', 'Target page, context or browser has been closed', '', null, undefined]) {
    assert.equal(isUnreachableError(msg), false, String(msg));
  }
});
