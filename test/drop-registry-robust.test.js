/**
 * test/drop-registry-robust.test.js
 *
 * D4 of the 2.1 review: a registry cell is third-party text, and one odd cell
 * ("constructor") must never be able to stop a run. Maps keyed by that text are
 * prototype-free, a registry "domain" must look like a dotted host, and a broken
 * feeds file is treated as an empty list with one warning.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drop = require('../lib/drop');
const feeds = require('../lib/feeds');
const { caCsv } = require('./helpers/ca-registry-fixture');
const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const CA_URL = 'https://ca.test/registry.csv';
const NOW = new Date('2026-11-17T12:00:00Z');
const stubFetch = (body) => async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => body,
});
const row = (id, name, website, rights = '') => [id, name, '', website, 'x@x.example', '', '1 St', 'Town', 'CA', '90000', 'UNITED STATES', rights];

const POISON = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'see our website', 'localhost'];

test('update-brokers survives registry cells named like Object.prototype members', async () => {
  const rows = [
    ...POISON.map((word, i) => row(String(i), `Odd ${i}`, word)),
    row('99', 'Good Co', 'good-co.example'),
  ];
  const out = await feeds.buildFeedsFile({ fetchImpl: stubFetch(caCsv(rows)), caUrl: CA_URL, now: NOW, explicitHosts: [] });
  assert.deepEqual(Object.keys(out.registryHosts), ['good-co.example']);
  assert.equal(out.registries.CA.ok, true);
  const roundTrip = JSON.parse(JSON.stringify(out.registryHosts));
  assert.deepEqual(roundTrip, { 'good-co.example': ['CA'] });
});

test('a previous feeds file with prototype-named hosts does not break the carry-over', async () => {
  const previous = {
    brokers: [{ name: 'Old', optOutUrl: 'https://old.example/optout', method: 'direct-form', source: 'ca', registries: ['CA'] }],
    registryHosts: JSON.parse('{"constructor":["CA"],"__proto__":["CA"],"old.example":["CA"]}'),
    registries: {},
  };
  const out = await feeds.buildFeedsFile({
    fetchImpl: async () => ({ ok: false, status: 403, headers: new Map(), text: async () => '' }),
    caUrl: CA_URL, now: NOW, explicitHosts: [], previous,
  });
  assert.equal(out.registries.CA.carriedOver, true);
  assert.deepEqual(Object.keys(out.registryHosts), ['old.example']);
});

test('loadRegistryHosts drops prototype-named and non-host keys instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-drop-'));
  try {
    const file = path.join(dir, 'feeds-brokers.json');
    fs.writeFileSync(file, '{"registryHosts":{"constructor":["CA"],"__proto__":["CA"],"toString":["CA"],"-bad-.example":["CA"],"good.example":["CA"]}}');
    const hosts = drop.loadRegistryHosts({ filePath: file });
    assert.deepEqual(Object.keys(hosts), ['good.example']);
    assert.deepEqual(hosts['good.example'], ['CA']);
    assert.deepEqual(drop.californiaDomains(hosts), new Set(['good.example']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRegistryHostsSafe: any failure is an empty list and exactly one warning', () => {
  const warnings = [];
  const boom = () => { throw new TypeError('(out[domain] || []) is not iterable'); };
  assert.deepEqual(drop.loadRegistryHostsSafe({ load: boom, warn: (m) => warnings.push(m), once: {} }), {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /registry list/);
  assert.match(warnings[0], /aidr update-brokers/);

  const fine = drop.loadRegistryHostsSafe({ load: () => ({ 'a.example': ['CA'] }), warn: (m) => warnings.push(m), once: {} });
  assert.deepEqual(fine, { 'a.example': ['CA'] });
  assert.equal(warnings.length, 1, 'no warning when it loaded');
});

test('loadRegistryHostsSafe warns once per process, however many places ask', () => {
  const warnings = [];
  const boom = () => { throw new Error('x'); };
  const state = {};
  for (let i = 0; i < 3; i++) drop.loadRegistryHostsSafe({ load: boom, warn: (m) => warnings.push(m), once: state });
  assert.equal(warnings.length, 1);
});

// ── the real watcher, with a poisoned file ───────────────────────────────────

const person = (over) => ({
  firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample', city: 'Fresno', state: 'CA', zip: '93701', country: 'US',
  email: 'jane@sample-test.example', phone: '5595550101', phoneFormatted: '(559) 555-0101', ...over,
});
const poisonFile = (sandbox) => fs.writeFileSync(
  path.join(sandbox.repo, 'data', 'feeds-brokers.json'),
  '{"brokers":[],"registryHosts":{"constructor":["CA"],"__proto__":["CA"]},"registries":{},"updatedAt":"2026-11-17T00:00:00.000Z"}',
);

test('a poisoned registry file does not stop a run, aidr drop or aidr complaints', async () => {
  const state = { optOuts: {}, drop: { 'Jane Sample': { submittedAt: '2026-09-01' } } };
  const sandbox = createSandbox({ config: runnableConfig({ persons: [person()] }), state });
  try {
    poisonFile(sandbox);
    const run = await runWatcher(sandbox, ['--only', 'Explorium Inc.']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const dropCmd = await runWatcher(sandbox, ['--drop']);
    assert.equal(dropCmd.code, 0, dropCmd.stdout + dropCmd.stderr);
    const complaints = await runWatcher(sandbox, ['--complaints']);
    assert.equal(complaints.code, 0, complaints.stdout + complaints.stderr);
  } finally { sandbox.cleanup(); }
});

// ─── D9: count brokers, not domains ─────────────────────────────────────────

const countOf = (file) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-drop-'));
  try {
    const filePath = path.join(dir, 'feeds-brokers.json');
    if (file !== null) fs.writeFileSync(filePath, typeof file === 'string' ? file : JSON.stringify(file));
    return drop.loadCaBrokerCount({ filePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('loadCaBrokerCount reads the number of California registry BROKERS, not the number of domains (D9)', () => {
  const hosts = { 'a.example': ['CA'], 'b.example': ['CA'] };
  assert.equal(countOf({ registryHosts: hosts, registries: { CA: { ok: true, count: 5, knownCount: 5 } } }), 5, '5 brokers share 2 domains');
  assert.equal(countOf({ registryHosts: hosts, registries: { CA: { ok: true, count: 5 } } }), 5, 'a file without knownCount');
});

test('a failed run that kept the earlier rows still knows how many brokers the registry has', () => {
  assert.equal(countOf({ registries: { CA: { ok: false, count: 0, knownCount: 412, carriedOver: true } } }), 412);
  assert.equal(countOf({ registries: { CA: { ok: false, count: 0 } } }), 0);
});

test('loadCaBrokerCount: a missing, broken or older-shaped file is 0, never an error', () => {
  assert.equal(countOf(null), 0);
  assert.equal(countOf('{nope'), 0);
  assert.equal(countOf([{ name: 'x' }]), 0);
  assert.equal(countOf({ registries: { CA: { ok: true, count: 'many' } } }), 0);
  assert.equal(countOf({ registries: { CA: { ok: true, count: -3 } } }), 0);
});

test('update-brokers records knownCount: this run when it worked, the earlier one when it failed', async () => {
  const rows = [row('1', 'A', 'a.example'), row('2', 'B', 'a.example'), row('3', 'C', 'c.example')];
  const ok = await feeds.buildFeedsFile({ fetchImpl: stubFetch(caCsv(rows)), caUrl: CA_URL, now: NOW, explicitHosts: [] });
  assert.equal(ok.registries.CA.count, 3);
  assert.equal(ok.registries.CA.knownCount, 3);

  const failed = await feeds.buildFeedsFile({
    fetchImpl: async () => ({ ok: false, status: 403, headers: new Map(), text: async () => '' }),
    caUrl: CA_URL, now: NOW, explicitHosts: [], previous: { brokers: [], registryHosts: {}, registries: { CA: ok.registries.CA } },
  });
  assert.equal(failed.registries.CA.ok, false);
  assert.equal(failed.registries.CA.knownCount, 3, 'the earlier count is kept');
});

test('aidr drop prints the broker count from the registries block, not the domain count (D9)', async () => {
  const sandbox = createSandbox({ config: runnableConfig({ persons: [person()] }) });
  try {
    fs.writeFileSync(path.join(sandbox.repo, 'data', 'feeds-brokers.json'), JSON.stringify({
      brokers: [], registryHosts: { 'a.example': ['CA'], 'b.example': ['CA'] },
      registries: { CA: { ok: true, count: 412, knownCount: 412 } }, updatedAt: '2026-11-17T00:00:00.000Z',
    }));
    const r = await runWatcher(sandbox, ['--drop']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /knows 412 registry brokers/);
  } finally { sandbox.cleanup(); }
});
