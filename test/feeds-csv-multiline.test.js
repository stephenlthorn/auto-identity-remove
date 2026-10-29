// test/feeds-csv-multiline.test.js
/**
 * Registry CSV exports put multi-line text (addresses, descriptions) inside
 * quoted cells. parseCsv used to split the text on newlines BEFORE parsing
 * quotes, so the second line of such a cell became its own "row" and a bogus
 * broker. It now parses records with a quote-aware state machine.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv, normalizeFeedRow } = require('../lib/feeds');

test('a quoted cell with an embedded newline stays one record', () => {
  const csv = [
    'Data Broker Name,Website URL,Description',
    'Acme Data,https://acme.example/opt-out,"Collects public records.',
    'Resells them to marketers"',
    'Beta People,https://beta.example/privacy,Simple',
  ].join('\n');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['data broker name'], 'Acme Data');
  assert.equal(rows[0].description, 'Collects public records.\nResells them to marketers');
  assert.equal(rows[1]['data broker name'], 'Beta People');
});

test('continuation lines of a multi-line cell never become brokers', () => {
  const csv = [
    'Data Broker Name,Website URL,Address',
    '"Acme Data","https://acme.example","1 Main St',
    'Suite 5',
    'Springfield"',
  ].join('\r\n');

  const brokers = parseCsv(csv).map(r => normalizeFeedRow(r, 'ca')).filter(Boolean);
  assert.deepEqual(brokers.map(b => b.name), ['Acme Data']);
});

test('CRLF inside a quoted cell is preserved, CRLF between records still separates them', () => {
  const csv = 'Name,Website\r\n"Acme\r\nData",acme.example\r\nBeta,beta.example\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Acme\r\nData');
  assert.equal(rows[1].name, 'Beta');
});

test('doubled quotes and commas inside a multi-line quoted cell are handled together', () => {
  const csv = 'Name,Notes\n"Acme, Inc.","said ""hi"",\nthen left"\nBeta,ok\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Acme, Inc.');
  assert.equal(rows[0].notes, 'said "hi",\nthen left');
});

test('a leading byte-order mark does not corrupt the first header', () => {
  const rows = parseCsv('﻿Name,Website\nAcme,acme.example\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Acme');
});

test('blank lines between records are skipped, but a blank line inside a quoted cell is kept', () => {
  const csv = 'Name,Notes\n\nAcme,"line one\n\nline three"\n\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notes, 'line one\n\nline three');
});

test('a lone CR (old Mac line ending) separates records', () => {
  const rows = parseCsv('Name,Website\rAcme,acme.example\rBeta,beta.example');
  assert.deepEqual(rows.map(r => r.name), ['Acme', 'Beta']);
});

test('an unterminated quote consumes to the end instead of throwing', () => {
  const rows = parseCsv('Name,Notes\nAcme,"never closed\nstill the same cell');
  assert.equal(rows.length, 1);
  assert.match(rows[0].notes, /still the same cell/);
});
