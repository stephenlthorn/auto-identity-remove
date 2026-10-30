/**
 * test/browser-profile.test.js
 *
 * R7: one persistent browser profile per person. Cookies and localStorage that
 * a broker set while person A was being removed must never be loaded while
 * person B is, so each person gets their own Chromium user-data directory.
 *
 * Person 0 keeps an existing single-profile install working: when the base
 * directory already holds a Chromium profile and no per-person directory
 * exists, person 0 keeps using the base (their logins survive the upgrade) and
 * the base is stamped with an owner marker so a later re-ordering of persons
 * can never hand that profile to somebody else.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { profileDirFor, utilityProfileDir } = require('../lib/browser');

const JANE = { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com', zip: '73301', phone: '5125550000' };
const JOHN = { firstName: 'John', lastName: 'Roe', email: 'john.roe@example.com', zip: '10001', phone: '2125550000' };

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-profile-'));
const seedLegacyProfile = (base) => {
  fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Local State'), '{}');
};
const modeOf = (p) => fs.statSync(p).mode & 0o777;

describe('profileDirFor: one directory per person', () => {
  test('returns a directory inside the base named by index and a short hash', () => {
    const base = tmpBase();
    const dir = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    assert.equal(path.dirname(dir), base);
    assert.match(path.basename(dir), /^person-0-[0-9a-f]{8,16}$/);
  });

  test('name, email, phone and zip never appear in the path', () => {
    const base = tmpBase();
    const dir = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }).toLowerCase();
    for (const secret of ['jane', 'doe', 'example.com', '73301', '5125550000']) {
      assert.ok(!dir.slice(base.length).includes(secret), `path must not contain ${secret}: ${dir}`);
    }
  });

  test('different people get different directories, the same person always gets the same one', () => {
    const base = tmpBase();
    const a1 = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    const a2 = profileDirFor({ baseDir: base, person: { ...JANE }, personIndex: 0 });
    const b = profileDirFor({ baseDir: base, person: JOHN, personIndex: 1 });
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
  });

  test('the hash is normalised: case, spacing and phone punctuation do not split a profile', () => {
    const base = tmpBase();
    const plain = profileDirFor({ baseDir: base, person: JANE, personIndex: 1 });
    const noisy = profileDirFor({
      baseDir: base,
      person: { firstName: ' JANE ', lastName: 'doe', email: 'Jane.Doe@Example.com ', zip: '73301', phone: '(512) 555-0000' },
      personIndex: 1,
    });
    assert.equal(plain, noisy);
  });

  test('swapping the order of two people never hands one the other directory', () => {
    const base = tmpBase();
    const janeFirst = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    const johnSecond = profileDirFor({ baseDir: base, person: JOHN, personIndex: 1 });
    const johnFirst = profileDirFor({ baseDir: base, person: JOHN, personIndex: 0 });
    const janeSecond = profileDirFor({ baseDir: base, person: JANE, personIndex: 1 });
    assert.equal(new Set([janeFirst, johnSecond, johnFirst, janeSecond]).size, 4);
  });

  test('a person replaced at the same index gets a fresh directory', () => {
    const base = tmpBase();
    const before = profileDirFor({ baseDir: base, person: JANE, personIndex: 1 });
    const after = profileDirFor({ baseDir: base, person: JOHN, personIndex: 1 });
    assert.notEqual(before, after);
  });

  test('creates the directory owner-only (0700)', { skip: process.platform === 'win32' }, () => {
    const base = path.join(tmpBase(), 'not-yet-created');
    const dir = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(modeOf(dir), 0o700);
  });

  test('tightens a per-person directory that already exists with a looser mode', { skip: process.platform === 'win32' }, () => {
    const base = tmpBase();
    const dir = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    fs.chmodSync(dir, 0o755);
    profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    assert.equal(modeOf(dir), 0o700);
  });

  test('expands a leading ~ in the base directory', () => {
    const dir = profileDirFor({ baseDir: '~/.aidr-test-never-created-r7', person: JANE, personIndex: 3 });
    try {
      assert.ok(dir.startsWith(path.join(os.homedir(), '.aidr-test-never-created-r7')));
    } finally {
      fs.rmSync(path.join(os.homedir(), '.aidr-test-never-created-r7'), { recursive: true, force: true });
    }
  });

  test('rejects a missing base directory and a bad person index', () => {
    assert.throws(() => profileDirFor({ person: JANE, personIndex: 0 }), /baseDir/);
    assert.throws(() => profileDirFor({ baseDir: '', person: JANE, personIndex: 0 }), /baseDir/);
    assert.throws(() => profileDirFor({ baseDir: tmpBase(), person: JANE, personIndex: -1 }), /personIndex/);
    assert.throws(() => profileDirFor({ baseDir: tmpBase(), person: JANE, personIndex: 1.5 }), /personIndex/);
  });
});

describe('profileDirFor: existing installs keep their login on upgrade', () => {
  test('person 0 keeps using a base that already holds a Chromium profile', () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), base);
  });

  test('person 1 never gets the legacy base, even though it holds a profile', () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    const dir = profileDirFor({ baseDir: base, person: JOHN, personIndex: 1 });
    assert.notEqual(dir, base);
    assert.match(path.basename(dir), /^person-1-/);
  });

  test('a base with no Chromium profile in it (config, state, an empty directory) is not a legacy profile', () => {
    const base = tmpBase();
    fs.writeFileSync(path.join(base, 'notes.txt'), 'not a browser profile');
    const dir = profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    assert.notEqual(dir, base);
    assert.match(path.basename(dir), /^person-0-/);
  });

  test('once a per-person directory exists for person 0, it wins over the legacy base', () => {
    const base = tmpBase();
    const perPerson = path.join(base, path.basename(profileDirFor({ baseDir: tmpBase(), person: JANE, personIndex: 0 })));
    fs.mkdirSync(perPerson, { recursive: true });
    seedLegacyProfile(base);
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), perPerson);
  });

  test('the first claim stamps the base with an owner marker (0600) and stays stable', { skip: process.platform === 'win32' }, () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    profileDirFor({ baseDir: base, person: JANE, personIndex: 0 });
    const marker = path.join(base, '.aidr-profile-owner');
    assert.ok(fs.existsSync(marker), 'the claim must be recorded');
    assert.equal(modeOf(marker), 0o600);
    assert.ok(!fs.readFileSync(marker, 'utf8').toLowerCase().includes('jane'), 'the marker holds a hash, not a name');
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), base);
  });

  test('re-ordering persons does not hand the legacy profile to somebody else', () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), base);

    const johnNowFirst = profileDirFor({ baseDir: base, person: JOHN, personIndex: 0 });
    assert.notEqual(johnNowFirst, base, 'John must not inherit the profile Jane has been logging in with');
    assert.match(path.basename(johnNowFirst), /^person-0-/);

    const janeNowSecond = profileDirFor({ baseDir: base, person: JANE, personIndex: 1 });
    assert.notEqual(janeNowSecond, base);
  });

  test('an unwritable marker does not break the launch: the legacy base is still used', () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    const readOnly = () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); };
    const failing = { ...fs, openSync: readOnly, writeFileSync: readOnly };
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0, fs: failing }), base);
  });
});

describe('utilityProfileDir: a throwaway profile for rendering and confirm links', () => {
  test('lives under the base, is private, and is never a person profile or the legacy base', { skip: process.platform === 'win32' }, () => {
    const base = tmpBase();
    seedLegacyProfile(base);
    const dir = utilityProfileDir(base);
    assert.equal(path.dirname(dir), base);
    assert.equal(path.basename(dir), 'utility');
    assert.equal(modeOf(dir), 0o700);
    assert.equal(profileDirFor({ baseDir: base, person: JANE, personIndex: 0 }), base);
  });
});
