/**
 * test/brokers-primary-person.test.js
 *
 * DASH-2: brokers.js _primaryPerson() preferred `config.person` over
 * `config.persons[0]`, the opposite of lib/config.js getPersonsFromConfig()
 * (persons wins when both exist). The dashboard's Config tab saves blanks into
 * `person` for a persons[] config, so after one Save the default broker list
 * (and --verify, which searches broker.searchUrl) was built from an empty
 * person: "...search?q=&type=pp&state=" for every broker.
 *
 * Each test stands up an isolated copy of brokers.js + lib/ in a temp dir so
 * the real repo-root config.json is never read.
 */

'use strict';

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
  email: 'bob@example.com', city: 'Austin', state: 'TX', zip: '73301',
};
const BLANK = {
  firstName: '', lastName: '', fullName: '', email: '', city: '', state: '', zip: '', phone: '',
};

function loadBrokersWithConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-primary-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const modPath = path.join(dir, 'brokers.js');
  for (const p of Object.keys(require.cache)) {
    if (p.startsWith(dir)) delete require.cache[p];
  }
  try {
    return require(modPath);
  } finally {
    for (const p of Object.keys(require.cache)) {
      if (p.startsWith(dir)) delete require.cache[p];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const spokeoUrl = (brokers) => brokers.find(b => b.name === 'Spokeo').searchUrl;

test('persons[0] wins over person when a config carries both keys', () => {
  const brokers = loadBrokersWithConfig({ person: BOB, persons: [ALICE, BOB] });
  assert.match(spokeoUrl(brokers), /Alice/, 'the default list follows persons[0], like getPersonsFromConfig');
  assert.doesNotMatch(spokeoUrl(brokers), /Bob/);
});

test('a blank person left by the dashboard Save does not blank the default list', () => {
  const brokers = loadBrokersWithConfig({ person: BLANK, persons: [ALICE, BOB] });
  const url = spokeoUrl(brokers);
  assert.match(url, /Alice/);
  assert.doesNotMatch(url, /search\?q=&/, 'an empty name in the query would make every lookup search for nobody');
});

test('a blank person is ignored even when persons is absent', () => {
  const brokers = loadBrokersWithConfig({ person: BLANK });
  // '#agreement': 'yes' on USPhonebook is a constant, not person data.
  const values = brokers.flatMap(b => Object.values(b.formFields || {})).filter(v => v !== 'yes');
  assert.ok(values.every(v => v === '' || v === undefined), 'no value is invented from a blank person');
});

test('the single-person format still works', () => {
  const brokers = loadBrokersWithConfig({ person: ALICE });
  assert.match(spokeoUrl(brokers), /Alice/);
});

test('a persons-only config still works', () => {
  const brokers = loadBrokersWithConfig({ persons: [BOB] });
  assert.match(spokeoUrl(brokers), /Bob/);
});

test('a populated person is used when persons is an empty array', () => {
  // getPersonsFromConfig would throw here; brokers.js must not throw at require
  // time, and the one usable person should still drive the list.
  const brokers = loadBrokersWithConfig({ person: ALICE, persons: [] });
  assert.match(spokeoUrl(brokers), /Alice/);
});
