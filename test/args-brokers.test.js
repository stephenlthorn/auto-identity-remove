'use strict';
/**
 * test/args-brokers.test.js
 *
 * `aidr doctor --brokers` checks every broker's opt-out page from this machine.
 * --brokers only means something with --doctor, so on its own it is an error
 * (the same rule every other modifier follows), and it must reach the watcher
 * through the `aidr doctor` command.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { parseWatcherArgs, buildWatcherUsage, ArgError } = require('../lib/args');
const { resolveCommand } = require('../lib/cli-map');

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

for (const { name, parser } of PARSERS) {
  test(`[${name}] --brokers goes with --doctor`, () => {
    const a = parseWatcherArgs(['--doctor', '--brokers'], { parser });
    assert.equal(a.doctor, true);
    assert.equal(a.brokers, true);
  });

  test(`[${name}] "doctor" as the first word works with --brokers too`, () => {
    assert.equal(parseWatcherArgs(['doctor', '--brokers'], { parser }).brokers, true);
  });

  test(`[${name}] --brokers alone is an error, not a silent no-op`, () => {
    assert.throws(() => parseWatcherArgs(['--brokers'], { parser }), (err) => {
      assert.ok(err instanceof ArgError);
      assert.match(err.message, /--brokers only applies together with --doctor/);
      return true;
    });
  });

  test(`[${name}] --brokers does not start a run when combined with another mode`, () => {
    assert.throws(() => parseWatcherArgs(['--verify', '--brokers'], { parser }), /--brokers/);
  });

  test(`[${name}] it defaults to false`, () => {
    assert.equal(parseWatcherArgs(['--doctor'], { parser }).brokers, false);
  });
}

test('the help text describes it', () => {
  assert.match(buildWatcherUsage(), /--brokers\s+With --doctor/);
});

test('`aidr doctor --brokers` reaches watcher.js as --doctor --brokers', () => {
  const r = resolveCommand(['doctor', '--brokers']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['watcher.js', '--doctor', '--brokers']);
});

test('`aidr run --brokers` is refused before anything is spawned', () => {
  assert.equal(resolveCommand(['run', '--brokers']).ok, false);
});
