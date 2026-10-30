/**
 * test/generic-url-guard.test.js
 *
 * codex #2: registry URLs can point anywhere. The generic runner navigated to
 * whatever `startsWith('http')` row it was given and typed the user's name,
 * email and address into the first form it found, so a hostile or merely broken
 * row (loopback, RFC1918, cloud metadata, a host that redirects to one) could
 * reach internal services or hand PII to the wrong party. Observed in the wild:
 * clustrmaps.com's DNS pointed at 127.0.0.1.
 *
 * Rules under test: only http(s); no localhost / *.local / *.internal; no IP
 * literals; no host that DNS-resolves (IPv4 or IPv6, including IPv4-mapped IPv6)
 * to loopback / private / link-local / CGNAT / multicast / unspecified space;
 * and the FINAL url after navigation is re-checked.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage, makeContext, optOutForm } = require('./helpers/generic-fake-page');

const PERSON = {
  firstName: 'Test', lastName: 'User', fullName: 'Test User',
  email: 'test@example.com', state: 'CA', zip: '90001',
};

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-guard-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A dns lookup stub: hostname -> addresses, anything else ENOTFOUND. */
function fakeLookup(table, calls = []) {
  return async (host, options) => {
    calls.push({ host, options });
    if (!Object.prototype.hasOwnProperty.call(table, host)) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return table[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

// ── address classification ───────────────────────────────────────────────────

test('isDisallowedAddress blocks loopback, private, link-local, CGNAT, multicast, unspecified (IPv4)', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(gr.isDisallowedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('isDisallowedAddress allows ordinary public IPv4, including the edges of the blocked ranges', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '169.253.1.1', '223.255.255.255']) {
    assert.equal(gr.isDisallowedAddress(ip), false, `${ip} is public`);
  }
});

test('isDisallowedAddress blocks loopback, unspecified, link-local, ULA and multicast IPv6', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', 'fec0::1']) {
    assert.equal(gr.isDisallowedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('isDisallowedAddress sees through IPv4-mapped, NAT64 and 6to4 IPv6', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:c0a8:1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:c0a8:101::1']) {
    assert.equal(gr.isDisallowedAddress(ip), true, `${ip} embeds a private IPv4 and must be blocked`);
  }
});

test('isDisallowedAddress allows public IPv6 and public IPv4-mapped IPv6', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:5db8:d822']) {
    assert.equal(gr.isDisallowedAddress(ip), false, `${ip} is public`);
  }
});

test('isDisallowedAddress refuses anything that is not an IP address', () => {
  assert.equal(gr.isDisallowedAddress('not-an-ip'), true);
  assert.equal(gr.isDisallowedAddress(''), true);
});

// ── URL checks (before navigation) ───────────────────────────────────────────

test('checkBrokerUrl rejects non-http(s) schemes', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://files.example.com/x', 'javascript:alert(1)', 'data:text/html,<form></form>', 'about:blank', 'chrome://settings', 'gopher://x.example.com']) {
    const r = await gr.checkBrokerUrl(url, { lookup: fakeLookup({}) });
    assert.equal(r.ok, false, `${url} must be rejected`);
    assert.match(r.reason, /scheme|unparseable/i);
  }
});

test('checkBrokerUrl rejects localhost, *.local, *.internal and friends without resolving them', async () => {
  const calls = [];
  for (const url of [
    'http://localhost/optout', 'http://localhost:8080/', 'https://LOCALHOST/', 'http://localhost./',
    'https://app.localhost/', 'https://printer.local/optout', 'https://db.internal/x',
    'https://nas.home.arpa/', 'https://router.lan/', 'https://wiki.intranet/',
  ]) {
    const r = await gr.checkBrokerUrl(url, { lookup: fakeLookup({ 'example.com': ['93.184.216.34'] }, calls) });
    assert.equal(r.ok, false, `${url} must be rejected`);
  }
  assert.deepEqual(calls, [], 'obviously-internal names are rejected without any DNS query');
});

test('checkBrokerUrl rejects IP literals (private or not), including obfuscated IPv4 forms', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.1.2.3/optout', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://0177.0.0.1/',
    'http://93.184.216.34/optout', 'https://[2606:4700:4700::1111]/',
  ]) {
    const r = await gr.checkBrokerUrl(url, { lookup: fakeLookup({}) });
    assert.equal(r.ok, false, `${url} must be rejected`);
  }
});

