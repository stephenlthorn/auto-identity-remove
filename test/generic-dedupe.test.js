/**
 * test/generic-dedupe.test.js
 *
 * BRK roadmap item 4: generic rows duplicated explicit brokers by COMPANY, so
 * Acxiom, LexisNexis, PeopleFinders and Pipl were processed twice (once by the
 * explicit runner, once by the generic one with a guessed form fill).
 * publicdatausa.com was still in badbool-extra.json although brokers.js dropped
 * it, and the California DROP portal (an authenticated state service, handled by
 * the explicit CalPrivacy DROP entry) was in the generic list.
 *
 * Dedupe used to compare exact hostnames only. It now also compares the
 * registrable domain and the company name against the explicit brokers, keeping
 * the existing explicit-host mechanism and extending it.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const explicitBrokers = require('../brokers');
const { makeFakePage, makeContext } = require('./helpers/generic-fake-page');

const ROOT = path.join(__dirname, '..');
const MARKUP_PATH = path.join(ROOT, 'data', 'markup-parsed.json');
const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
const FEEDS_PATH = path.join(ROOT, 'data', 'feeds-brokers.json');

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-dedupe-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
});
after(() => {
  cfg.setTestStatePath(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The set the watcher passes today: hosts of every explicit optOutUrl / searchUrl. */
function watcherHosts() {
  return new Set(explicitBrokers.map((b) => {
    try { return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }).filter(Boolean));
}

/** loadGenericBrokers with fixture data files instead of the real ones. */
function loadWith({ markup = [], badbool = [], feeds }, explicitHosts, extra) {
  const files = { [MARKUP_PATH]: JSON.stringify(markup), [BADBOOL_PATH]: JSON.stringify(badbool) };
  if (feeds) files[FEEDS_PATH] = JSON.stringify(feeds);
  const fsMock = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (files[p] !== undefined) return files[p]; throw new Error(`unexpected read ${p}`); },
  };
  const originalLoad = Module._load.bind(Module);
  Module._load = (request, parent, isMain) => (
    request === 'fs' && parent && parent.filename && parent.filename.includes('generic-runner')
      ? fsMock
      : originalLoad(request, parent, isMain)
  );
  const grPath = require.resolve('../generic-runner');
  const saved = require.cache[grPath];
  delete require.cache[grPath];
  let fresh;
  try { fresh = require('../generic-runner'); } finally { Module._load = originalLoad; }
  require.cache[grPath] = saved;
  return fresh.loadGenericBrokers(explicitHosts, extra);
}

