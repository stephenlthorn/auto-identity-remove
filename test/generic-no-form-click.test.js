/**
 * test/generic-no-form-click.test.js
 *
 * BRK2-1: a "Do Not Sell" click that opens no form must never be recorded as a
 * removal. The control usually navigates to a policy page, where every line is
 * "new" and ordinary legal text ("we will respond within 45 days after your request
 * is received") reads as a success message. Nothing had been submitted, yet the
 * runner recorded success and started a 90-day cooldown.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const gr = require('../generic-runner');
const { makeFakePage } = require('./helpers/generic-fake-page');

const PERSON = { firstName: 'Test', lastName: 'User', fullName: 'Test User', email: 'test@example.com', state: 'CA', zip: '90001' };
const BROKER = { name: 'Acme Data', url: 'https://acme.example.com/privacy', source: 'markup' };
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-noform-'));
  cfg.setTestStatePath(path.join(tmpDir, 'state.json'));
  gr._setConfig({ person: PERSON });
});
after(() => {
  cfg.setTestStatePath(null);
  gr._setConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const POLICY = [
  'California Privacy Notice',
  'You may ask us to delete or stop selling your personal information.',
  'We will respond within 45 days after your request is received.',
  'Call us at 1-800-555-0100 to exercise these rights.',
].join('\n');

function dnsPage({ afterClick }) {
  return makeFakePage({
    body: 'Acme Data. We sell lists.',
    url: BROKER.url,
    pageScope: false,
    pageSelectors: (sel) => sel.includes('Do Not Sell') || sel.includes('donotsell'),
    onPageClick: (sel, page) => afterClick(page),
    forms: [],
  });
}

const run = (page) => gr.processGenericUrl(page, BROKER, { optOuts: {} }, false, new Set(), { person: PERSON, dnsLookup: publicLookup });

test('BRK2-1: the control navigates to a policy page whose boilerplate matches the success wording: manual, never success', async () => {
  const page = dnsPage({ afterClick: (p) => { p.body = POLICY; p.currentUrl = 'https://acme.example.com/california-privacy-notice'; } });
  const result = await run(page);
  assert.notEqual(result.status, 'success', JSON.stringify(result));
  assert.notEqual(result.status, 'pending_confirm');
  assert.equal(result.status, 'manual');
});

test('BRK2-1: a policy page that mentions a confirmation email is not a pending confirmation either', async () => {
  const page = dnsPage({ afterClick: (p) => { p.body = `${POLICY}\nWe will send a confirmation email to verify your identity.`; p.currentUrl = 'https://acme.example.com/privacy-rights'; } });
  const result = await run(page);
  assert.equal(result.status, 'manual');
});

test('BRK2-1: a message that appears in place (no navigation) is at most unverified: nothing was submitted', async () => {
  const page = dnsPage({ afterClick: (p) => { p.body += '\nYour request has been received.'; } });
  const result = await run(page);
  assert.equal(result.status, 'unverified', JSON.stringify(result));
  assert.match(result.detail, /Do Not Sell/i);
});

test('BRK2-1: no change at all after the click stays manual', async () => {
  const page = dnsPage({ afterClick: () => {} });
  const result = await run(page);
  assert.equal(result.status, 'manual');
});
