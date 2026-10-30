/**
 * test/config-check-redaction.test.js
 *
 * R5: the check output gets pasted into bug reports and chat. It must carry
 * enough to debug (initials, a masked address, counts, paths) and none of the
 * personal data or credentials it inspected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { checkConfig, formatConfigCheck, maskEmail, initialsOf } = require('../lib/config-check');
const h = require('./config-check-helpers');

const PII = [
  'Zebediah', 'Quillfeather', 'zebediah.quillfeather', 'zebediah.quillfeather@example.net',
  '3365550177', '555-0177', '12 Quillfeather Lane', 'Pittsboro', '27312',
];
const SECRETS = ['CAP-SECRETKEY-98127', 'relay-secret-key-55231', 'smtp-secret-pass-90210', 'smtp-user-zq', h.PASSPHRASE];

function assertClean(text, needles, what) {
  for (const needle of needles) {
    assert.equal(text.includes(needle), false, `${what} leaked ${JSON.stringify(needle)}:\n${text}`);
  }
}

function withRoot(fn) {
  const root = h.makeRoot();
  try { return fn(root); } finally { h.cleanup(root); }
}

test('maskEmail keeps the first character and the domain', () => {
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(maskEmail('  J@Example.COM '), 'j***@example.com');
  assert.equal(maskEmail('a@b.io'), 'a***@b.io');
});

test('maskEmail never echoes something that is not an address', () => {
  assert.equal(maskEmail('not-an-address'), '***');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
  assert.equal(maskEmail('@example.com'), '***@example.com');
});

test('initialsOf shows first and last initial only', () => {
  assert.equal(initialsOf({ firstName: 'Zebediah', lastName: 'Quillfeather' }), 'Z.Q.');
  assert.equal(initialsOf({ firstName: ' pip ', lastName: '' }), 'P.');
  assert.equal(initialsOf({}), '?');
  assert.equal(initialsOf(null), '?');
});

test('a clean run shows initials and a masked address, nothing more', () => withRoot((root) => {
  h.writePlain(root);
  const r = checkConfig({ env: {}, root });
  const text = h.everything(r, formatConfigCheck);
  assertClean(text, PII, 'a clean check');
  assertClean(text, SECRETS, 'a clean check');
  assert.match(text, /Z\.Q\./);
  assert.match(text, /z\*\*\*@example\.net/);
}));

test('a failing run with PII-bearing problems stays clean too', () => withRoot((root) => {
  h.writePlain(root, h.goodConfig({
    persons: [h.person({ zip: '' }), h.person({ email: 'zebediah.quillfeather@example.net' })],
    person: undefined,
  }));
  const r = checkConfig({ env: {}, root });
  assert.equal(r.ok, false);
  const text = h.everything(r, formatConfigCheck);
  assertClean(text, PII, 'a failing check');
  assertClean(text, SECRETS, 'a failing check');
}));

test('warnings about a person describe them by position, not by name or address', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person({ email: 'no-at-sign', zip: '2731' }), h.person()] });
  const r = checkConfig({ env: {}, root });
  assert.ok(r.warnings.length >= 2, r.warnings.join('\n'));
  const text = h.everything(r, formatConfigCheck);
  assertClean(text, PII.concat(['no-at-sign', '2731']), 'person warnings');
  assert.ok(r.warnings.some((w) => w.startsWith('persons[0].')));
}));

test('an encrypted config never puts the passphrase or its contents in the output', () => withRoot((root) => {
  h.writeEncFile(root);
  const r = checkConfig({ env: { AIDR_PASSPHRASE: h.PASSPHRASE }, root });
  const text = h.everything(r, formatConfigCheck);
  assertClean(text, PII, 'an encrypted check');
  assertClean(text, SECRETS, 'an encrypted check');
}));

test('the result lists people as initials and masked addresses', () => withRoot((root) => {
  h.writePlain(root, { persons: [h.person(), h.person({ firstName: 'Pip', lastName: 'Wren', email: 'pip.wren@example.net' })] });
  const r = checkConfig({ env: {}, root });
  assert.deepEqual(r.info.people, [
    { initials: 'Z.Q.', email: 'z***@example.net' },
    { initials: 'P.W.', email: 'p***@example.net' },
  ]);
  assert.equal(r.info.persons, 2);
}));

test('paths are shown (they are needed to find the files), but only paths', () => withRoot((root) => {
  h.writePlain(root);
  const lines = formatConfigCheck(checkConfig({ env: {}, root }));
  assert.ok(lines.some((l) => l.includes(path.join(root, 'config.json'))));
  assert.ok(lines.some((l) => l.includes(path.join(root, 'state.json'))));
}));
