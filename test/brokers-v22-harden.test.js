/**
 * test/brokers-v22-harden.test.js
 *
 * 1. USPhonebook has a validated search step (searched live 2026-11-17: a common
 *    name gave result links, a nonsense name gave HTTP 404 "0 Public Records
 *    Found"), while its opt-out flow is unchanged.
 * 2. radaris.com and peekyou.com were transferred by court order to Atlas Data
 *    Privacy Corporation. They are gone from brokers.js and no pass visits them:
 *    not the explicit runner, not the generic runner, not a search step.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const brokers = require('../brokers');
const gr = require('../generic-runner');
const { makeFakePage } = require('./helpers/generic-fake-page');

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const PERSON = {
  firstName: 'Jane', lastName: 'Sample', fullName: 'Jane Sample',
  email: 'jane@example.com', city: 'Austin', state: 'TX', zip: '73301', country: 'US',
};
const find = (person, name) => brokers.forPerson(person).find(b => b.name === name);

// ── USPhonebook ──────────────────────────────────────────────────────────────

test('USPhonebook searches /<first>-<last>/<state-slug>', () => {
  const b = find(PERSON, 'USPhonebook');
  assert.equal(b.searchUrl, 'https://www.usphonebook.com/jane-sample/texas');
  assert.equal(b.searchCheckedAt, '2026-11-17');
  assert.deepEqual(find({ ...PERSON, state: 'New York' }, 'USPhonebook').searchUrl, 'https://www.usphonebook.com/jane-sample/new-york');
});

test('USPhonebook slugs the name: lower-case, hyphens, nothing outside a-z 0-9 and hyphen', () => {
  const b = find({ ...PERSON, firstName: 'Mary Ann', lastName: "O'Neil", state: 'nc' }, 'USPhonebook');
  assert.equal(b.searchUrl, 'https://www.usphonebook.com/mary-ann-oneil/north-carolina');
});

test('USPhonebook listingPattern matches a person page and nothing else on the site', () => {
  const b = find(PERSON, 'USPhonebook');
  assert.equal(b.listingPattern.test('https://www.usphonebook.com/john-smith/U4ab12cd34ef56gh78'), true);
  assert.equal(b.listingPattern.test('https://www.usphonebook.com/john-smith/california'), false);
  assert.equal(b.listingPattern.test('https://www.usphonebook.com/removal'), false);
});

test('USPhonebook states its own no-results page (404 + "0 Public Records Found")', () => {
  const { searchNotFound } = find(PERSON, 'USPhonebook');
  assert.equal(searchNotFound.status, 404);
  assert.equal(searchNotFound.text.test('<h1>0 Public Records Found</h1>'), true);
  assert.equal(searchNotFound.text.test('Page not found'), false);
});

test('USPhonebook stays a direct form and its opt-out flow is untouched', () => {
  const b = find(PERSON, 'USPhonebook');
  assert.equal(b.method, 'direct-form');
  assert.equal(b.optOutUrl, 'https://www.usphonebook.com/removal');
  assert.equal(b.submitSelector, '#BRP');
  assert.equal(b.formFields['#subject-firstname'], 'Jane');
  assert.equal(b.formFields['#subject-lastname'], 'Sample');
  assert.equal(b.usOnly, true);
  assert.equal(b.captchaLikely, true);
});

test('a person whose state is not a US state gets NO search step, so it cannot be searched for them', () => {
  for (const state of ['ON', 'Bavaria', '', undefined]) {
    const b = find({ ...PERSON, state }, 'USPhonebook');
    assert.equal(b.searchUrl, undefined, String(state));
    assert.equal(b.listingPattern, undefined, String(state));
    assert.equal(b.searchNotFound, undefined, String(state));
    assert.equal(b.searchCheckedAt, undefined, String(state));
    assert.equal(b.optOutUrl, 'https://www.usphonebook.com/removal', 'the opt-out is still there');
  }
});

test('a person with no usable name gets no search step either', () => {
  assert.equal(find({ ...PERSON, firstName: '', lastName: '' }, 'USPhonebook').searchUrl, undefined);
  assert.equal(find({ ...PERSON, lastName: '!!!' }, 'USPhonebook').searchUrl, undefined);
});

// ── Radaris and PeekYou ──────────────────────────────────────────────────────

const GONE = ['radaris.com', 'peekyou.com'];
const mentionsGone = (text) => GONE.some(host => String(text).toLowerCase().includes(host));

test('Radaris and PeekYou are no longer explicit brokers', () => {
  const names = brokers.forPerson(PERSON).map(b => b.name);
  assert.ok(!names.includes('Radaris'));
  assert.ok(!names.includes('PeekYou'));
  for (const b of brokers.forPerson(PERSON)) {
    for (const url of [b.optOutUrl, b.searchUrl]) assert.ok(!mentionsGone(url), `${b.name}: ${url}`);
  }
});

test('neither domain is in a bundled dataset the generic pass reads', () => {
  const markup = readJson('data/markup-parsed.json');
  assert.ok(!markup.some(row => mentionsGone(row.urlFinal) || mentionsGone(row.url) || mentionsGone(row.hostname)));
  assert.ok(!readJson('data/badbool-extra.json').some(mentionsGone));
});

test('both hosts are cached dead, so even a feed or a future dataset row never navigates to them', async () => {
  const dead = gr.loadDeadSet(gr.DEAD_URLS_PATH);
  for (const host of GONE) {
    assert.ok(dead.has(host), host);
    const page = makeFakePage();
    const result = await gr.processGenericUrl(page, { name: host, url: `https://${host}/control/privacy`, source: 'feed' }, { optOuts: {} }, false, undefined, {});
    assert.equal(result.status, 'dead');
    assert.deepEqual(page.gotos, [], `${host} must not be visited`);
  }
});

test('the generic list built from the real data has no row for either domain', () => {
  const hosts = new Set(brokers.map((b) => {
    try { return new URL(b.optOutUrl || b.searchUrl || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }).filter(Boolean));
  const rows = gr.loadGenericBrokers(hosts, { explicitBrokers: brokers });
  assert.deepEqual(rows.filter(r => mentionsGone(r.url)).map(r => r.name), []);
});

test('STATUS.md prose lists both as dead or moved, with the court-order reason', () => {
  const status = fs.readFileSync(path.join(ROOT, 'STATUS.md'), 'utf8');
  assert.match(status, /\*\*Radaris\*\*: removed/);
  assert.match(status, /\*\*PeekYou\*\*: removed/);
  assert.match(status, /Atlas Data Privacy Corporation/);
  assert.doesNotMatch(status, /dead or moved as of late 2025/);
});
