/**
 * test/hibp.test.js
 *
 * Hermetic unit tests for lib/hibp.js (Have I Been Pwned breach integration).
 * No live network: every HTTP call goes through an injected fetchImpl stub.
 * No real config/state writes.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  runBreachCheck,
  formatBreachReport,
} = require('../lib/hibp');

// ─── Fake fetch factory ──────────────────────────────────────────────────────
// Returns a fetchImpl that records calls and yields a queued Response-like
// object. Each entry is { status, json } where json is the parsed body.
function makeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      async json() {
        if (next.json === undefined) throw new Error('no json body');
        return next.json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

// ─── severityOf ──────────────────────────────────────────────────────────────

test('severityOf returns high when SSN present', () => {
  assert.equal(severityOf(['Email addresses', 'SSN']), 'high');
});

test('severityOf returns high for "Social security numbers" label', () => {
  assert.equal(severityOf(['Social security numbers']), 'high');
});

test('severityOf returns high when Passwords present', () => {
  assert.equal(severityOf(['Email addresses', 'Passwords']), 'high');
});

test('severityOf returns high when Physical addresses present', () => {
  assert.equal(severityOf(['Names', 'Physical addresses']), 'high');
});

test('severityOf is case-insensitive for high triggers', () => {
  assert.equal(severityOf(['passwords']), 'high');
  assert.equal(severityOf(['social security numbers']), 'high');
});

test('severityOf returns medium for phone numbers / dates of birth', () => {
  assert.equal(severityOf(['Email addresses', 'Phone numbers']), 'medium');
  assert.equal(severityOf(['Dates of birth']), 'medium');
});

test('severityOf returns low for email-only / usernames', () => {
  assert.equal(severityOf(['Email addresses']), 'low');
  assert.equal(severityOf(['Usernames']), 'low');
});

test('severityOf returns low for empty / missing dataClasses', () => {
  assert.equal(severityOf([]), 'low');
  assert.equal(severityOf(undefined), 'low');
  assert.equal(severityOf(null), 'low');
});

// ─── checkBreaches ───────────────────────────────────────────────────────────

const HIBP_200_BODY = [
  {
    Name: 'Adobe',
    Title: 'Adobe',
    Domain: 'adobe.com',
    BreachDate: '2013-10-04',
    DataClasses: ['Email addresses', 'Passwords', 'Usernames'],
  },
  {
    Name: 'Acme',
    Title: 'Acme Marketing',
    Domain: 'acme.example',
    BreachDate: '2019-01-01',
    DataClasses: ['Email addresses', 'Phone numbers'],
  },
];

test('checkBreaches maps a 200 response to result shape with severity', async () => {
  const fetchImpl = makeFetch({ status: 200, json: HIBP_200_BODY });
  const result = await checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    name: 'Adobe',
    domain: 'adobe.com',
    breachDate: '2013-10-04',
    dataClasses: ['Email addresses', 'Passwords', 'Usernames'],
    severity: 'high',
  });
  assert.equal(result[1].severity, 'medium');
});

test('checkBreaches sends hibp-api-key header, User-Agent, and truncateResponse=false', async () => {
  const fetchImpl = makeFetch({ status: 200, json: [] });
  await checkBreaches('jane@example.com', { apiKey: 'secret-key', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.ok(url.startsWith('https://haveibeenpwned.com/api/v3/breachedaccount/'));
  assert.ok(url.includes('truncateResponse=false'));
  assert.ok(url.includes(encodeURIComponent('jane@example.com')));
  assert.equal(init.headers['hibp-api-key'], 'secret-key');
  assert.equal(init.headers['User-Agent'], 'auto-identity-remove');
});

test('checkBreaches returns [] on 404 (no breaches found)', async () => {
  const fetchImpl = makeFetch({ status: 404 });
  const result = await checkBreaches('clean@example.com', { apiKey: 'k', fetchImpl });
  assert.deepEqual(result, []);
});

test('checkBreaches throws on 401 (bad key)', async () => {
  const fetchImpl = makeFetch({ status: 401 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'bad', fetchImpl }),
    /invalid API key \(401\)/
  );
});

test('checkBreaches throws on 429 (rate limited)', async () => {
  const fetchImpl = makeFetch({ status: 429 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl }),
    /rate limited \(429\)/
  );
});

test('checkBreaches throws on unexpected status', async () => {
  const fetchImpl = makeFetch({ status: 503 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl }),
    /unexpected status 503/
  );
});

test('checkBreaches throws when apiKey missing', async () => {
  const fetchImpl = makeFetch({ status: 200, json: [] });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { fetchImpl }),
    /missing API key/
  );
  assert.equal(fetchImpl.calls.length, 0, 'must not call fetch without a key');
});

// ─── crossReferenceBrokers / recommendFreeze / breachCount ───────────────────

const SAMPLE_BROKERS = [
  { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' },
  { name: 'Radaris', searchUrl: 'https://radaris.com/search' },
  { name: 'NoUrlBroker' },
];

test('crossReferenceBrokers matches a breach domain to a broker by registrable domain', () => {
  const breaches = [
    { name: 'SpokeoLeak', domain: 'people.spokeo.com', severity: 'high' },
    { name: 'Unrelated', domain: 'example.org', severity: 'low' },
  ];
  const matches = crossReferenceBrokers(breaches, SAMPLE_BROKERS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].breach.name, 'SpokeoLeak');
  assert.equal(matches[0].broker.name, 'Spokeo');
});

test('crossReferenceBrokers returns [] when no domains overlap', () => {
  const breaches = [{ name: 'X', domain: 'nowhere.test', severity: 'low' }];
  assert.deepEqual(crossReferenceBrokers(breaches, SAMPLE_BROKERS), []);
});

test('crossReferenceBrokers tolerates breaches/brokers without domains/urls', () => {
  const breaches = [{ name: 'NoDomain', domain: '', severity: 'low' }];
  assert.deepEqual(crossReferenceBrokers(breaches, SAMPLE_BROKERS), []);
  assert.deepEqual(crossReferenceBrokers(null, SAMPLE_BROKERS), []);
  assert.deepEqual(crossReferenceBrokers(breaches, null), []);
});

test('recommendFreeze true when any breach is high severity', () => {
  assert.equal(recommendFreeze([{ severity: 'low' }, { severity: 'high' }]), true);
});

test('recommendFreeze false when no high-severity breach', () => {
  assert.equal(recommendFreeze([{ severity: 'low' }, { severity: 'medium' }]), false);
  assert.equal(recommendFreeze([]), false);
  assert.equal(recommendFreeze(null), false);
});

test('breachCount returns array length, 0 for non-arrays', () => {
  assert.equal(breachCount([{}, {}, {}]), 3);
  assert.equal(breachCount([]), 0);
  assert.equal(breachCount(undefined), 0);
});
