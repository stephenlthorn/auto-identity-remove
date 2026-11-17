'use strict';
/**
 * test/broker-health-file.test.js
 *
 * The whole-list run and the data/broker-health.json document it produces,
 * using stub pages (no browser). The real-page behaviour is in
 * broker-health-check.test.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const brokers = require('../brokers');
const {
  checkAllBrokers, buildHealthFile, summarize, explicitBrokers, expectedSelectors, PLACEHOLDER_PERSON,
} = require('../lib/broker-health');

const stubPage = (script = {}) => ({
  closed: false,
  async goto(url) {
    if (script.throws) throw new Error(script.throws);
    this.url = url;
    return { status: () => script.status || 200, headers: () => ({}) };
  },
  async evaluate() { return script.probe === undefined ? null : script.probe; },
  async waitForTimeout() {},
  async close() { this.closed = true; },
});

describe('checkAllBrokers', () => {
  test('one fresh page per broker, closed afterwards, one load each', async () => {
    const pages = [];
    const list = [
      { name: 'A', method: 'manual', optOutUrl: 'https://a.example/x' },
      { name: 'B', method: 'manual', optOutUrl: 'https://b.example/x' },
    ];
    const out = await checkAllBrokers({
      brokers: list,
      newPage: async () => { const p = stubPage(); pages.push(p); return p; },
      now: () => Date.parse('2026-11-17T06:00:00Z'),
    });
    assert.equal(pages.length, 2);
    assert.ok(pages.every((p) => p.closed));
    assert.deepEqual(out.map((e) => e.name), ['A', 'B']);
    assert.equal(out[0].checkedAt, '2026-11-17T06:00:00.000Z');
  });

  test('a failing check for one broker becomes an error entry and the run goes on', async () => {
    const out = await checkAllBrokers({
      brokers: [
        { name: 'A', method: 'manual', optOutUrl: 'https://a.example/x' },
        { name: 'B', method: 'manual', optOutUrl: 'https://b.example/x' },
      ],
      newPage: async () => { throw new Error('browser crashed'); },
    });
    assert.deepEqual(out.map((e) => e.status), ['error', 'error']);
  });

  test('email brokers are n/a without opening a page', async () => {
    let opened = 0;
    const out = await checkAllBrokers({
      brokers: [{ name: 'M', method: 'email', emailTo: 'x@example.com' }],
      newPage: async () => { opened += 1; return stubPage(); },
    });
    assert.equal(out[0].status, 'n/a');
    assert.equal(opened, 0);
  });

  test('a navigation failure is classified, not thrown', async () => {
    const out = await checkAllBrokers({
      brokers: [{ name: 'A', method: 'manual', optOutUrl: 'https://a.example/x' }],
      newPage: async () => stubPage({ throws: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://a.example/x' }),
    });
    assert.equal(out[0].status, 'dead');
  });
});

describe('the placeholder person', () => {
  test('builds every explicit broker with its selectors, and no personal data', () => {
    const list = explicitBrokers(brokers);
    assert.ok(list.length >= 40);
    for (const b of list.filter((x) => x.method === 'direct-form')) {
      assert.ok(expectedSelectors(b).length > 0, `${b.name} has no selectors to check`);
    }
    assert.equal(PLACEHOLDER_PERSON.email.endsWith('@example.com'), true);
  });

  test('no broker URL to load contains anything but placeholder or no values', () => {
    for (const b of explicitBrokers(brokers)) {
      assert.doesNotMatch(String(b.optOutUrl || ''), /undefined/, b.name);
    }
  });
});

describe('expectedSelectors', () => {
  test('formFields keys plus the submit selector, once each; manual relies on none', () => {
    assert.deepEqual(
      expectedSelectors({ method: 'direct-form', formFields: { 'a': 1, 'b': 2 }, submitSelector: 'b' }),
      ['a', 'b'],
    );
    assert.deepEqual(expectedSelectors({ method: 'manual', formFields: { a: 1 }, submitSelector: 's' }), []);
  });
});

describe('summarize and buildHealthFile', () => {
  const at = '2026-11-17T06:00:00.000Z';
  const checked = [
    { name: 'A', status: 'ok', detail: 'fine', checkedAt: at },
    { name: 'B', status: 'drifted', detail: '1 of 2 selectors match nothing: x', missing: ['x'], checkedAt: at },
    { name: 'C', status: 'blocked', detail: 'bot wall', checkedAt: at },
    { name: 'D', status: 'dead', detail: 'HTTP 404', checkedAt: at },
    { name: 'E', status: 'error', detail: 'timed out', checkedAt: at },
    { name: 'F', status: 'n/a', detail: 'email', checkedAt: at },
  ];

  test('summary counts each label; total excludes n/a', () => {
    const file = buildHealthFile({ checked, runner: 'ci', checkedAt: at });
    assert.deepEqual(file.summary, { ok: 1, drifted: 1, blocked: 1, dead: 1, error: 1, na: 1, total: 5 });
    assert.equal(file.runner, 'ci');
    assert.equal(file.checkedAt, at);
  });

  test('previousStatus comes from the file as it was before the run', () => {
    const previous = { results: { A: { status: 'drifted' }, B: { status: 'drifted' } } };
    const file = buildHealthFile({ checked, previous, runner: 'local', checkedAt: at });
    assert.equal(file.results.A.previousStatus, 'drifted');
    assert.equal(file.results.B.previousStatus, 'drifted');
    assert.equal(file.results.C.previousStatus, null);
  });

  test('only drifted entries carry the missing selectors', () => {
    const file = buildHealthFile({ checked, runner: 'ci', checkedAt: at });
    assert.deepEqual(file.results.B.missing, ['x']);
    assert.equal('missing' in file.results.A, false);
  });

  test('a garbled previous file is treated as no history', () => {
    const file = buildHealthFile({ checked, previous: { results: 'nope' }, runner: 'ci', checkedAt: at });
    assert.equal(file.results.A.previousStatus, null);
  });

  test('summarize ignores unknown labels', () => {
    assert.equal(summarize({ A: { status: 'weird' } }).total, 0);
  });
});
