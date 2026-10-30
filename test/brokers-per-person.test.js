/**
 * test/brokers-per-person.test.js
 *
 * brokers.js resolved the person's field values once, at module load, by
 * destructuring a Proxy:
 *
 *     const { firstName: F, lastName: L, ... } = new Proxy({}, {
 *       get(_, prop) { return (_getConfig().person || {})[prop]; },
 *     });
 *
 * Destructuring a Proxy invokes its getters immediately, so F..Z were frozen to
 * whatever `config.person` held at require time and then interpolated into the
 * exported array literal's searchUrl strings and formFields values. Two real
 * consequences, both invisible in a single-person setup:
 *
 *   1. A `persons: [...]` config (the documented multi-person format that
 *      getPersonsFromConfig() actually prefers) has no `config.person` at all,
 *      so every value became undefined. searchUrl degraded to
 *      "...?q=undefined&state=undefined" and every formFields entry was
 *      undefined - the browser opt-out path submitted nothing usable for anyone.
 *
 *   2. With both keys present, watcher.js loops `for (const person of persons)`
 *      but the form values stayed pinned to `config.person`, so person B's run
 *      submitted person A's name, city, state and zip to the broker. Sending
 *      one household member's PII under another's opt-out request is a privacy
 *      harm caused by the tool itself.
 *
 * The email path was never affected - lib/email.js builds its body from the
 * `person` argument - which is why the suite stayed green.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ALICE = {
  firstName: 'Alice', lastName: 'Anderson', fullName: 'Alice Anderson',
  email: 'alice@example.com', city: 'Oakland', state: 'CA', zip: '94601',
};
const BOB = {
  firstName: 'Bob', lastName: 'Baker', fullName: 'Bob Baker',
  email: 'bob@example.com', city: 'Albany', state: 'NY', zip: '12207',
};

/**
 * brokers.js does `require('./config.json')` relative to itself, so the only
 * way to exercise a different config is to load a copy of the module beside a
 * synthetic config.json.
 */
function loadBrokersWithConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-brokers-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const modPath = path.join(dir, 'brokers.js');
  delete require.cache[modPath];
  const mod = require(modPath);
  delete require.cache[modPath];
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

function allFieldValues(brokers) {
  return brokers.flatMap(b => Object.values(b.formFields || {}));
}

function allSearchUrls(brokers) {
  return brokers.filter(b => b.searchUrl).map(b => b.searchUrl);
}

// ── The persons[] regression ─────────────────────────────────────────────────

test('a persons[] config produces usable form values, not undefined', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  const values = allFieldValues(brokers);

  assert.ok(values.length > 0, 'precondition: some brokers declare formFields');
  const bad = values.filter(v => v === undefined || v === null);
  assert.equal(
    bad.length,
    0,
    `${bad.length}/${values.length} form field values were undefined under a persons[] config`,
  );
});

test('a persons[] config never puts the literal string "undefined" in a search URL', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  const offenders = allSearchUrls(brokers).filter(u => u.includes('undefined'));
  assert.deepEqual(offenders, [], 'search URLs must not contain the string "undefined"');
});

test('a persons[] config falls back to the first person', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  const values = allFieldValues(brokers);
  assert.ok(values.includes(ALICE.email), "persons[0]'s email should be the default");
  assert.ok(!values.includes(BOB.email), 'a later person must not leak into the default export');
});

// ── Per-person rebuild ───────────────────────────────────────────────────────

test('forPerson() builds field values for the person passed in', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  assert.equal(typeof brokers.forPerson, 'function', 'brokers.forPerson must exist');

  const forBob = brokers.forPerson(BOB);
  const values = allFieldValues(forBob);
  assert.ok(values.includes(BOB.email), "Bob's run must use Bob's email");
  assert.ok(values.includes(BOB.fullName), "Bob's run must use Bob's name");
  assert.ok(!values.includes(ALICE.email), "Bob's run must not carry Alice's email");
  assert.ok(!values.includes(ALICE.fullName), "Bob's run must not carry Alice's name");
});

test('forPerson() rebuilds search URLs for the person passed in', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  const urls = allSearchUrls(brokers.forPerson(BOB)).join(' ');
  assert.ok(urls.includes('Bob') || urls.includes('bob'), "Bob's search URLs must reference Bob");
  assert.ok(!urls.includes('Alice') && !urls.includes('alice'), "Bob's search URLs must not reference Alice");
});

test('forPerson() does not mutate the default export', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  brokers.forPerson(BOB);
  const values = allFieldValues(brokers);
  assert.ok(values.includes(ALICE.email), 'default export must still be persons[0]');
  assert.ok(!values.includes(BOB.email), 'default export must not be mutated by forPerson()');
});

test('forPerson() returns an independent array each call', () => {
  const brokers = loadBrokersWithConfig({ persons: [ALICE, BOB] });
  const a = brokers.forPerson(ALICE);
  const b = brokers.forPerson(BOB);
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0], 'broker objects must not be shared between persons');
});

// ── Existing single-person behaviour must not regress ────────────────────────

test('a single person config still works exactly as before', () => {
  const brokers = loadBrokersWithConfig({ person: ALICE });
  const values = allFieldValues(brokers);
  assert.ok(values.includes(ALICE.email));
  assert.ok(values.includes(ALICE.fullName));
  assert.deepEqual(allSearchUrls(brokers).filter(u => u.includes('undefined')), []);
});

test('persons[0] wins over person for the default export (same precedence as getPersonsFromConfig)', () => {
  // This used to assert the opposite (person first). The runtime loop reads
  // persons[] when both keys exist, so a default list built from `person` could
  // search for someone the run never processes (DASH-2). See also
  // brokers-primary-person.test.js.
  const brokers = loadBrokersWithConfig({ person: ALICE, persons: [BOB] });
  assert.ok(allFieldValues(brokers).includes(BOB.email));
  assert.ok(!allFieldValues(brokers).includes(ALICE.email));
});

test('no config.json at all still loads without throwing', () => {
  // The lazy-load contract: `require('./brokers')` must survive a fresh clone
  // where the user has not run setup yet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-brokers-noconf-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  const modPath = path.join(dir, 'brokers.js');
  delete require.cache[modPath];
  let brokers;
  assert.doesNotThrow(() => { brokers = require(modPath); });
  assert.ok(Array.isArray(brokers) && brokers.length > 0);
  assert.deepEqual(
    allSearchUrls(brokers).filter(u => u.includes('undefined')),
    [],
    'even with no config, URLs must not contain the string "undefined"',
  );
  delete require.cache[modPath];
  fs.rmSync(dir, { recursive: true, force: true });
});
