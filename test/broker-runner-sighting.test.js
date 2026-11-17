/**
 * A run that searches a broker before submitting and finds the listing has SEEN it.
 * That is evidence for a later verify ("seen, then gone" is a removal), so the
 * sighting is recorded. A search that finds nothing, or could not tell, records nothing.
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
  const h = loadRunner({ './forms': { fillForm: async () => {}, findListingUrl } });
  h.runner.configure({ dryRun: false, person: PERSON, personCount: 2, personIndex: 1, capsolver: null });
  const page = makePage({
    elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }],
    before: 'Opt out',
    after: 'Opt out\nYour request has been received.',
  });
  return { ...h, run: () => h.runner.processBrokerWithPerson(makeContext(page), SEARCH_BROKER, PERSON) };
}

test('a listing found by the run\'s own search step is recorded as a sighting, for that person', async () => {
  const h = setup(async () => 'https://search.example.com/listing/1');
  await h.run();
  assert.equal(h.recorded.sightings.length, 1);
  const [s] = h.recorded.sightings;
  assert.equal(s.name, 'SearchSite');
  assert.equal(s.listingUrl, 'https://search.example.com/listing/1');
  assert.equal(s.opts.person, PERSON);
  assert.equal(s.opts.personCount, 2);
  assert.equal(s.opts.personIndex, 1);
});

test('no listing, or a search that could not tell, records no sighting', async () => {
  const none = setup(async () => null);
  await none.run();
  assert.equal(none.recorded.sightings.length, 0);

  const blocked = setup(async () => { throw Object.assign(new Error('bot wall'), { code: 'UNVERIFIABLE' }); });
  await blocked.run();
  assert.equal(blocked.recorded.sightings.length, 0);
});

test('a noise submission never records a sighting', async () => {
  const h = setup(async () => 'https://search.example.com/listing/1');
  const page = makePage({ elements: [{ id: 'go', matches: ['button[type="submit"]'], inForm: true, submits: true }], before: 'a', after: 'a\nreceived' });
  await h.runner.processBrokerWithPerson(makeContext(page), SEARCH_BROKER, PERSON, { noState: true });
  assert.equal(h.recorded.sightings.length, 0);
});
