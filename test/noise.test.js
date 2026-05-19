/**
 * test/noise.test.js
 *
 * Tests for lib/noise.js — bogus person generator for --pollute mode.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateBogusPerson } = require('../lib/noise');

// ── Shape tests ───────────────────────────────────────────────────────────────

test('generateBogusPerson returns an object with all required fields', () => {
  const p = generateBogusPerson();
  assert.ok(typeof p === 'object' && p !== null, 'must be an object');
  assert.ok(typeof p.firstName === 'string' && p.firstName.length > 0, 'firstName required');
  assert.ok(typeof p.lastName === 'string' && p.lastName.length > 0, 'lastName required');
  assert.ok(typeof p.city === 'string' && p.city.length > 0, 'city required');
  assert.ok(typeof p.state === 'string' && p.state.length === 2, 'state must be 2-char abbreviation');
  assert.ok(typeof p.zip === 'string', 'zip required');
  assert.ok(typeof p.phone === 'string' && p.phone.length > 0, 'phone required');
  assert.ok(typeof p.email === 'string' && p.email.length > 0, 'email required');
});

// ── Zip code format ───────────────────────────────────────────────────────────

test('zip code is exactly 5 digits', () => {
  for (let i = 0; i < 20; i++) {
    const { zip } = generateBogusPerson();
    assert.match(zip, /^\d{5}$/, `zip "${zip}" must be exactly 5 digits`);
  }
});

// ── Phone format ──────────────────────────────────────────────────────────────

test('phone is exactly 10 digits (no punctuation)', () => {
  for (let i = 0; i < 20; i++) {
    const { phone } = generateBogusPerson();
    assert.match(phone, /^\d{10}$/, `phone "${phone}" must be exactly 10 digits`);
  }
});

// ── Email format ──────────────────────────────────────────────────────────────

test('email is a valid gmail address with + suffix', () => {
  for (let i = 0; i < 20; i++) {
    const { email } = generateBogusPerson();
    assert.match(
      email,
      /^[a-z]+\.[a-z]+\+[a-z0-9]+@gmail\.com$/i,
      `email "${email}" must match firstname.lastname+random@gmail.com`
    );
  }
});

// ── Area code matches state ───────────────────────────────────────────────────
// We verify by checking the fixture: all area codes for a known state
// are covered in the fixture list.  We cannot test every random sample,
// but we CAN verify that for a generated person the returned area code
// appears in the expected set for that state.
//
// noise.js must export STATE_AREA_CODES so this test can verify consistency.

test('area code in phone matches the state', () => {
  const { STATE_AREA_CODES } = require('../lib/noise');
  assert.ok(
    typeof STATE_AREA_CODES === 'object',
    'noise.js must export STATE_AREA_CODES map'
  );

  // Sample 50 people to get coverage across multiple states
  for (let i = 0; i < 50; i++) {
    const p = generateBogusPerson();
    const expectedCodes = STATE_AREA_CODES[p.state];
    assert.ok(
      Array.isArray(expectedCodes) && expectedCodes.length > 0,
      `STATE_AREA_CODES must have an entry for state "${p.state}"`
    );
    const areaCode = p.phone.slice(0, 3);
    assert.ok(
      expectedCodes.includes(areaCode),
      `area code "${areaCode}" is not in expected codes for state "${p.state}": [${expectedCodes.join(', ')}]`
    );
  }
});

// ── Randomness ────────────────────────────────────────────────────────────────

test('calling generateBogusPerson twice produces different persons (with high probability)', () => {
  // Probability of identical results with 10+ first names and 10+ last names
  // is astronomically low over 10 pairs.
  let allSame = true;
  const first = generateBogusPerson();
  for (let i = 0; i < 10; i++) {
    const next = generateBogusPerson();
    if (
      next.firstName !== first.firstName ||
      next.lastName !== first.lastName ||
      next.phone !== first.phone
    ) {
      allSame = false;
      break;
    }
  }
  assert.equal(allSame, false, 'generateBogusPerson must produce different results on repeated calls');
});

// ── Fixture coverage ──────────────────────────────────────────────────────────

test('noise.js has at least 50 city/state/zip fixtures', () => {
  const { CITY_FIXTURES } = require('../lib/noise');
  assert.ok(
    Array.isArray(CITY_FIXTURES) && CITY_FIXTURES.length >= 50,
    `CITY_FIXTURES must have at least 50 entries, got ${CITY_FIXTURES?.length}`
  );
});

test('each city fixture has city, state (2-char), and zip (5 digits)', () => {
  const { CITY_FIXTURES } = require('../lib/noise');
  for (const fixture of CITY_FIXTURES) {
    assert.ok(typeof fixture.city === 'string' && fixture.city.length > 0, 'city must be non-empty string');
    assert.match(fixture.state, /^[A-Z]{2}$/, `state "${fixture.state}" must be 2 uppercase letters`);
    assert.match(fixture.zip, /^\d{5}$/, `zip "${fixture.zip}" must be 5 digits`);
  }
});

// ── processBrokerWithPerson exported ─────────────────────────────────────────

test('broker-runner exports processBrokerWithPerson function', () => {
  // Load broker-runner with mocked deps so it doesn't blow up at require-time.
  const Module = require('module');
  const originalLoad = Module._load.bind(Module);
  Module._load = function(request, parent, isMain) {
    if (parent?.filename?.includes('broker-runner')) {
      if (request === './config') return {
        RECHECK_DAYS: 90,
        shouldSkip: () => null,
        recordSuccess: () => {},
        recordPendingConfirmation: () => {},
      };
      if (request === './logger') return { logResult: () => {} };
      if (request === './forms')   return { fillForm: async () => {}, findListingUrl: async () => null };
      if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
      if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false }) };
    }
    return originalLoad(request, parent, isMain);
  };

  const brokerRunnerPath = require.resolve('../lib/broker-runner');
  delete require.cache[brokerRunnerPath];
  const runner = require('../lib/broker-runner');
  Module._load = originalLoad;

  assert.ok(
    typeof runner.processBrokerWithPerson === 'function',
    'broker-runner must export processBrokerWithPerson'
  );
});
