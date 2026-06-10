/**
 * test/serp-watch.test.js
 *
 * Pure unit tests for lib/serp-watch.js.
 * No live network. No real browser. No disk I/O (deps are injected).
 *
 * Tested behaviours (this task):
 *  1. diffSerpResults(previous, current) - { newDomains, goneDomains, stillPresent }
 *  2. summaryHostnames(summary)          - broker hostnames from a runSerpScan summary
 *  3. historyHostnames(history)          - distinct hostnames from a history array
 *  4. buildAlert(diff, persons)          - concise alert string for new domains
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

const {
  diffSerpResults,
  summaryHostnames,
  historyHostnames,
  buildAlert,
} = require('../lib/serp-watch');

// --- diffSerpResults ---------------------------------------------------------

test('diffSerpResults reports a domain present in current but not previous as new', () => {
  const diff = diffSerpResults(['spokeo.com'], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
});

test('diffSerpResults reports a domain present in previous but not current as gone', () => {
  const diff = diffSerpResults(['spokeo.com', 'radaris.com'], ['spokeo.com']);
  assert.deepEqual(diff.goneDomains, ['radaris.com']);
});

test('diffSerpResults reports a domain present in both as stillPresent', () => {
  const diff = diffSerpResults(['spokeo.com', 'radaris.com'], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.stillPresent.sort(), ['radaris.com', 'spokeo.com']);
  assert.deepEqual(diff.newDomains, []);
  assert.deepEqual(diff.goneDomains, []);
});

test('diffSerpResults with empty previous treats every current domain as new', () => {
  const diff = diffSerpResults([], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains.sort(), ['radaris.com', 'spokeo.com']);
  assert.deepEqual(diff.goneDomains, []);
  assert.deepEqual(diff.stillPresent, []);
});

test('diffSerpResults with empty current reports everything gone', () => {
  const diff = diffSerpResults(['spokeo.com'], []);
  assert.deepEqual(diff.newDomains, []);
  assert.deepEqual(diff.goneDomains, ['spokeo.com']);
  assert.deepEqual(diff.stillPresent, []);
});

test('diffSerpResults with both empty returns all-empty arrays', () => {
  const diff = diffSerpResults([], []);
  assert.deepEqual(diff, { newDomains: [], goneDomains: [], stillPresent: [] });
});

test('diffSerpResults deduplicates repeated domains in inputs', () => {
  const diff = diffSerpResults(['spokeo.com', 'spokeo.com'], ['spokeo.com', 'spokeo.com', 'radaris.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
  assert.deepEqual(diff.stillPresent, ['spokeo.com']);
});

test('diffSerpResults result arrays are sorted for stable output', () => {
  const diff = diffSerpResults([], ['zlocate.com', 'apeople.com', 'mradaris.com']);
  assert.deepEqual(diff.newDomains, ['apeople.com', 'mradaris.com', 'zlocate.com']);
});

test('diffSerpResults ignores empty-string and falsy entries', () => {
  const diff = diffSerpResults(['', null, 'spokeo.com'], [undefined, '', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
  assert.deepEqual(diff.goneDomains, ['spokeo.com']);
});

// --- summaryHostnames --------------------------------------------------------

test('summaryHostnames maps a runSerpScan summary to its broker hostnames', () => {
  const summary = {
    total_brokers_appearing: 2,
    results: [
      { broker: 'Spokeo', hostname: 'spokeo.com', ranks: { ddg: 1, bing: null, google: null } },
      { broker: 'Radaris', hostname: 'radaris.com', ranks: { ddg: null, bing: 2, google: null } },
    ],
    blocked: [],
  };
  assert.deepEqual(summaryHostnames(summary).sort(), ['radaris.com', 'spokeo.com']);
});

test('summaryHostnames returns empty array for an empty summary', () => {
  assert.deepEqual(summaryHostnames({ total_brokers_appearing: 0, results: [], blocked: [] }), []);
});

test('summaryHostnames tolerates a null or malformed summary', () => {
  assert.deepEqual(summaryHostnames(null), []);
  assert.deepEqual(summaryHostnames({}), []);
  assert.deepEqual(summaryHostnames({ results: null }), []);
});

// --- historyHostnames --------------------------------------------------------

test('historyHostnames returns distinct hostnames from a history array', () => {
  const history = [
    { hostname: 'spokeo.com' },
    { hostname: 'spokeo.com' },
    { hostname: 'radaris.com' },
  ];
  assert.deepEqual(historyHostnames(history).sort(), ['radaris.com', 'spokeo.com']);
});

test('historyHostnames returns empty array for empty / non-array input', () => {
  assert.deepEqual(historyHostnames([]), []);
  assert.deepEqual(historyHostnames(null), []);
  assert.deepEqual(historyHostnames(undefined), []);
});

test('historyHostnames skips entries with no hostname', () => {
  const history = [{ hostname: 'spokeo.com' }, { broker: 'X' }, { hostname: '' }];
  assert.deepEqual(historyHostnames(history), ['spokeo.com']);
});

// --- buildAlert --------------------------------------------------------------

test('buildAlert lists the new domains in a concise string', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }];
  const msg = buildAlert({ newDomains: ['radaris.com', 'spokeo.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /SERP watch/i);
  assert.match(msg, /radaris\.com/);
  assert.match(msg, /spokeo\.com/);
});

test('buildAlert includes the person name when a single person is watched', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }];
  const msg = buildAlert({ newDomains: ['radaris.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /Jane Doe/);
});

test('buildAlert summarises a count when multiple persons are watched', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }, { firstName: 'Bob', lastName: 'Smith' }];
  const msg = buildAlert({ newDomains: ['radaris.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /2 watched/i);
});
