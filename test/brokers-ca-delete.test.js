/**
 * test/brokers-ca-delete.test.js
 *
 * Verifies the California DELETE Portal broker entry exists in brokers.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// brokers.js reads config.json at load time; use the config.example.json values
// by monkeypatching require before importing.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './config.json' || request === '../config.json') {
    return require('../config.example.json');
  }
  return origLoad.apply(this, arguments);
};

const brokers = require('../brokers');

Module._load = origLoad;

test('brokers.js exports a California DELETE Portal entry', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.ok(entry, 'California DELETE Portal entry must exist in brokers.js');
});

test('California DELETE Portal has priority 1', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(entry.priority, 1);
});

test('California DELETE Portal has method direct-form', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(entry.method, 'direct-form');
});

test('California DELETE Portal notes mention DELETE Act', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.ok(entry.notes, 'notes field must exist');
  assert.ok(entry.notes.includes('DELETE Act'), 'notes must mention DELETE Act');
});

test('California DELETE Portal has at least 5 formFields', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.ok(Array.isArray(entry.formFields), 'formFields must be an array');
  assert.ok(entry.formFields.length >= 5, `expected at least 5 formFields, got ${entry.formFields.length}`);
});

test('California DELETE Portal captchaLikely is false', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(entry.captchaLikely, false);
});
