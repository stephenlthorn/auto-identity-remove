/**
 * test/notify-manual-urls.test.js
 *
 * At the end of a run the watcher opens the sites that need a person. It took the
 * WHOLE detail of each manual / CAPTCHA-failed result as the URL, which only works
 * while the detail is a bare URL. R1's CAPTCHA detail starts with the URL and goes
 * on ("<url> - CAPTCHA not solved within 3 min; retry with: aidr captchas"), so
 * `detail.startsWith('http')` held and the whole sentence was handed to the
 * browser as an address. The URL is the first word.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { manualUrlsFromResults, pickManualUrlsToOpen } = require('../lib/notify');

test('a CAPTCHA detail contributes only its URL', () => {
  const urls = manualUrlsFromResults([
    { broker: 'Spokeo', detail: 'https://www.spokeo.com/optout - CAPTCHA not solved within 3 min; retry with: aidr captchas' },
  ]);
  assert.deepEqual(urls, ['https://www.spokeo.com/optout']);
});

test('a bare URL detail still works', () => {
  assert.deepEqual(manualUrlsFromResults([{ detail: 'https://example.com/a' }]), ['https://example.com/a']);
});

test('details that do not start with a web address are dropped', () => {
  const urls = manualUrlsFromResults([
    { detail: 'Needs an account: https://example.com/login' },
    { detail: '' },
    { detail: undefined },
    { detail: 'javascript:alert(1)' },
    { detail: 'ftp://example.com/x' },
    {},
    null,
  ]);
  assert.deepEqual(urls, []);
});

test('http and https both count, in any case', () => {
  assert.deepEqual(
    manualUrlsFromResults([{ detail: 'HTTP://example.com/a nope' }, { detail: 'https://example.com/b' }]),
    ['HTTP://example.com/a', 'https://example.com/b'],
  );
});

test('the result is what pickManualUrlsToOpen takes: persons share brokers, so duplicates collapse', () => {
  const urls = manualUrlsFromResults([
    { detail: 'https://a.example/x - CAPTCHA could not be solved' },
    { detail: 'https://a.example/x - CAPTCHA could not be solved' },
  ]);
  assert.deepEqual(pickManualUrlsToOpen(urls).open, ['https://a.example/x']);
});

test('a missing list is an empty list', () => {
  assert.deepEqual(manualUrlsFromResults(undefined), []);
  assert.deepEqual(manualUrlsFromResults(null), []);
});
