'use strict';

/**
 * test/preview-fields-watcher.test.js - Q4 end to end: `watcher.js --preview --fields`.
 *
 * The real watcher.js runs in a sandbox with a fake browser whose pages have a
 * form. The default config has no relay, and the watcher still hands every person's
 * own address to the runners as the submission email. The report must call that
 * address "email", never "masked email" (F1), and no value may appear in the output.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const PRELOAD = path.join(__dirname, 'helpers', 'fillable-page-preload.js');
const PERSON = { firstName: 'Zqfirst', lastName: 'Zqlast', fullName: 'Zqfirst Zqlast', city: 'Zqcity', state: 'TX', zip: '78701', country: 'US', email: 'zq.person@zq-test.example', phone: '5125550101', phoneFormatted: '(512) 555-0101' };

async function preview(args) {
  const sandbox = createSandbox({ config: runnableConfig({ persons: [PERSON] }) });
  try {
    const nodeOptions = `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`;
    const r = await runWatcher(sandbox, ['--preview', '--fields', '--only', 'TruePeopleSearch', ...args], { env: { NODE_OPTIONS: nodeOptions } });
    return { r, fills: sandbox.fakeEvents().filter(e => e.event === 'fill') };
  } finally {
    sandbox.cleanup();
  }
}

test('with no relay the report says "email" and the real address is what the form got', async () => {
  const { r, fills } = await preview([]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fills.some(f => f.value === PERSON.email), 'the form was filled with the real address');
  assert.match(r.stdout, /<- email\b/);
  assert.ok(!/masked email/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /TruePeopleSearch\s+\|\s+full name, email/);
});

test('without --show-values no detail value is printed', async () => {
  const { r } = await preview([]);
  for (const v of [PERSON.email, PERSON.fullName, PERSON.firstName, PERSON.lastName, PERSON.zip]) {
    assert.ok(!r.stdout.includes(v), `"${v}" leaked into the output`);
  }
});

test('with --show-values the per-broker lines carry the values', async () => {
  const { r } = await preview(['--show-values']);
  assert.ok(r.stdout.includes(PERSON.email));
});
