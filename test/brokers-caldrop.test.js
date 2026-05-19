/**
 * test/brokers-caldrop.test.js
 *
 * Verifies the CalPrivacy DROP manual broker entry exists in brokers.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// brokers.js reads config.json at load time; use the config.example.json values
// by monkeypatching require before importing.
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './config.json' || request === '../config.json') {
    return require('../config.example.json');
  }
  return origLoad.apply(this, arguments);
};

const brokers = require('../brokers');

Module._load = origLoad;

test('brokers.js exports a CalPrivacy DROP entry', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.ok(entry, 'CalPrivacy DROP entry must exist in brokers.js');
});

test('CalPrivacy DROP has method manual', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.method, 'manual', 'CalPrivacy DROP must have method: manual');
});

test('CalPrivacy DROP has correct optOutUrl', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.optOutUrl, 'https://cppa.ca.gov/data_broker_registry/');
});

test('CalPrivacy DROP has notes explaining CA coverage', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.ok(entry.notes, 'CalPrivacy DROP must have notes');
  assert.ok(entry.notes.length > 10, 'notes must be non-trivial');
});

test('CalPrivacy DROP has priority 1', () => {
  const entry = brokers.find(b => b.name === 'CalPrivacy DROP');
  assert.equal(entry.priority, 1);
});
