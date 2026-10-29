// test/hibp-inconclusive.test.js
/**
 * NET-12: a failed HIBP lookup (bad key, rate limit, network error) used to
 * end the report with "No high-severity identity breaches found. No credit
 * freeze needed", telling a user who has NOT been checked that they are fine.
 * A report with any failed lookup is INCONCLUSIVE and never prints the
 * all-clear. 429s honour Retry-After within a bound, and every request has a
 * timeout. Also: breach/broker domain matching understands co.uk-style
 * two-level suffixes.
 *
 * Every HTTP call goes through an injected fetchImpl; sleeping is injected.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkBreaches,
  runBreachCheck,
  formatBreachReport,
  crossReferenceBrokers,
  registrableDomain,
} = require('../lib/hibp');

const ALL_CLEAR = /No high-severity identity breaches found|No credit freeze needed/;

function response(status, { json, headers } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (headers || {})[String(name).toLowerCase()] ?? null },
    async json() { return json; },
  };
}

function sequence(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

// -- report wording -----------------------------------------------------------

test('NET-12: an errored lookup is INCONCLUSIVE and never prints the all-clear', () => {
  const report = formatBreachReport({
    perEmail: [{ email: 'a@example.com', breaches: [], error: 'HIBP: invalid API key (401)' }],
    brokerMatches: [],
    freeze: false,
  });
  assert.match(report, /INCONCLUSIVE/);
  assert.doesNotMatch(report, ALL_CLEAR);
  assert.match(report, /a@example\.com: error - HIBP: invalid API key \(401\)/);
});

test('NET-12: one clean email plus one failed email is still INCONCLUSIVE', () => {
  const report = formatBreachReport({
    perEmail: [
      { email: 'clean@example.com', breaches: [] },
      { email: 'limited@example.com', breaches: [], error: 'HIBP: rate limited (429)' },
    ],
    brokerMatches: [],
    freeze: false,
  });
  assert.match(report, /INCONCLUSIVE/);
  assert.match(report, /1 of 2/);
  assert.doesNotMatch(report, ALL_CLEAR);
});

test('NET-12: every lookup succeeding and finding nothing still gets the all-clear', () => {
  const report = formatBreachReport({
    perEmail: [{ email: 'clean@example.com', breaches: [] }],
    brokerMatches: [],
    freeze: false,
  });
  assert.match(report, /No high-severity identity breaches found/);
  assert.doesNotMatch(report, /INCONCLUSIVE/);
});

test('NET-12: a high-severity breach is still reported when another lookup failed', () => {
  const report = formatBreachReport({
    perEmail: [
      { email: 'a@example.com', breaches: [
        { name: 'Adobe', domain: 'adobe.com', breachDate: '', dataClasses: ['Passwords'], severity: 'high' },
      ] },
      { email: 'b@example.com', breaches: [], error: 'HIBP: rate limited (429)' },
    ],
    brokerMatches: [],
    freeze: true,
  });
  assert.match(report, /credit freeze/i);
  assert.match(report, /INCONCLUSIVE|incomplete/i);
});

test('NET-12: checking zero emails is not an all-clear either', () => {
  const report = formatBreachReport({ perEmail: [], brokerMatches: [], freeze: false });
  assert.match(report, /INCONCLUSIVE/);
  assert.doesNotMatch(report, ALL_CLEAR);
});

test('NET-12: runBreachCheck exposes inconclusive and errorCount', async () => {
  const fetchImpl = sequence(response(401), response(404));
  const result = await runBreachCheck({ emails: ['a@example.com', 'b@example.com'], apiKey: 'k', fetchImpl });
  assert.equal(result.inconclusive, true);
  assert.equal(result.errorCount, 1);

  const clean = await runBreachCheck({ emails: ['b@example.com'], apiKey: 'k', fetchImpl: sequence(response(404)) });
  assert.equal(clean.inconclusive, false);
  assert.equal(clean.errorCount, 0);
});

test('NET-12: a network error is recorded per email and makes the run inconclusive', async () => {
  const fetchImpl = sequence(new TypeError('fetch failed'));
  const result = await runBreachCheck({ emails: ['a@example.com'], apiKey: 'k', fetchImpl });
  assert.match(result.perEmail[0].error, /network error|fetch failed/i);
  assert.equal(result.inconclusive, true);
  assert.doesNotMatch(formatBreachReport(result), ALL_CLEAR);
});

// -- Retry-After --------------------------------------------------------------

test('NET-12: a 429 with Retry-After waits that long once and retries', async () => {
  const fetchImpl = sequence(
    response(429, { headers: { 'retry-after': '2' } }),
    response(200, { json: [{ Name: 'Adobe', Domain: 'adobe.com', DataClasses: ['Passwords'] }] })
  );
  const slept = [];
  const breaches = await checkBreaches('a@example.com', {
    apiKey: 'k', fetchImpl, sleepImpl: async (ms) => { slept.push(ms); },
  });
  assert.deepEqual(slept, [2000]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(breaches.length, 1);
});

test('NET-12: a Retry-After beyond the bound is not waited out', async () => {
  const fetchImpl = sequence(response(429, { headers: { 'retry-after': '3600' } }));
  const slept = [];
  await assert.rejects(
    () => checkBreaches('a@example.com', { apiKey: 'k', fetchImpl, sleepImpl: async (ms) => { slept.push(ms); } }),
    /rate limited \(429\)/
  );
  assert.deepEqual(slept, []);
  assert.equal(fetchImpl.calls.length, 1);
});

test('NET-12: a second 429 after the retry gives up instead of looping', async () => {
  const fetchImpl = sequence(response(429, { headers: { 'retry-after': '1' } }));
  const slept = [];
  await assert.rejects(
    () => checkBreaches('a@example.com', { apiKey: 'k', fetchImpl, sleepImpl: async (ms) => { slept.push(ms); } }),
    /rate limited \(429\)/
  );
  assert.equal(fetchImpl.calls.length, 2, 'one retry only');
  assert.deepEqual(slept, [1000]);
});

test('NET-12: a 429 with no Retry-After header throws without retrying', async () => {
  const fetchImpl = sequence(response(429));
  await assert.rejects(
    () => checkBreaches('a@example.com', { apiKey: 'k', fetchImpl, sleepImpl: async () => {} }),
    /rate limited \(429\)/
  );
  assert.equal(fetchImpl.calls.length, 1);
});

// -- timeout ------------------------------------------------------------------

test('NET-12: a request that never answers times out and aborts the fetch', async () => {
  let aborted = false;
  const fetchImpl = (url, init) => new Promise(() => {
    if (init && init.signal) init.signal.addEventListener('abort', () => { aborted = true; });
  });
  await assert.rejects(
    () => checkBreaches('a@example.com', { apiKey: 'k', fetchImpl, timeoutMs: 25 }),
    /timed out/i
  );
  assert.equal(aborted, true);
});

// -- registrable domain (co.uk) -------------------------------------------------

test('registrableDomain understands common two-level public suffixes', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('a.b.spokeo.com'), 'spokeo.com');
  assert.equal(registrableDomain('www.spokeo.com'), 'spokeo.com');
  assert.equal(registrableDomain('spokeo.com'), 'spokeo.com');
  assert.equal(registrableDomain('co.uk'), 'co.uk');
  assert.equal(registrableDomain(''), '');
});

test('NET-12: two different .co.uk sites no longer match each other', () => {
  const matches = crossReferenceBrokers(
    [{ name: 'Leak', domain: 'victim.co.uk' }],
    [{ name: 'Broker', optOutUrl: 'https://www.unrelated.co.uk/optout' }]
  );
  assert.deepEqual(matches, []);
});

test('NET-12: the same .co.uk site still matches across subdomains', () => {
  const matches = crossReferenceBrokers(
    [{ name: 'Leak', domain: 'www.samebroker.co.uk' }],
    [{ name: 'Broker', optOutUrl: 'https://optout.samebroker.co.uk/' }]
  );
  assert.equal(matches.length, 1);
});
