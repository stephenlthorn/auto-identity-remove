'use strict';
/**
 * test/broker-health-readme.test.js
 *
 * The README shows the broker count without an edit every week: two shields.io
 * dynamic JSON badges that read summary.ok and summary.total from
 * data/broker-health.json on main. Pin the pieces that make that work.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const badges = [...readme.matchAll(/https:\/\/img\.shields\.io\/badge\/dynamic\/json\?[^)\s]+/g)].map((m) => decodeURIComponent(m[0]));

test('badges read summary.ok and summary.total from the health file on main', () => {
  const queries = badges.map((b) => (b.match(/query=([^&]+)/) || [])[1]);
  assert.ok(queries.includes('$.summary.ok'), `queries: ${queries}`);
  assert.ok(queries.includes('$.summary.total'), `queries: ${queries}`);
  for (const b of badges) {
    assert.match(b, /url=https:\/\/raw\.githubusercontent\.com\/stephenlthorn\/auto-identity-remove\/main\/data\/broker-health\.json/);
  }
});

test('the Broker health section links STATUS.md and states the limits', () => {
  const section = readme.split('## Broker health')[1].split('\n## ')[0];
  assert.match(section, /\(STATUS\.md\)/);
  assert.match(section, /shape of the form/);
  assert.match(section, /aidr doctor --brokers/);
  assert.match(section, /`blocked`/);
});

test('the health file the badges read exists and parses', () => {
  const file = path.join(__dirname, '..', 'data', 'broker-health.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof parsed.summary.ok, 'number');
  assert.equal(typeof parsed.summary.total, 'number');
});

test('the committed health file agrees with brokers.js and with its own summary (H6): the badges, STATUS.md and the file tell one story', () => {
  const file = path.join(__dirname, '..', 'data', 'broker-health.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { explicitBrokers, summarize } = require('../lib/broker-health');
  const names = explicitBrokers(require('../brokers')).map((b) => b.name);
  const extra = Object.keys(parsed.results).filter((n) => !names.includes(n));
  assert.deepEqual(extra, [], 'results for brokers that are not in brokers.js: prune them and regenerate STATUS.md');
  assert.deepEqual(parsed.summary, summarize(parsed.results));
});