const EXPLICIT = [
  { name: 'Acxiom', method: 'direct-form', optOutUrl: 'https://isapps.acxiom.com/optout/optout.aspx' },
  { name: 'LexisNexis', method: 'direct-form', optOutUrl: 'https://optout.lexisnexis.com/' },
  { name: 'PeopleFinders', method: 'direct-form', optOutUrl: 'https://www.peoplefinders.com/opt-out' },
  { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' },
  { name: 'Experian (marketing)', method: 'direct-form', optOutUrl: 'https://www.experian.com/privacy/opting_out.html' },
  { name: 'Google - Results About You', method: 'manual', optOutUrl: 'https://myaccount.google.com/data-and-privacy' },
  { name: 'National Do Not Call Registry', method: 'manual', optOutUrl: 'https://www.donotcall.gov/register.html' },
  { name: 'Hiya', method: 'email', emailTo: 'DPO@hiya.com' },
];
const HOSTS = new Set(['isapps.acxiom.com', 'optout.lexisnexis.com', 'peoplefinders.com', 'experian.com', 'myaccount.google.com', 'donotcall.gov']);

const names = (list) => list.map(b => b.name);

// ── company and registrable-domain matching ──────────────────────────────────

test('a generic row for the same company on a different host is dropped (Acxiom, LexisNexis, PeopleFinders)', () => {
  const rows = loadWith({
    markup: [
      { name: 'Acxiom LLC', urlFinal: 'https://www.acxiom.com/privacy/' },
      { name: 'LexisNexis', urlFinal: 'https://www.lexisnexis.com/en-us/terms/us-privacy-notice.page' },
      { name: 'LexisNexis Risk Solutions FL Inc.', urlFinal: 'https://consumer.risk.lexisnexis.com/california' },
      { name: 'Peoplefinders LLC', urlFinal: 'https://www.peoplefinders.com/about/privacy' },
      { name: 'PeoplefindersDaaS', urlFinal: 'https://peoplefindersdaas.com/' },
      { name: 'Keeper Co', urlFinal: 'https://keeper.example.com/optout' },
    ],
  }, HOSTS, { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows), ['Keeper Co']);
});

test('an email-only explicit broker (Pipl) also removes its generic row, by company and by email domain', () => {
  const rows = loadWith({
    markup: [
      { name: 'Pipl, Inc.', urlFinal: 'https://pipl.com/resources/privacy-documents/privacy-policy' },
      { name: 'Pipl', urlFinal: 'https://pipl-mirror.example.net/optout' },
    ],
  }, HOSTS, { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows), []);
});

test('a company-name match works even when the generic host is unrelated', () => {
  const rows = loadWith({
    markup: [{ name: 'Experian Marketing Solutions, LLC', urlFinal: 'https://unrelated-host.example.org/privacy' }],
  }, HOSTS, { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows), [], 'the head of "Experian (marketing)" is a company key');
});

test('matching is on whole company words: lookalike names are kept', () => {
  const rows = loadWith({
    markup: [
      { name: 'Piplup Games Inc', urlFinal: 'https://piplup.example.com/optout' },
      { name: 'Hiyatt Hotels', urlFinal: 'https://hiyatt.example.com/optout' },
      { name: 'National Weather Data', urlFinal: 'https://nwd.example.com/optout' },
      { name: 'Googlewhack Ltd', urlFinal: 'https://googlewhack.example.com/optout' },
    ],
  }, HOSTS, { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows).sort(), ['Googlewhack Ltd', 'Hiyatt Hotels', 'National Weather Data', 'Piplup Games Inc']);
});

test('a free-mail address on an explicit email broker does not blacklist the whole mail provider', () => {
  const rows = loadWith({
    markup: [{ name: 'Gmail Lookalike Co', urlFinal: 'https://mail.google.com/privacy' }],
    badbool: ['https://www.gmail.com/optout'],
  }, new Set(), { explicitBrokers: [{ name: 'Tiny Broker', method: 'email', emailTo: 'removal@gmail.com' }] });
  assert.equal(rows.length, 2);
});

test('the registrable domain of an explicit host covers its sibling hosts, including multi-label suffixes', () => {
  const rows = loadWith({
    markup: [
      { name: 'Sibling Row', urlFinal: 'https://privacy.broker-one.com/optout' },
      { name: 'Uk Sibling', urlFinal: 'https://legal.broker-two.co.uk/optout' },
      { name: 'Other Uk', urlFinal: 'https://legal.other-two.co.uk/optout' },
    ],
  }, new Set(['www.broker-one.com', 'optout.broker-two.co.uk']), {});
  assert.deepEqual(names(rows), ['Other Uk']);
});

test('a shared platform domain only covers its exact host (a company form on docs.google.com is not Google)', () => {
  const rows = loadWith({
    markup: [
      { name: 'PureCars Technologies, LLC', urlFinal: 'https://docs.google.com/forms/d/e/abc/viewform' },
      { name: 'Google Row', urlFinal: 'https://myaccount.google.com/privacy' },
      { name: 'State Agency Row', urlFinal: 'https://oag.ca.gov/privacy' },
    ],
  }, new Set(['myaccount.google.com', 'cppa.ca.gov']), { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows).sort(), ['PureCars Technologies, LLC', 'State Agency Row']);
});

test('generic rows are still deduped by exact host only among themselves (shared hosting domains are not one company)', () => {
  const rows = loadWith({
    markup: [
      { name: 'Alpha', urlFinal: 'https://alpha.brokerhost.net/optout' },
      { name: 'Beta', urlFinal: 'https://beta.brokerhost.net/optout' },
      { name: 'Alpha Again', urlFinal: 'https://alpha.brokerhost.net/privacy' },
    ],
  }, new Set(), {});
  assert.deepEqual(names(rows), ['Alpha', 'Beta']);
});

test('the existing explicit-host mechanism still works with no explicit broker list', () => {
  const rows = loadWith({
    markup: [{ name: 'Spokeo Page', urlFinal: 'https://www.spokeo.com/privacy-policy' }, { name: 'Free Co', urlFinal: 'https://free.example.com/x' }],
  }, new Set(['spokeo.com']));
  assert.deepEqual(names(rows), ['Free Co']);
});

test('feed rows are deduped by company and keep their method for the rest', () => {
  const rows = loadWith({
    feeds: [
      { name: 'Acxiom Corporation', optOutUrl: 'https://acxiom-feed.example.net/optout', method: 'direct-form', source: 'ca' },
      { name: 'Fresh Data', optOutUrl: 'https://fresh.example.net/optout', method: 'direct-form', source: 'vt' },
    ],
  }, HOSTS, { explicitBrokers: EXPLICIT });
  assert.deepEqual(names(rows), ['Fresh Data']);
});

// ── the California DROP portal ───────────────────────────────────────────────

test('the CA DROP portal is never a generic row, whatever dataset it arrives in', () => {
  const rows = loadWith({
    markup: [{ name: 'DROP', urlFinal: 'https://consumer.drop.privacy.ca.gov/' }],
    badbool: ['http://consumer.drop.privacy.ca.gov'],
    feeds: [{ name: 'DROP feed', optOutUrl: 'https://consumer.drop.privacy.ca.gov/start', method: 'direct-form', source: 'ca' }],
  }, new Set(), {});
  assert.deepEqual(rows, []);
});

// ── the real data files ──────────────────────────────────────────────────────

test('real data: no generic row duplicates an explicit broker, and DROP is gone', () => {
  const rows = gr.loadGenericBrokers(watcherHosts(), { explicitBrokers });
  const dupes = rows.filter(r => /^(acxiom|lexisnexis|peoplefinders|pipl|spokeo|whitepages|intelius|beenverified|radaris|mylife|nuwber|truthfinder|instant ?checkmate|zoominfo|clearbit|epsilon|equifax|experian|truecaller)\b/i.test(r.name));
  assert.deepEqual(names(dupes), [], 'rows for companies the explicit list already handles');
  assert.ok(!rows.some(r => /consumer\.drop\.privacy\.ca\.gov/.test(r.url)), 'the DROP portal is not generic');
  assert.ok(rows.length > 300, `the dedupe must not gut the list (got ${rows.length})`);
});

test('real data: publicdatausa.com is cached dead and cannot be navigated to', async () => {
  const dead = gr.loadDeadSet(gr.DEAD_URLS_PATH);
  assert.ok(dead.has('publicdatausa.com'));
  const page = makeFakePage();
  const result = await gr.processGenericUrl(page, { name: 'publicdatausa.com', url: 'https://publicdatausa.com/optout', source: 'badbool' }, { optOuts: {} }, false, undefined, {});
  assert.equal(result.status, 'dead');
  assert.deepEqual(page.gotos, []);
});

test('real data: the malformed markdown-link and trailing-dot URLs in badbool-extra.json are fixed', () => {
  const extra = JSON.parse(fs.readFileSync(BADBOOL_PATH, 'utf8'));
  for (const url of extra) {
    assert.doesNotMatch(url, /[\]\[()]/, `${url} contains markdown link debris`);
    assert.doesNotMatch(new URL(url).hostname, /\.$/, `${url} has a trailing-dot hostname`);
    assert.doesNotThrow(() => new URL(url));
  }
});

// ── runGenericBrokers wires it together ──────────────────────────────────────

test('runGenericBrokers filters explicit companies out of the loaded list (explicitBrokers option)', async () => {
  const seen = [];
  await gr.runGenericBrokers(
    makeContext(makeFakePage()), watcherHosts(), { optOuts: {} }, () => {}, () => {},
    {
      explicitBrokers,
      injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
      injectedDeadSet: new Set(),
    },
  );
  assert.ok(seen.length > 300);
  assert.ok(!seen.some(n => /^(acxiom|lexisnexis|peoplefinders|pipl)\b/i.test(n)));
});

test('runGenericBrokers needs no wiring from the caller: it learns the explicit brokers from brokers.js', async () => {
  const seen = [];
  // Same hosts-only call the watcher makes today (no explicitBrokers option).
  await gr.runGenericBrokers(
    makeContext(makeFakePage()), watcherHosts(), { optOuts: {} }, () => {}, () => {},
    {
      injectedProcessFn: async (_p, broker) => { seen.push(broker.name); return { status: 'manual', detail: '' }; },
      injectedDeadSet: new Set(),
    },
  );
  assert.ok(seen.length > 300);
  assert.ok(!seen.some(n => /^(acxiom|lexisnexis|peoplefinders|pipl)\b/i.test(n)), 'company dedupe applies with the watcher\'s current call');
});
