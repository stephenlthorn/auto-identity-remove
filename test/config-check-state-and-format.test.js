/**
 * test/config-check-state-and-format.test.js
 *
 * R5: the state half of `aidr config check` (where state lives, how much of it
 * is identity-stamped, which entries a corrected identity will re-run), the
 * person-level warnings that catch mistakes before they surface as odd broker
 * results, and the shape of the printed report.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkConfig, formatConfigCheck } = require('../lib/config-check');
const { personFingerprint } = require('../lib/config');
const h = require('./config-check-helpers');

const posix = process.platform !== 'win32';

function withRoot(fn) {
  const root = h.makeRoot();
  try { return fn(root); } finally { h.cleanup(root); }
}

const stateWith = (root, optOuts) => h.writeFile(path.join(root, 'state.json'), { optOuts });

// ---- state -----------------------------------------------------------------

test('no state file yet is fine and reported as empty', () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: {}, root });
  assert.deepEqual(r.info.state, { exists: false, entries: 0, stamped: 0, otherIdentity: 0 });
  assert.equal(r.ok, true);
}));

test('state entries are counted: total, identity-stamped, and for another identity', () => withRoot((root) => {
  h.writePlain(root);
  const mine = personFingerprint(h.person());
  const old = personFingerprint(h.person({ zip: '27313' }));
  stateWith(root, {
    Spokeo: { lastSuccess: '2026-10-01T00:00:00.000Z' },
    Whitepages: { fp: mine, lastSuccess: '2026-10-01T00:00:00.000Z' },
    Radaris: { fp: old, lastSuccess: '2026-09-01T00:00:00.000Z' },
    MyLife: { fp: old },
  });
  const r = checkConfig({ env: {}, root });
  assert.deepEqual(r.info.state, { exists: true, entries: 4, stamped: 3, otherIdentity: 2 });
  assert.equal(r.ok, true, 'entries for a previous identity are information, not a problem');
}));

test('in a multi-person config an entry matching any current person is not stale', () => withRoot((root) => {
  const pip = h.person({ firstName: 'Pip', lastName: 'Wren', email: 'pip@example.net' });
  h.writePlain(root, { persons: [h.person(), pip] });
  stateWith(root, {
    'Spokeo|Zebediah Quillfeather': { fp: personFingerprint(h.person()) },
    'Spokeo|Pip Wren': { fp: personFingerprint(pip) },
  });
  assert.equal(checkConfig({ env: {}, root }).info.state.otherIdentity, 0);
}));

test('a corrupt state file is a warning and is left exactly as it was', () => withRoot((root) => {
  h.writePlain(root);
  const file = h.writeFile(path.join(root, 'state.json'), '{"optOuts": {"Spokeo": ');
  const before = fs.readFileSync(file);
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /state/.test(w) && /not valid/.test(w)), r.warnings.join('\n'));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('corrupt')), [], 'checking must not quarantine anything');
}));

test('an empty state file is a fresh install, not a warning', () => withRoot((root) => {
  h.writePlain(root);
  h.writeFile(path.join(root, 'state.json'), '');
  assert.deepEqual(checkConfig({ env: {}, root }).warnings, []);
}));

test('a state directory that does not exist is a problem', () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: { AIDR_STATE_PATH: path.join(root, 'no', 'such', 'dir', 'state.json') }, root });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /state directory .* does not exist/);
}));

test('a state directory the user cannot write to is a warning', { skip: !posix || process.getuid?.() === 0 }, () => withRoot((root) => {
  h.writePlain(root);
  const dir = path.join(root, 'ro');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o500);
  try {
    const r = checkConfig({ env: { AIDR_STATE_PATH: path.join(dir, 'state.json') }, root });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /not writable/.test(w)), r.warnings.join('\n'));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
}));

// ---- person warnings -------------------------------------------------------

test('an email without an @ is a warning', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ email: 'zebediah.example.net' }) });
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.includes('person.email does not look like an email address'), r.warnings.join('\n'));
}));

test('a US zip that is not 5 digits is a warning (a leading zero lost to a number)', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ zip: '2134', state: 'MA' }) });
  const r = checkConfig({ env: {}, root });
  assert.ok(r.warnings.some((w) => /^person\.zip is not a 5-digit US ZIP/.test(w)), r.warnings.join('\n'));
}));

test('ZIP+4 and non-US postal codes are fine', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person({ zip: '27312-1234' }), h.person({ firstName: 'Pip', lastName: 'Wren', email: 'pip@example.net', country: 'CA', zip: 'K1A 0A6' })] });
  const r = checkConfig({ env: {}, root });
  assert.deepEqual(r.warnings.filter((w) => /zip/i.test(w)), []);
}));

test('a very short phone number is a warning', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ phone: '555-01' }) });
  assert.ok(checkConfig({ env: {}, root }).warnings.some((w) => /^person\.phone has only \d+ digits/.test(w)));
}));

test('a country that is not a 2-letter code is a warning', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ country: 'United States' }) });
  assert.ok(checkConfig({ env: {}, root }).warnings.some((w) => /^person\.country is not a 2-letter code/.test(w)));
}));

test('two people with the same first and last name get the shared-state warning', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person(), h.person({ email: 'other@example.net', phone: '3365550100' })] });
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /persons\[0\] and persons\[1\] have the same first and last name/.test(w) && /every run/.test(w)), r.warnings.join('\n'));
}));

test('two people sharing one email get a confirmation-mail warning', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person(), h.person({ firstName: 'Pip', lastName: 'Wren' })] });
  const r = checkConfig({ env: {}, root });
  assert.ok(r.warnings.some((w) => /persons\[0\] and persons\[1\] share an email address/.test(w)), r.warnings.join('\n'));
}));

test('a tidy multi-person config raises no warnings', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person(), h.person({ firstName: 'Pip', lastName: 'Wren', email: 'pip@example.net', phone: '3365550111' })] });
  assert.deepEqual(checkConfig({ env: {}, root }).warnings, []);
}));

// ---- the printed report ----------------------------------------------------

test('formatConfigCheck returns plain lines: locations, people, state, verdict', () => withRoot((root) => {
  h.writeEncFile(root);
  stateWith(root, { Spokeo: { fp: personFingerprint(h.person()) } });
  const lines = formatConfigCheck(checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root }));
  assert.ok(Array.isArray(lines) && lines.every((l) => typeof l === 'string'));
  const text = lines.join('\n');
  assert.match(text, /config file:\s+.*config\.json\.enc \(encrypted\)/);
  assert.match(text, /passphrase:\s+AIDR_PASSPHRASE/);
  assert.match(text, /state file:\s+.*state\.json/);
  assert.match(text, /people:\s+1/);
  assert.match(text, /state entries:\s+1 \(1 identity-stamped, 0 for a previous identity\)/);
  assert.match(lines[lines.length - 1], /^Result: OK/);
}));

test('formatConfigCheck lists problems and warnings and ends on a failing verdict', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ zip: '', email: 'x' }) });
  const lines = formatConfigCheck(checkConfig({ env: {}, root }));
  const text = lines.join('\n');
  assert.match(text, /passphrase:\s+none/);
  assert.ok(lines.some((l) => /^\s*problem: person\.zip is blank$/.test(l)), text);
  assert.ok(lines.some((l) => /^\s*warning: person\.email does not look like an email address$/.test(l)), text);
  assert.match(lines[lines.length - 1], /^Result: 1 problem, \d+ warning/);
}));

test('formatConfigCheck on a missing config still prints where it looked', () => withRoot((root) => {
  const lines = formatConfigCheck(checkConfig({ env: {}, root }));
  assert.ok(lines.some((l) => l.includes(path.join(root, 'config.json'))));
  assert.match(lines[lines.length - 1], /^Result: 1 problem/);
}));

test('the output contains no em or en dashes', () => withRoot((root) => {
  h.writePlain(root, { person: h.person({ zip: '' }) });
  const text = formatConfigCheck(checkConfig({ env: {}, root })).join('\n');
  assert.equal(/[–—]/.test(text), false);
}));
