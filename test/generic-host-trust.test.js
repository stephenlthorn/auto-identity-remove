/**
 * test/generic-host-trust.test.js
 *
 * codex #2 (P1): registry rows are "a name and a URL". A poisoned or broken row
 * pointing at an unrelated public site used to get the user's name, email and
 * address typed into whatever form it served. A row is now automated only when the
 * host plausibly belongs to the broker it names; everything else is `manual`:
 * logged, never navigated to, never filled.
 *
 * "Plausibly belongs": the host's registrable domain is the row's own listed domain,
 * or is derived from its company name, or is a domain the shipped datasets already
 * know as a broker's. A shared platform (OneTrust, Google Forms...) is never trusted
 * on name alone.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const gr = require('../generic-runner');
const { makeFakePage, optOutForm } = require('./helpers/generic-fake-page');

const ROOT = path.join(__dirname, '..');
const MARKUP_PATH = path.join(ROOT, 'data', 'markup-parsed.json');
const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
const FEEDS_PATH = path.join(ROOT, 'data', 'feeds-brokers.json');

const assess = (row, known) => gr.assessBrokerHost(row, { knownDomains: new Set(known || []) });

test('a row whose host carries the company name is trusted', () => {
  for (const [name, url] of [
    ['Acxiom LLC', 'https://isapps.acxiom.com/optout/optout.aspx'],
    ['BeenVerified, Inc.', 'https://www.beenverified.com/app/optout/search'],
    ['The Dun & Bradstreet Corporation', 'https://www.dunbradstreet.com/privacy'],
    ['M1 Data & Analytics, LLC', 'https://m1-data.com/disclosures/'],
    ['Sabio, Inc.', 'https://www.sabioctv.com/do-not-sell-my-info'],
    ['National Consumer Telecom & Utilities Exchange', 'https://nctue.com/optout'],
  ]) {
    const verdict = assess({ name, url });
    assert.equal(verdict.ok, true, `${name} -> ${url}: ${verdict.reason}`);
  }
});

test('a row whose host is unrelated to its name is not trusted', () => {
  const verdict = assess({ name: 'Acxiom LLC', url: 'https://evil-collector.example.org/optout' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /evil-collector\.example\.org/);
});

test('a row\'s own listed domain vouches for it (the Markup dataset carries one)', () => {
  assert.equal(assess({ name: 'Mississippi Tornado Alley LLC', url: 'https://www.fastpeoplesearch.com/removal', hostname: 'www.fastpeoplesearch.com' }).ok, true);
  assert.equal(assess({ name: 'Mississippi Tornado Alley LLC', url: 'https://www.fastpeoplesearch.com/removal' }).ok, false, 'without it, the legal name says nothing');
});

test('a domain the shipped datasets know as a broker\'s is trusted whatever the registry calls the company', () => {
  const row = { name: 'Mississippi Tornado Alley LLC', url: 'https://www.fastpeoplesearch.com/removal' };
  assert.equal(assess(row, ['fastpeoplesearch.com']).ok, true);
});

test('a shared platform is never trusted by the shipped list or by name: only the row\'s own listed host', () => {
  const row = { name: 'OneTrust Customer Inc', url: 'https://privacyportal.onetrust.com/webform/abc' };
  assert.equal(assess(row, ['onetrust.com']).ok, false);
  assert.equal(assess({ name: 'AtData, LLC', url: 'https://privacyportal-cdn.onetrust.com/webform/x' }, ['onetrust.com']).ok, false);
  assert.equal(assess({ ...row, hostname: 'privacyportal.onetrust.com' }).ok, true, 'a shipped row that names that exact host');
});

test('an IDN or odd host never throws', () => {
  assert.equal(assess({ name: 'X', url: 'https://xn--exmple-cua.org/' }).ok, false);
  assert.equal(assess({ name: '', url: 'not a url' }).ok, false);
});

// ── loadGenericBrokers: classification of each source ─────────────────────────

function loadWith(files) {
  const originalLoad = Module._load.bind(Module);
  const fsMock = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      const err = new Error(`ENOENT mock: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
  Module._load = (request, parent, isMain) => (parent && parent.filename && parent.filename.includes('generic-runner') && request === 'fs'
    ? fsMock
    : originalLoad(request, parent, isMain));
  const grPath = require.resolve('../generic-runner');
  delete require.cache[grPath];
  try {
    return require('../generic-runner');
  } finally {
    Module._load = originalLoad;
    delete require.cache[grPath];
  }
}

test('loadGenericBrokers marks an unrelated feed row manual and keeps the related ones', () => {
  const loaded = loadWith({
    [MARKUP_PATH]: JSON.stringify([{ name: 'Acme Data Co', hostname: 'www.acme.com', urlFinal: 'https://www.acme.com/optout' }]),
    [BADBOOL_PATH]: JSON.stringify(['https://peoplesite.net/remove']),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Globex Corporation', optOutUrl: 'https://globex.com/privacy/opt-out', method: 'direct-form', source: 'ca' },
      { name: 'Initech LLC', optOutUrl: 'https://totally-unrelated.org/opt-out', method: 'direct-form', source: 'ca' },
    ]),
  }).loadGenericBrokers(new Set());
  const byName = Object.fromEntries(loaded.map((b) => [b.name, b]));

  assert.equal(byName['Acme Data Co'].untrusted, undefined);
  assert.equal(byName['peoplesite.net'].untrusted, undefined, 'a BADBOOL row is named by its own host');
  assert.equal(byName['Globex Corporation'].untrusted, undefined);
  assert.equal(byName['Globex Corporation'].method, 'direct-form');

  assert.equal(byName['Initech LLC'].method, 'manual');
  assert.match(byName['Initech LLC'].untrusted, /totally-unrelated\.org/);
});

test('a feed row pointing at a domain the Markup dataset lists is trusted even under another company name', () => {
  const loaded = loadWith({
    [MARKUP_PATH]: JSON.stringify([{ name: 'Mississippi Tornado Alley LLC', hostname: 'www.fastpeoplesearch.com', urlFinal: 'https://www.fastpeoplesearch.com/removal' }]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([{ name: 'FPS Holdings', optOutUrl: 'https://fastpeoplesearch.com/another-path', method: 'direct-form', source: 'ca' }]),
  }).loadGenericBrokers(new Set());
  // deduped by registrable domain against the Markup row, so only that one remains
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].untrusted, undefined);
});

// ── processGenericUrl: an untrusted row is never visited ──────────────────────

test('an untrusted row is reported manual without navigating or typing anything', async () => {
  const page = makeFakePage({ url: 'https://totally-unrelated.org/opt-out', forms: [optOutForm()] });
  const result = await gr.processGenericUrl(
    page,
    { name: 'Initech LLC', url: 'https://totally-unrelated.org/opt-out', source: 'ca', method: 'manual', untrusted: 'totally-unrelated.org does not look like the site of "Initech LLC"' },
    { optOuts: {} }, false, new Set(),
    { person: { firstName: 'T', lastName: 'U', fullName: 'T U', email: 'a@b.example', state: 'CA', zip: '90001' } },
  );
  assert.equal(result.status, 'manual');
  assert.match(result.detail, /Initech/);
  assert.ok(!/^https?:\/\//.test(result.detail), 'the detail must not start with the URL: the watcher opens those in the user\'s browser');
  assert.deepEqual(page.gotos, []);
  assert.deepEqual(page.filled, []);
});

// ── the shipped data ──────────────────────────────────────────────────────────

test('the shipped Markup dataset stays mostly automatable', () => {
  const brokers = gr.loadGenericBrokers(new Set(), { explicitBrokers: [] });
  const markup = brokers.filter((b) => b.source === 'markup');
  const manual = markup.filter((b) => b.untrusted);
  assert.ok(markup.length > 400, `markup rows loaded: ${markup.length}`);
  assert.ok(manual.length / markup.length < 0.05, `${manual.length} of ${markup.length} shipped rows turned manual`);
});
