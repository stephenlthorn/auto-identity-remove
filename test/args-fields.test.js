'use strict';

/**
 * test/args-fields.test.js - Q4: `aidr preview --fields` and `--show-values`.
 *
 * --fields only means something while previewing, and --show-values only while
 * listing fields. Ignoring either would hide a mistake (a user who typed
 * --fields without --preview expects a report and gets a REAL run), so both are
 * refused on their own.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWatcherArgs, buildWatcherUsage, ArgError } = require('../lib/args');

for (const parser of ['util', 'manual']) {
  test(`[${parser}] --preview --fields sets fields, and showValues stays off`, () => {
    const a = parseWatcherArgs(['--preview', '--fields'], { parser });
    assert.equal(a.fields, true);
    assert.equal(a.showValues, false);
    assert.equal(a.preview, true);
  });

  test(`[${parser}] --preview --fields --show-values sets both`, () => {
    const a = parseWatcherArgs(['--preview', '--fields', '--show-values'], { parser });
    assert.equal(a.fields && a.showValues, true);
  });

  test(`[${parser}] both default to false`, () => {
    const a = parseWatcherArgs([], { parser });
    assert.equal(a.fields, false);
    assert.equal(a.showValues, false);
  });

  test(`[${parser}] --fields without --preview is refused`, () => {
    assert.throws(() => parseWatcherArgs(['--fields'], { parser }), (err) => {
      assert.ok(err instanceof ArgError);
      assert.match(err.message, /--fields only applies together with --preview/);
      return true;
    });
    assert.throws(() => parseWatcherArgs(['--dry-run', '--fields'], { parser }), ArgError);
  });

  test(`[${parser}] --show-values without --fields is refused`, () => {
    assert.throws(() => parseWatcherArgs(['--preview', '--show-values'], { parser }), (err) => {
      assert.ok(err instanceof ArgError);
      assert.match(err.message, /--show-values only applies together with --fields/);
      return true;
    });
  });
}

test('--help lists --fields and --show-values and says values are off by default', () => {
  const usage = buildWatcherUsage();
  assert.match(usage, /--fields/);
  assert.match(usage, /--show-values/);
  assert.match(usage, /--show-values\s+.*(only|names)/i);
});