test('checkBrokerUrl rejects embedded credentials', async () => {
  const r = await gr.checkBrokerUrl('https://user:pass@broker.example.com/optout', { lookup: fakeLookup({ 'broker.example.com': ['93.184.216.34'] }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential/i);
});

test('checkBrokerUrl rejects a hostname that DNS-resolves to a private address, and asks for all addresses', async () => {
  const calls = [];
  const lookup = fakeLookup({
    'evil.example.com': ['127.0.0.1'],
    'rebind.example.com': ['93.184.216.34', '10.0.0.5'],
    'v6.example.com': ['::ffff:192.168.1.10'],
    'meta.example.com': ['169.254.169.254'],
    'cgnat.example.com': ['100.64.1.1'],
  }, calls);
  for (const host of ['evil', 'rebind', 'v6', 'meta', 'cgnat']) {
    const r = await gr.checkBrokerUrl(`https://${host}.example.com/optout`, { lookup });
    assert.equal(r.ok, false, `${host} must be rejected`);
    assert.match(r.reason, /resolves to/i);
  }
  assert.ok(calls.every(c => c.options && c.options.all === true), 'lookup must be called with { all: true } so one public A record cannot hide a private one');
});

test('checkBrokerUrl accepts a hostname that resolves only to public addresses', async () => {
  const r = await gr.checkBrokerUrl('https://www.broker.example.com/optout?x=1', {
    lookup: fakeLookup({ 'www.broker.example.com': ['93.184.216.34', '2606:4700:4700::1111'] }),
  });
  assert.deepEqual(r, { ok: true });
});

test('checkBrokerUrl refuses an unresolvable host (BRK2-12) and says it is gone, so the row is reported dead without a navigation', async () => {
  const r = await gr.checkBrokerUrl('https://gone.example.com/optout', { lookup: fakeLookup({}) });
  assert.equal(r.ok, false);
  assert.equal(r.unresolvable, true);
});

test('checkBrokerUrl rejects unparseable input', async () => {
  for (const url of ['', undefined, null, 'not a url', 'http://']) {
    const r = await gr.checkBrokerUrl(url, { lookup: fakeLookup({}) });
    assert.equal(r.ok, false, `${String(url)} must be rejected`);
  }
});

// ── processGenericUrl: before navigation ─────────────────────────────────────

const run = (page, broker, opts = {}) =>
  gr.processGenericUrl(page, broker, { optOuts: {} }, false, new Set(), { person: PERSON, ...opts });

test('a registry row that resolves to loopback is never navigated to and is reported as error', async () => {
  const page = makeFakePage({ forms: [optOutForm()] });
  const result = await run(page, { name: 'ClustrMaps-like', url: 'https://clustr.example.com/opt-out', source: 'ca' }, {
    dnsLookup: fakeLookup({ 'clustr.example.com': ['127.0.0.1'] }),
  });
  assert.deepEqual(page.gotos, [], 'must not navigate');
  assert.deepEqual(page.filled, [], 'must not type PII');
  assert.equal(result.status, 'error');
  assert.match(result.detail, /blocked/i);
  assert.match(result.detail, /127\.0\.0\.1/);
});

test('a file:// or localhost row is rejected the same way', async () => {
  for (const url of ['file:///etc/passwd', 'http://localhost:9200/', 'http://169.254.169.254/latest/meta-data/']) {
    const page = makeFakePage({ forms: [optOutForm()] });
    const result = await run(page, { name: 'Bad', url, source: 'ca' }, { dnsLookup: fakeLookup({}) });
    assert.deepEqual(page.gotos, [], `${url} must not be navigated`);
    assert.equal(result.status, 'error');
    assert.match(result.detail, /blocked/i);
  }
});

test('a public row still navigates and is processed', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
  });
  const result = await run(page, { name: 'Fine', url: 'https://fine.example.com/opt-out', source: 'markup' }, {
    dnsLookup: fakeLookup({ 'fine.example.com': ['93.184.216.34'] }),
  });
  assert.deepEqual(page.gotos, ['https://fine.example.com/opt-out']);
  assert.ok(page.filled.length > 0);
  assert.equal(result.status, 'success');
});

// ── processGenericUrl: after navigation ──────────────────────────────────────

