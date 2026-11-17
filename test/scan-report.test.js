/**
 * S11: `aidr scan` prints a listing's full URL only on an interactive terminal. The path of a
 * people-search listing carries the person's name, and stdout is often captured to a log (cron,
 * launchd, docker); the run prints the host only for the same reason. The full URLs stay in
 * state.json.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanReportLines } = require('../lib/scan-report');

// Shaped like a real people-search listing: the name and the city are in the path.
const LISTING = 'https://www.spokeo.com/Jane-Sample/Austin-TX/Jane-Sample-p123456789';

const result = () => ({
  found: [{ broker: 'Spokeo', listingUrl: LISTING, screenshot: '/home/me/aidr/snapshots/scan-Spokeo.png' }],
  not_found: [], unvalidated: [], unknown: [], unsearchable: [],
});
const label = (e) => e.broker;
const text = (opts) => scanReportLines(result(), { label, ...opts }).join('\n');

test('on an interactive terminal the full listing URL is printed', () => {
  assert.match(text({ interactive: true }), /Spokeo: https:\/\/www\.spokeo\.com\/Jane-Sample\/Austin-TX\/Jane-Sample-p123456789/);
  assert.doesNotMatch(text({ interactive: true }), /full URLs are in/);
});

test('anywhere else only the host is printed, with one line saying where the full URLs are', () => {
  const out = text({ interactive: false, statePath: '/home/me/aidr/state.json' });
  assert.match(out, /- Spokeo: www\.spokeo\.com\n/);
  assert.doesNotMatch(out, /Jane-Sample|Austin-TX|p123456789|https:\/\//);
  const notes = out.split('\n').filter(l => /full listing URLs are in/.test(l));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\/home\/me\/aidr\/state\.json/);
});

test('the default is the cautious one', () => {
  assert.doesNotMatch(text({}), /Jane-Sample/);
});

test('no found listing, no note', () => {
  const out = scanReportLines({ found: [], not_found: [{ broker: 'A' }], unvalidated: [], unknown: [], unsearchable: [] }, { label, interactive: false }).join('\n');
  assert.doesNotMatch(out, /full listing URLs/);
});

test('a listing URL that cannot be parsed prints no path either', () => {
  const r = result();
  r.found[0].listingUrl = 'not a url but Jane-Sample is in it';
  const out = scanReportLines(r, { label, interactive: false }).join('\n');
  assert.doesNotMatch(out, /Jane-Sample/);
});
