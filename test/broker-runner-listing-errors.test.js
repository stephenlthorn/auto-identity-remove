/**
 * test/broker-runner-listing-errors.test.js
 *
 * BRK-9: `findListingUrl(...).catch(() => null)` turned a timeout, a DNS error
 * or a bot wall into "Not listed - nothing to remove". The user's data stays
 * online and the run reports a clean result. Any throw is an 'error', never
 * 'notFound', and the opt-out page is not visited.
 *
 * Contract (pkg B2): findListingUrl returns a URL, null when the search page
 * loaded fine and has no listing, and THROWS err.code === 'UNVERIFIABLE' when it
 * could not tell.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRunner, makePage, makeContext, PERSON } = require('./broker-runner-harness');

const SEARCH_BROKER = {
  name: 'SearchSite',
  method: 'search-form',
  searchUrl: 'https://search.example.com/Jane-Doe/Austin-TX',
  optOutUrl: 'https://search.example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: {},
};

function setup(findListingUrl) {
  const h = loadRunner({
    './forms': { fillForm: async () => {}, findListingUrl },
  });
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 1, capsolver: null });
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });
  return { ...h, page, run: () => h.runner.processBrokerWithPerson(makeContext(page), SEARCH_BROKER, PERSON) };
}

function unverifiable(message) {
  const err = new Error(message);
  err.code = 'UNVERIFIABLE';
  return err;
}

test('BRK-9: an UNVERIFIABLE lookup is an error, not "not listed"', async () => {
  const h = setup(async () => { throw unverifiable('HTTP 403 bot wall'); });
  await h.run();

  assert.deepEqual(h.logged.map(l => l.status), ['error']);
  assert.match(h.logged[0].detail, /could not check/i);
  assert.equal(h.page.gotos.length, 0, 'the opt-out page must not be visited');
  assert.equal(h.recorded.success.length, 0);
});

test('BRK-9: any thrown error, not just UNVERIFIABLE, is an error', async () => {
  const h = setup(async () => { throw new Error('page.goto: Timeout 20000ms exceeded'); });
  await h.run();

  assert.deepEqual(h.logged.map(l => l.status), ['error']);
  assert.ok(!h.logged.some(l => l.status === 'notFound'));
});

test('BRK-9: a null result (search loaded, no listing) is still notFound', async () => {
  const h = setup(async () => null);
  await h.run();

  assert.deepEqual(h.logged.map(l => l.status), ['notFound']);
});

test('BRK-9: a DNS failure counts toward unreachable; a bot wall does not', async () => {
  const dns = setup(async () => { throw unverifiable('net::ERR_NAME_NOT_RESOLVED'); });
  await dns.run();
  assert.deepEqual(dns.recorded.failure, [{ name: 'SearchSite', kind: 'error' }]);

  const wall = setup(async () => { throw unverifiable('bot wall detected'); });
  await wall.run();
  assert.deepEqual(wall.recorded.failure, [{ name: 'SearchSite', kind: 'form_error' }]);
});

test('BRK-9: error details never carry the search URL (it holds the name and city)', async () => {
  const h = setup(async () => {
    throw unverifiable('page.goto: net::ERR_CONNECTION_REFUSED at https://search.example.com/Jane-Doe/Austin-TX');
  });
  await h.run();

  const text = h.logged.map(l => l.detail).join(' ');
  assert.ok(!/Jane-Doe|Austin/.test(text), `PII in log detail: ${text}`);
  assert.match(text, /search\.example\.com/);
});

test('the listing line prints the host, not the person-specific path', async () => {
  const h = setup(async () => 'https://search.example.com/Jane-Doe/Austin-TX/p123');
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await h.run(); } finally { console.log = realLog; }

  const listing = lines.find(l => /Listing/.test(l));
  assert.ok(listing, 'a listing line is still printed');
  assert.ok(!/Jane-Doe|p123/.test(listing), `PII in listing line: ${listing}`);
});