test('a row that redirects to cloud metadata is aborted as error before anything is typed', async () => {
  const url = 'https://redirector.example.com/opt-out';
  const page = makeFakePage({
    forms: [optOutForm()],
    redirects: { [url]: 'http://169.254.169.254/latest/meta-data/' },
  });
  const result = await run(page, { name: 'Redirector', url, source: 'ca' }, {
    dnsLookup: fakeLookup({ 'redirector.example.com': ['93.184.216.34'] }),
  });
  assert.equal(result.status, 'error');
  assert.match(result.detail, /redirect/i);
  assert.deepEqual(page.filled, [], 'no PII may be typed into a page that ended on a disallowed address');
  assert.deepEqual(page.clicked, []);
});

test('a row that redirects to a host resolving to a private address is aborted too', async () => {
  const url = 'https://redirector.example.com/opt-out';
  const page = makeFakePage({
    forms: [optOutForm()],
    redirects: { [url]: 'https://intranet-app.example.com/login' },
  });
  const result = await run(page, { name: 'Redirector', url, source: 'ca' }, {
    dnsLookup: fakeLookup({ 'redirector.example.com': ['93.184.216.34'], 'intranet-app.example.com': ['10.0.0.9'] }),
  });
  assert.equal(result.status, 'error');
  assert.match(result.detail, /redirect/i);
  assert.deepEqual(page.filled, []);
});

test('a redirect to another PUBLIC host is allowed (brokers move domains)', async () => {
  const url = 'https://old.example.com/opt-out';
  const page = makeFakePage({
    forms: [optOutForm({ afterSubmit: { body: 'Your request has been received.' } })],
    redirects: { [url]: 'https://new.example.org/opt-out' },
  });
  const result = await run(page, { name: 'Mover', url, source: 'markup' }, {
    dnsLookup: fakeLookup({ 'old.example.com': ['93.184.216.34'], 'new.example.org': ['93.184.216.35'] }),
  });
  assert.equal(result.status, 'success');
});

// ── rejected rows are logged, not silently dropped ───────────────────────────

test('runGenericBrokers logs every rejected row with its reason', async () => {
  const logged = [];
  const page = makeFakePage({ forms: [optOutForm()] });
  await gr.runGenericBrokers(
    makeContext(page), new Set(), { optOuts: {} },
    (name, status, detail) => logged.push({ name, status, detail }),
    () => { throw new Error('a rejected row must never be recorded as a success'); },
    {
      injectedBrokers: [
        { name: 'Loopback Co', url: 'http://127.0.0.1/optout', source: 'ca' },
        { name: 'Internal Co', url: 'https://tools.internal/optout', source: 'vt' },
      ],
      injectedDeadSet: new Set(),
      dnsLookup: fakeLookup({}),
    },
  );
  assert.equal(logged.length, 2, 'both rows are logged');
  assert.ok(logged.every(l => l.status === 'error' && /blocked/i.test(l.detail)));
  assert.deepEqual(page.gotos, []);
});

// ── never post PII to a private address, whatever the page says ──────────────

test('a form whose action posts to a private address is not filled, even if it reads as an opt-out form', async () => {
  const page = makeFakePage({
    forms: [optOutForm({ desc: { action: 'http://10.0.0.5/collect' } })],
  });
  const result = await run(page, { name: 'Exfil', url: 'https://fine.example.com/opt-out', source: 'markup' }, {
    dnsLookup: fakeLookup({ 'fine.example.com': ['93.184.216.34'] }),
  });
  assert.deepEqual(page.filled, [], 'no PII may be typed into a form that posts to an internal address');
  assert.deepEqual(page.clicked, []);
  assert.equal(result.status, 'manual');
});

test('reserved documentation names are not sent to the default resolver (they never name a broker)', async () => {
  assert.deepEqual(await gr.checkBrokerUrl('https://broker.example/opt-out'), { ok: true });
  assert.deepEqual(await gr.checkBrokerUrl('https://www.example.com/'), { ok: true });
  const injected = [];
  const r = await gr.checkBrokerUrl('https://evil.example.com/', { lookup: fakeLookup({ 'evil.example.com': ['127.0.0.1'] }, injected) });
  assert.equal(r.ok, false, 'an injected resolver is always honoured, reserved name or not');
  assert.equal(injected.length, 1);
});
