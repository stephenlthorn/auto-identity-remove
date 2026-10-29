/**
 * test/config-validate-runnable.test.js
 *
 * CFG-7 (minimal): an unedited config.example.json (the README tells people to
 * copy it) passed getPersonsFromConfig and ran as "Jane Doe", recording
 * successes that then suppressed the real run for 90 days. A blank zip or email
 * did the same. validateRunnableConfig() is the gate: it returns the list of
 * reasons the config must not be run, and [] when it is fine.
 *
 * The placeholders are read from config.example.json itself, so editing the
 * example never leaves a stale second copy behind.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateRunnableConfig } = require('../lib/config');

const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');
const EXAMPLE = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));

const REAL_PERSON = {
  firstName: 'Margaret', lastName: 'Hamilton', fullName: 'Margaret Hamilton',
  city: 'Boston', state: 'MA', zip: '02108', country: 'US',
  email: 'margaret@hamilton-labs.org', phone: '6175550123',
};

test('the shipped config.example.json is NOT runnable as-is', () => {
  const problems = validateRunnableConfig(EXAMPLE);
  assert.ok(problems.length > 0);
  assert.ok(problems.some(p => /person/.test(p) && /example/i.test(p)), `got: ${problems.join(' | ')}`);
});

test('a real single-person config has no problems', () => {
  assert.deepEqual(validateRunnableConfig({ person: REAL_PERSON }), []);
});

test('a real multi-person config has no problems', () => {
  const second = { ...REAL_PERSON, firstName: 'Peter', fullName: 'Peter Hamilton', email: 'peter@hamilton-labs.org' };
  assert.deepEqual(validateRunnableConfig({ persons: [REAL_PERSON, second] }), []);
});

test('each blank required field is reported by name', () => {
  for (const field of ['firstName', 'lastName', 'email', 'zip']) {
    const problems = validateRunnableConfig({ person: { ...REAL_PERSON, [field]: '' } });
    assert.ok(problems.some(p => p.includes(`person.${field}`)), `${field}: ${problems.join(' | ')}`);
  }
});

test('whitespace-only and missing fields count as blank', () => {
  const ws = validateRunnableConfig({ person: { ...REAL_PERSON, zip: '   ' } });
  assert.ok(ws.some(p => p.includes('person.zip')));
  const { email, ...noEmail } = REAL_PERSON;
  assert.ok(validateRunnableConfig({ person: noEmail }).some(p => p.includes('person.email')));
});

test('a numeric zip is not blank', () => {
  assert.deepEqual(validateRunnableConfig({ person: { ...REAL_PERSON, zip: 2108 } }), []);
});

test('problems in a multi-person config name the index of the person', () => {
  const problems = validateRunnableConfig({ persons: [REAL_PERSON, { ...REAL_PERSON, zip: '' }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /persons\[1\]\.zip/);
});

test('the example email, the example name, and the example phone are each flagged', () => {
  const ex = EXAMPLE.person;
  const byEmail = validateRunnableConfig({ person: { ...REAL_PERSON, email: ex.email } });
  assert.ok(byEmail.some(p => p.includes('person.email') && /example/i.test(p)));

  const byName = validateRunnableConfig({ person: { ...REAL_PERSON, firstName: ex.firstName, lastName: ex.lastName } });
  assert.ok(byName.some(p => /name/i.test(p) && /example/i.test(p)));

  const byPhone = validateRunnableConfig({ person: { ...REAL_PERSON, phone: ex.phone } });
  assert.ok(byPhone.some(p => p.includes('person.phone') && /example/i.test(p)));
});

test('a real person who merely shares a first name, city or state with the example is NOT flagged', () => {
  const ex = EXAMPLE.person;
  const lookalike = { ...REAL_PERSON, firstName: ex.firstName, city: ex.city, state: ex.state, country: ex.country };
  assert.deepEqual(validateRunnableConfig({ person: lookalike }), []);
});

test('the example is flagged per person in a persons array', () => {
  const problems = validateRunnableConfig({ persons: [REAL_PERSON, { ...REAL_PERSON, email: EXAMPLE.person.email }] });
  assert.ok(problems.some(p => p.includes('persons[1].email')));
  assert.ok(!problems.some(p => p.includes('persons[0]')));
});

test('SMTP, relay and notify placeholders copied from the example are flagged', () => {
  const smtp = EXAMPLE.email.smtp;
  const problems = validateRunnableConfig({
    person: REAL_PERSON,
    email: { smtp: { host: smtp.host, port: smtp.port, user: smtp.user, pass: smtp.pass, from: smtp.from } },
    relay: { provider: EXAMPLE.relay.provider, apiKey: EXAMPLE.relay.apiKey },
    notify: { textTo: EXAMPLE.notify.textTo },
  });
  for (const field of ['email.smtp.user', 'email.smtp.pass', 'email.smtp.from', 'relay.apiKey', 'notify.textTo']) {
    assert.ok(problems.some(p => p.includes(field)), `${field} not flagged: ${problems.join(' | ')}`);
  }
});

test('real SMTP settings on the same host as the example are fine', () => {
  const problems = validateRunnableConfig({
    person: REAL_PERSON,
    email: { smtp: { host: 'smtp.gmail.com', port: 587, user: 'margaret@gmail.com', pass: 'abcd efgh ijkl mnop', from: 'margaret@gmail.com' } },
  });
  assert.deepEqual(problems, []);
});

test('the CapSolver placeholder is NOT a problem (setup writes it when the user skips CAPTCHA solving)', () => {
  assert.deepEqual(validateRunnableConfig({ person: REAL_PERSON, capsolver: { apiKey: EXAMPLE.capsolver.apiKey } }), []);
});

test('placeholders come from the example file, not a second hardcoded copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-validate-'));
  const examplePath = path.join(dir, 'config.example.json');
  fs.writeFileSync(examplePath, JSON.stringify({
    person: { firstName: 'Zed', lastName: 'Placeholder', email: 'zed@placeholder.test', phone: '0000000000' },
  }));

  const flagged = validateRunnableConfig({ person: { ...REAL_PERSON, email: 'zed@placeholder.test' } }, { examplePath });
  assert.ok(flagged.some(p => p.includes('person.email')));

  // "Jane Doe" is only a placeholder because the shipped example says so.
  const jane = { ...REAL_PERSON, firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' };
  assert.deepEqual(validateRunnableConfig({ person: jane }, { examplePath }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing example file never blocks a run (blank checks still apply)', () => {
  const missing = path.join(os.tmpdir(), 'aidr-no-such-example.json');
  assert.deepEqual(validateRunnableConfig({ person: REAL_PERSON }, { examplePath: missing }), []);
  assert.ok(validateRunnableConfig({ person: { ...REAL_PERSON, zip: '' } }, { examplePath: missing }).length > 0);
});

test('a config with no person at all is reported, not thrown', () => {
  assert.ok(validateRunnableConfig({}).some(p => /person/.test(p)));
  assert.ok(validateRunnableConfig({ persons: [] }).some(p => /persons/.test(p)));
  assert.ok(validateRunnableConfig(null).length > 0);
});
