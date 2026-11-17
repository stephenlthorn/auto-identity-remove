/**
 * test/brokers-caldrop.test.js
 *
 * The one manual entry for California's DROP (Delete Request and Opt-out Platform)
 * in brokers.js. It used to be two entries, one of them marked "not yet live" and
 * both pointing at the registry landing page; DROP has been open to consumers since
 * 2026-01-01.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// brokers.js reads config.json at load time; use the config.example.json values.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './config.json' || request === '../config.json') return require('../config.example.json');
  return origLoad.apply(this, arguments);
};
const brokers = require('../brokers');
Module._load = origLoad;

const { DROP_URL } = require('../lib/drop');

const dropEntries = () => brokers.filter(b => /DROP|DELETE Portal/i.test(b.name));

test('there is exactly one DROP entry, named CalPrivacy DROP', () => {
  assert.deepEqual(dropEntries().map(b => b.name), ['CalPrivacy DROP']);
  assert.equal(brokers.find(b => b.name === 'California DELETE Portal'), undefined);
});

test('CalPrivacy DROP is a manual entry that opens the consumer page', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.method, 'manual');
  assert.equal(entry.optOutUrl, 'https://consumer.drop.privacy.ca.gov');
  assert.equal(entry.optOutUrl, DROP_URL);
  assert.equal(entry.priority, 1);
});

test('CalPrivacy DROP says what it is, without claiming it is not live or that 4000 brokers exist', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.confidence, undefined, 'documented_not_live is gone');
  assert.match(entry.notes, /California/);
  assert.match(entry.notes, /2026-08-01/);
  assert.doesNotMatch(entry.notes, /4000/);
  assert.doesNotMatch(entry.notes, /not (yet )?live/i);
});

test('CalPrivacy DROP is marked for California residents only', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.californiaOnly, true);
});
