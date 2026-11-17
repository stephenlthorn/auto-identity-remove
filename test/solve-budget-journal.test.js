/**
 * test/solve-budget-journal.test.js
 *
 * Q2: the solve count (and the spend when known) is written into the journal's
 * end line, next to the broker counts.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openJournal } = require('../lib/journal');

function endLineOf(info) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-journal-'));
  try {
    const file = path.join(dir, 'run.jsonl');
    const j = openJournal(file, { startedAt: '2026-01-01T00:00:00.000Z', mode: 'run' });
    j.close(info);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    return lines.at(-1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the journal end line carries the solve numbers when given', () => {
  const end = endLineOf({ counts: { succeeded: 1 }, solves: { used: 2, cap: 2, spendUsd: 0.01 } });
  assert.equal(end.type, 'end');
  assert.deepEqual(end.solves, { used: 2, cap: 2, spendUsd: 0.01 });
});

test('without solve numbers the end line is as before', () => {
  const end = endLineOf({ counts: { succeeded: 1 } });
  assert.equal('solves' in end, false);
});
