/**
 * test/url-guard.test.js
 *
 * BRK2-12 / codex #3: one shared address-range table, DNS failures that fail
 * closed, and a re-check of every navigation instead of a per-origin verdict that
 * Chrome's own resolver can contradict (DNS rebinding).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/url-guard');
const gr = require('../generic-runner');
const imap = require('../lib/imap-confirm');
const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

const PUBLIC = '93.184.216.34';

const table = (map) => async (host) => {
  if (!Object.prototype.hasOwnProperty.call(map, host)) {
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

// ── the shared range table ────────────────────────────────────────────────────

test('the table blocks what the generic runner used to let through (192.0.0.192, 198.18/15, Teredo, SIIT, local NAT64)', () => {
  for (const ip of [
    '192.0.0.192', '192.0.0.1', '198.18.0.1', '198.19.255.255', '100.100.100.200', 'fd00:ec2::254',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b:1::7f00:1', '::ffff:0:7f00:1', '64:ff9b::a9fe:a9fe',
  ]) {
    assert.equal(guard.isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('the table still lets ordinary public space through, edges included', () => {
  for (const ip of ['192.0.1.1', '192.0.2.1', '198.17.255.255', '198.20.0.1', '203.0.113.7', PUBLIC, '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(guard.isBlockedAddress(ip), false, `${ip} is public`);
  }
});

test('anything that is not an IP address is refused', () => {
  for (const junk of ['', undefined, 'not-an-ip', '999.1.1.1']) assert.equal(guard.isBlockedAddress(junk), true);
});

test('generic-runner and imap-confirm answer from the same table', () => {
  for (const ip of ['192.0.0.192', '198.18.0.1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '10.0.0.1', PUBLIC]) {
    assert.equal(gr.isDisallowedAddress(ip), guard.isBlockedAddress(ip), `generic ${ip}`);
    assert.equal(imap.isPrivateHost(ip), guard.isBlockedAddress(ip), `imap ${ip}`);
  }
});

// ── fail closed ───────────────────────────────────────────────────────────────

test('a lookup that resolves to 192.0.0.192 is refused', async () => {
  const r = await gr.checkBrokerUrl('https://oracle.broker.example.net/optout', { lookup: table({ 'oracle.broker.example.net': ['192.0.0.192'] }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /192\.0\.0\.192/);
});

test('a DNS error that is not "no such host" is a refusal, not a pass', async () => {
  const lookup = async () => { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; };
  const r = await guard.checkUrl('https://broker.example.net/optout', { lookup });
  assert.equal(r.ok, false);
  assert.notEqual(r.unresolvable, true, 'a timeout does not prove the host is gone');
});

test('"no such host" is a refusal marked unresolvable (the broker is gone, nothing is sent)', async () => {
  const r = await guard.checkUrl('https://gone.broker.example.net/optout', { lookup: table({}) });
  assert.equal(r.ok, false);
  assert.equal(r.unresolvable, true);
});

test('a lookup that never answers is cut off and refused', async () => {
  const lookup = () => new Promise(() => {});
  const r = await guard.checkUrl('https://slow.broker.example.net/', { lookup, timeoutMs: 40 });
  assert.equal(r.ok, false);
});

test('a lookup that returns no addresses is refused', async () => {
  const r = await guard.checkUrl('https://empty.broker.example.net/', { lookup: async () => [] });
  assert.equal(r.ok, false);
});

test('single-label host names are refused without a lookup', async () => {
  let asked = 0;
  const lookup = async () => { asked++; return [{ address: PUBLIC, family: 4 }]; };
  for (const url of ['http://intranet/', 'http://printer/optout', 'https://nas/']) {
    const r = await guard.checkUrl(url, { lookup });
    assert.equal(r.ok, false, url);
  }
  assert.equal(asked, 0);
});

test('generic checkBrokerUrl no longer lets an unresolvable host through', async () => {
  const r = await gr.checkBrokerUrl('https://gone.broker.example.net/optout', { lookup: table({}) });
  assert.equal(r.ok, false);
});

// ── every navigation is re-checked ────────────────────────────────────────────

function fakeRoutePage() {
  const page = { handler: null, listeners: {} };
  page.route = async (pattern, handler) => { page.pattern = pattern; page.handler = handler; };
  page.on = (event, fn) => { page.listeners[event] = fn; };
  page.navigate = async (url, { navigation = true } = {}) => {
    const outcome = { aborted: null, continued: false };
    const request = { url: () => url, isNavigationRequest: () => navigation };
    await page.handler({
      request: () => request,
      abort: async (reason) => { outcome.aborted = reason; },
      continue: async () => { outcome.continued = true; },
    });
    return outcome;
  };
  return page;
}

test('a host judged public on one request is judged again on the next (no cached verdict)', async () => {
  const answers = [[PUBLIC], ['10.0.0.5']];
  let calls = 0;
  const lookup = async () => (answers[Math.min(calls++, 1)]).map((address) => ({ address, family: 4 }));
  const page = fakeRoutePage();
  const g = await guard.installNavigationGuard(page, { check: (url) => guard.checkUrl(url, { lookup }) });

  const first = await page.navigate('https://rebind.broker.example.net/optout');
  assert.equal(first.continued, true);
  const second = await page.navigate('https://rebind.broker.example.net/optout/step2');
  assert.equal(second.aborted, 'blockedbyclient', 'the second navigation re-resolves and sees the private address');
  assert.equal(calls, 2, 'one lookup per navigation');
  assert.equal(g.blocked.length, 1);
  assert.match(g.blocked[0].reason, /10\.0\.0\.5/);
});

test('only navigations are intercepted: a script or image request is let through without a lookup', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return [{ address: '10.0.0.5', family: 4 }]; };
  const page = fakeRoutePage();
  await guard.installNavigationGuard(page, { check: (url) => guard.checkUrl(url, { lookup }) });
  const out = await page.navigate('https://cdn.broker.example.net/app.js', { navigation: false });
  assert.equal(out.continued, true);
  assert.equal(calls, 0);
});

test('a page that cannot intercept (a stub) gets no guard instead of a crash', async () => {
  assert.equal(await guard.installNavigationGuard({}, { check: async () => ({ ok: true }) }), null);
});

test('the address the browser connected to is checked too (Node saw a public one)', async () => {
  const page = fakeRoutePage();
  const g = await guard.installNavigationGuard(page, { check: async () => ({ ok: true }) });
  const response = {
    request: () => ({ isNavigationRequest: () => true }),
    url: () => 'https://rebind.broker.example.net/optout?name=Jane+Doe',
    serverAddr: async () => ({ ipAddress: '127.0.0.1', port: 443 }),
  };
  page.listeners.response(response);
  await g.settle();
  assert.equal(g.blocked.length, 1);
  assert.match(g.blocked[0].reason, /127\.0\.0\.1/);
  assert.ok(!g.blocked[0].url.includes('Jane'), 'the query (a name) never lands in the record');
});

// ── generic runner: formaction and rebinding ──────────────────────────────────

const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'test@example.com', state: 'CA', zip: '90001' };
const publicLookup = table({ 'broker.example.net': [PUBLIC] });
const run = (page, broker, opts = {}) =>
  gr.processGenericUrl(page, broker, { optOuts: {} }, false, new Set(), { person: PERSON, dnsLookup: publicLookup, ...opts });
const BROKER = { name: 'Broker Example', url: 'https://broker.example.net/opt-out', source: 'ca' };

test('BRK2-12: a submit button whose formaction points at an internal address is never filled or clicked', async () => {
  const page = makeFakePage({
    url: BROKER.url,
    forms: [optOutForm({ desc: { action: 'https://broker.example.net/ok', formActions: ['http://169.254.169.254/latest/meta-data/'] } })],
  });
  const result = await run(page, BROKER);
  assert.deepEqual(page.filled, [], 'no PII typed');
  assert.deepEqual(page.clicked, [], 'nothing clicked');
  assert.notEqual(result.status, 'success');
});

test('BRK2-12: a formaction on a public host is fine', async () => {
  const page = makeFakePage({
    url: BROKER.url,
    forms: [optOutForm({ desc: { action: 'https://broker.example.net/ok', formActions: ['https://broker.example.net/other'] }, afterSubmit: { body: 'Your opt-out request has been received.' } })],
  });
  const result = await run(page, BROKER);
  assert.equal(result.status, 'success');
});

test('BRK2-12: a navigation the guard refused ends the broker as blocked, before anything is typed', async () => {
  const page = makeFakePage({ url: BROKER.url, forms: [optOutForm()] });
  const g = fakeRoutePage();
  page.route = g.route;
  page.on = g.on;
  const realGoto = page.goto;
  page.goto = async (url) => {
    const out = await g.navigate(url);
    if (out.aborted) throw new Error(`page.goto: net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    return realGoto(url);
  };
  // The guard asks the injected lookup; the first answer (pre-navigation check) is public, the route sees a private one.
  const answers = [[PUBLIC], ['10.1.2.3']];
  let calls = 0;
  const lookup = async () => (answers[Math.min(calls++, 1)]).map((address) => ({ address, family: 4 }));
  const result = await run(page, BROKER, { dnsLookup: lookup });
  assert.equal(result.status, 'error');
  assert.match(result.detail, /blocked/i);
  assert.match(result.detail, /10\.1\.2\.3/);
  assert.deepEqual(page.filled, []);
});

test('a DNS timeout fails the row closed as an error; "no such host" is dead; neither navigates', async () => {
  const slow = async () => { const e = new Error('t'); e.code = 'ETIMEOUT'; throw e; };
  const page1 = makeFakePage({ url: BROKER.url, forms: [optOutForm()] });
  const r1 = await run(page1, BROKER, { dnsLookup: slow });
  assert.equal(r1.status, 'error');
  assert.match(r1.detail, /blocked/i);
  assert.deepEqual(page1.gotos, []);

  const page2 = makeFakePage({ url: BROKER.url, forms: [optOutForm()] });
  const r2 = await run(page2, BROKER, { dnsLookup: table({}) });
  assert.equal(r2.status, 'dead');
  assert.match(r2.detail, /ERR_NAME_NOT_RESOLVED/);
  assert.deepEqual(page2.gotos, []);
});
