/**
 * test/complaint-complainant.test.js
 *
 * CFG2-6 made findOverdue skip an entry whose person is no longer configured, but
 * the watcher still resolved the complainant with `|| persons[0]`: any row that
 * reached it with a label that matched nobody (a future findOverdue change, a
 * stale caller) was filed under the FIRST configured person's name, address,
 * email and phone, about a record that is not theirs. A complaint is signed, so
 * "nobody I can name" must mean "no complaint", never "the first person".
 *
 *   - unit: complainantFor() resolves a label to its person, a bare entry to the
 *     only person, and everything else to null.
 *   - black box: the real watcher.js with findOverdue forced to return a row for a
 *     person who is not in the config writes no complaint and says why.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { complainantFor } = require('../lib/complaint');
const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

const ADA = { firstName: 'Ada', lastName: 'Lovelace' };
const ALAN = { firstName: 'Alan', lastName: 'Turing' };

test('a label resolves to the person it names', () => {
  assert.equal(complainantFor({ person: 'Alan Turing' }, [ADA, ALAN]), ALAN);
});

test('a label that names nobody configured resolves to nobody, not to the first person', () => {
  assert.equal(complainantFor({ person: 'Bob Gone' }, [ADA, ALAN]), null);
  assert.equal(complainantFor({ person: 'Bob Gone' }, [ADA]), null);
});

test('a bare entry belongs to the only person, and to nobody when there are several', () => {
  assert.equal(complainantFor({ person: null }, [ADA]), ADA);
  assert.equal(complainantFor({}, [ADA]), ADA);
  assert.equal(complainantFor({ person: null }, [ADA, ALAN]), null);
});

test('no configured persons resolves to nobody', () => {
  assert.equal(complainantFor({ person: null }, []), null);
  assert.equal(complainantFor({ person: 'Ada Lovelace' }, undefined), null);
});

test('--complaints writes nothing for a row whose person is not configured, and says so', async () => {
  const sandbox = createSandbox({ config: runnableConfig(), state: { optOuts: {} } });
  try {
    const preload = path.join(sandbox.dir, 'force-overdue.js');
    const complaintLib = path.join(sandbox.repo, 'lib', 'complaint.js');
    fs.writeFileSync(preload, [
      `const complaint = require(${JSON.stringify(complaintLib)});`,
      'const at = new Date(Date.now() - 100 * 86400000).toISOString();',
      'complaint.findOverdue = () => [',
      "  { broker: 'Spokeo', person: 'Bob Gone', requestedAt: at, stillListedAt: at, daysOverdue: 55, regime: 'generic' },",
      '];',
      '',
    ].join('\n'));

    const r = await runWatcher(sandbox, ['--complaints', '--dry-run'], {
      env: { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${preload}` },
    });

    assert.equal(r.code, 0, r.stderr);
    const dir = path.join(sandbox.logs, 'complaints');
    const written = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(written, [], 'no complaint was signed with someone else\'s identity');
    assert.match(r.stdout, /Bob Gone/, 'the skipped row is named');
    assert.match(r.stdout, /not in your config|no longer/i);
    assert.doesNotMatch(r.stdout, /Wrote \d+ complaint file/);
  } finally {
    sandbox.cleanup();
  }
});
