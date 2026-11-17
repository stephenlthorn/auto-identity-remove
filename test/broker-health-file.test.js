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

  // The property: the list the check loads is built for the placeholder person and nobody else, so
  // every URL carries either the placeholder's values or nothing. Proven two ways: the list is
  // built with exactly PLACEHOLDER_PERSON, and a different (sentinel) person's values never reach
  // a URL that is built from the placeholder.
  const SENTINEL_PERSON = Object.freeze({
    firstName: 'Zqfirst', lastName: 'Zqlast', fullName: 'Zqfirst Zqlast', email: 'zq.sentinel@zq.invalid', phone: '9990001111',
    country: 'US', city: 'Zqcity', state: 'ZQ', zip: '99999',
  });
  const personValues = (person) => Object.values(person).map((v) => encodeURIComponent(v));

  test('the check builds the list for the placeholder person and no other', () => {
    let asked = null;
    explicitBrokers({ forPerson: (person) => { asked = person; return []; } });
    assert.deepEqual(asked, PLACEHOLDER_PERSON);
  });

  test('no broker URL to load carries a value that is not the placeholder', () => {
    const forPlaceholder = brokers.forPerson(PLACEHOLDER_PERSON);
    const forSentinel = brokers.forPerson(SENTINEL_PERSON);
    assert.equal(forPlaceholder.length, forSentinel.length);
    let personDependent = 0;
    forPlaceholder.forEach((b, i) => {
      const url = String(b.optOutUrl || '');
      assert.doesNotMatch(url, /undefined|null|NaN|\[object|\$\{/, `${b.name}: an unfilled template reached the URL`);
      for (const v of personValues(SENTINEL_PERSON)) assert.equal(url.includes(v), false, `${b.name} leaked ${v}`);
      const sentinelUrl = String(forSentinel[i].optOutUrl || '');
      if (sentinelUrl !== url) {
        personDependent += 1;
        // The only difference between the two URLs is the person's values: swap the sentinel's for the placeholder's and they match.
        let back = sentinelUrl;
        for (const key of Object.keys(PLACEHOLDER_PERSON)) back = back.split(encodeURIComponent(SENTINEL_PERSON[key])).join(encodeURIComponent(PLACEHOLDER_PERSON[key]));
        assert.equal(back, url, `${b.name}: the URL depends on something other than the person's fields`);
      }
    });
    assert.ok(personDependent > 0, 'at least one broker URL embeds the person, or this test proves nothing');
  });

  test('the broker list the check loads has no search URL to visit: only optOutUrl is ever used', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'broker-health.js'), 'utf8');
    assert.doesNotMatch(source.replace(/\/\*[^]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /searchUrl/);
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
    const previous = { runner: 'local', results: { A: { status: 'drifted' }, B: { status: 'drifted' } } };
    const file = buildHealthFile({ checked, previous, runner: 'local', checkedAt: at });
    assert.equal(file.results.A.previousStatus, 'drifted');
    assert.equal(file.results.B.previousStatus, 'drifted');
    assert.equal(file.results.C.previousStatus, null);
  });

  test('a file from a different kind of runner is no history: two checks from the SAME kind of runner are needed (H4d)', () => {
    // The committed file is `runner: local`. The first CI run must not inherit
    // "drifted" from it and open an issue at once.
    const previous = { runner: 'local', results: { A: { status: 'drifted' }, B: { status: 'ok' } } };
    const ci = buildHealthFile({ checked, previous, runner: 'ci', checkedAt: at });
    assert.equal(ci.results.A.previousStatus, null);
    assert.equal(ci.results.B.previousStatus, null);
    const second = buildHealthFile({ checked, previous: ci, runner: 'ci', checkedAt: at });
    assert.equal(second.results.B.previousStatus, 'drifted', 'the second CI run has the first CI run to compare with');
  });

  test('a previous file with no runner recorded is no history either', () => {
    const file = buildHealthFile({ checked, previous: { results: { A: { status: 'drifted' } } }, runner: 'ci', checkedAt: at });
    assert.equal(file.results.A.previousStatus, null);
  });

  test('only drifted entries carry the missing selectors', () => {
    const file = buildHealthFile({ checked, runner: 'ci', checkedAt: at });
    assert.deepEqual(file.results.B.missing, ['x']);
    assert.equal('missing' in file.results.A, false);
  });

  test('a redirect is recorded with where it went, and only then', () => {
    const file = buildHealthFile({
      checked: [{ name: 'R', status: 'drifted', detail: 'redirected to parked.example.net', redirectedTo: 'parked.example.net', checkedAt: at }, checked[0]],
      runner: 'ci', checkedAt: at,
    });
    assert.equal(file.results.R.redirectedTo, 'parked.example.net');
    assert.equal('redirectedTo' in file.results.A, false);
  });

  test('results for names that are not in the broker list are dropped, and the summary counts only what is kept (H6)', () => {
    const file = buildHealthFile({ checked, runner: 'ci', checkedAt: at, known: ['A', 'B', 'F'] });
    assert.deepEqual(Object.keys(file.results), ['A', 'B', 'F']);
    assert.deepEqual(file.summary, { ok: 1, drifted: 1, blocked: 0, dead: 0, error: 0, na: 1, total: 2 });
  });

  test('without a known list nothing is dropped (callers that check a custom list)', () => {
    assert.equal(Object.keys(buildHealthFile({ checked, runner: 'ci', checkedAt: at }).results).length, 6);
  });

  test('a garbled previous file is treated as no history', () => {
    const file = buildHealthFile({ checked, previous: { results: 'nope' }, runner: 'ci', checkedAt: at });
    assert.equal(file.results.A.previousStatus, null);
  });

  test('summarize ignores unknown labels', () => {
    assert.equal(summarize({ A: { status: 'weird' } }).total, 0);
  });
});
