/**
 * test/docs-drop.test.js
 *
 * Three files once said California's DROP was "not yet live" while it was open to
 * consumers: the README section, a STATUS.md row and a brokers.js entry marked
 * documented_not_live. Nothing noticed. This pins the wording so it cannot go stale
 * silently again, and pins the page the manual entry opens.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const CONSUMER_URL = 'https://consumer.drop.privacy.ca.gov';

test('README.md, STATUS.md and brokers.js never say DROP is not yet live', () => {
  for (const file of ['README.md', 'STATUS.md', 'brokers.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /documented_not_live/, `${file} carries documented_not_live`);
    assert.doesNotMatch(text, /DROP[^.\n]{0,80}\bnot (yet )?live/i, `${file} says DROP is not live`);
    assert.doesNotMatch(text, /not (yet )?live[^.\n]{0,80}\bDROP/i, `${file} says DROP is not live`);
    assert.doesNotMatch(text, /DROP[^.\n]{0,60}\bwill eventually/i, `${file} talks about DROP in the future tense`);
    assert.doesNotMatch(text, /4000\+/, `${file} claims 4000+ California brokers`);
  }
});

test('the manual DROP entry opens the consumer page', () => {
  const brokers = require('../brokers');
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.ok(entry, 'CalPrivacy DROP must exist');
  assert.equal(entry.optOutUrl, CONSUMER_URL);
});

test('STATUS.md has one DROP row and no DELETE Portal row', () => {
  const status = read('STATUS.md');
  assert.equal((status.match(/^\| CalPrivacy DROP \|/gm) || []).length, 1);
  assert.doesNotMatch(status, /California DELETE Portal/);
});

test('the README section states the live dates, the 90-day window and the complaint form', () => {
  const readme = read('README.md');
  const start = readme.indexOf('### California residents: DROP');
  assert.ok(start >= 0, 'the README needs the California DROP section');
  const section = readme.slice(start, readme.indexOf('\n---', start));
  assert.match(section, /2026-01-01/);
  assert.match(section, /2026-08-01/);
  assert.match(section, /90 days/);
  // The registry's size changes; the README must not state it as a fixed number (D12).
  assert.match(section, /several hundred/);
  assert.doesNotMatch(section, /\b\d{3,}\s+(registered\s+)?brokers\b/i, 'no fixed broker count');
  assert.match(section, /aidr update-brokers/);
  assert.ok(section.includes(CONSUMER_URL));
  assert.ok(section.includes('https://cppa.ca.gov/webapplications/complaint'));
  assert.match(section, /1798\.99\.86/);
});
