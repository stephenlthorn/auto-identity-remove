/**
 * S7: an email opt-out follows the found-only decision of a searchable entry for the SAME
 * company, so the Spokeo email does not go out while the Spokeo form is skipped as not listed.
 * With no such entry it follows scan.unknown, as before.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { foundOnlyEmailPlan, registrableDomain } = require('../lib/scan');
const { searchHash, personFingerprint } = require('../lib/identity');
const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const brokers = require('../brokers');

const decisionOf = (broker, action, basis = action === 'skip' ? 'not_found' : 'found') => ({
  broker, decision: { action, basis, reason: action === 'skip' ? 'not listed (scan of 2026-11-10)' : 'listed (scan of 2026-11-10)' },
});
const searchable = (name, host) => ({ name, method: 'search-form', searchUrl: `https://www.${host}/search`, optOutUrl: `https://www.${host}/optout`, listingPattern: /x/ });
const mail = (name, to) => ({ name, method: 'email', emailTo: to });

const plan = (emailBrokers, decisions, config = {}) => foundOnlyEmailPlan({ emailBrokers, decisions, config });

test('registrableDomain: the last two labels, three for the known two-part suffixes', () => {
  assert.equal(registrableDomain('www.spokeo.com'), 'spokeo.com');
  assert.equal(registrableDomain('privacy.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('spokeo.com'), 'spokeo.com');
  assert.equal(registrableDomain(''), '');
});

test('the email is skipped when the form for the same company is skipped, and says whose decision it follows', () => {
  const out = plan([mail('Acme (email)', 'privacy@acme.com')], [decisionOf(searchable('Acme', 'acme.com'), 'skip')]);
  assert.equal(out.send.has('Acme (email)'), false);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /follows Acme/);
  assert.match(out.skipped[0].reason, /not listed/);
});

test('the email is sent when the form for the same company is submitted', () => {
  const out = plan([mail('Acme (email)', 'privacy@acme.com')], [decisionOf(searchable('Acme', 'acme.com'), 'submit')], { scan: { unknown: 'skip' } });
  assert.equal(out.send.has('Acme (email)'), true, 'the sibling decision wins over scan.unknown');
});

test('a subdomain on the email address still finds the company by registrable domain', () => {
  const out = plan([mail('Acme (email)', 'dpo@privacy.acme.com')], [decisionOf(searchable('Acme', 'acme.com'), 'skip')]);
  assert.equal(out.send.has('Acme (email)'), false);
});

test('with several searchable entries for the company, any submit wins (the safe direction)', () => {
  const out = plan([mail('Acme (email)', 'privacy@acme.com')], [
    decisionOf(searchable('Acme', 'acme.com'), 'skip'),
    decisionOf(searchable('Acme Pro', 'acme.com'), 'submit'),
  ]);
  assert.equal(out.send.has('Acme (email)'), true);
});

test('the name before " (email)" is the fallback when no domain matches', () => {
  const out = plan([mail('Acme (email)', 'privacy@mailhost.example')], [decisionOf(searchable('Acme', 'acme.com'), 'skip')]);
  assert.equal(out.send.has('Acme (email)'), false);
});

test('an entry for another company is not a sibling: the email follows scan.unknown', () => {
  const decisions = [decisionOf(searchable('Other', 'other.com'), 'skip')];
  const submit = plan([mail('Hiya', 'DPO@hiya.com')], decisions);
  assert.equal(submit.send.has('Hiya'), true);
  const skip = plan([mail('Hiya', 'DPO@hiya.com')], decisions, { scan: { unknown: 'skip' } });
  assert.equal(skip.send.has('Hiya'), false);
  assert.match(skip.skipped[0].reason, /scan\.unknown is "skip"/);
});

test('a sibling that cannot be searched (a plain form) is not a sibling', () => {
  const form = { name: 'Acme', method: 'direct-form', optOutUrl: 'https://www.acme.com/optout' };
  const out = plan([mail('Acme (email)', 'privacy@acme.com')], [decisionOf(form, 'skip', 'unsearchable')]);
  assert.equal(out.send.has('Acme (email)'), true, 'no searchable sibling: scan.unknown (submit)');
});

// ── through the real watcher ─────────────────────────────────────────────────

const ADA = { firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', city: 'Austin', state: 'TX', zip: '78701', country: 'US', email: 'ada@lovelace-test.example', phone: '5125550101', phoneFormatted: '(512) 555-0101' };
const day = 86400000;

test('watcher: a Spokeo not_found from a validated search skips the Spokeo form AND the Spokeo email', async () => {
  const spokeo = brokers.forPerson(ADA).find(b => b.name === 'Spokeo');
  const state = { optOuts: {}, scans: { Spokeo: { at: new Date(Date.now() - 2 * day).toISOString(), outcome: 'not_found', fp: personFingerprint(ADA), sh: searchHash(spokeo.searchUrl) } } };
  const sandbox = createSandbox({ config: runnableConfig({ persons: [ADA] }), state });
  try {
    // Today no Spokeo search step is validated live; the sandbox copy of brokers.js is made to
    // say it is, so the path a validated not_found takes is the one under test.
    const file = `${sandbox.repo}/brokers.js`;
    const src = fs.readFileSync(file, 'utf8');
    const patched = src.replace("name: 'Spokeo',\n    method: 'search-form',", "name: 'Spokeo',\n    method: 'search-form',\n    searchCheckedAt: '2026-11-17',");
    assert.notEqual(patched, src, 'the sandbox copy was patched');
    fs.writeFileSync(file, patched);

    const r = await runWatcher(sandbox, ['--found-only', '--only', 'Spokeo,Spokeo (email),Hiya']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[Spokeo\] skipped - not listed/);
    assert.match(r.stdout, /\[Spokeo \(email\)\] skipped - follows Spokeo: not listed/);
    assert.doesNotMatch(r.stdout, /\[Spokeo \(email\)\] manual/, 'the opt-out email was not prepared');
    assert.match(r.stdout, /\[Hiya\] manual/, 'an email with no searchable sibling follows scan.unknown (submit)');
  } finally {
    sandbox.cleanup();
  }
});
