/**
 * test/drop-args.test.js
 *
 * `aidr drop` and its flags. --done, --clear, --on and --person only make sense
 * with --drop; --done and --clear change the state file, so they refuse a dry run,
 * the way --freeze-done does.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const { parseWatcherArgs, buildWatcherUsage, ArgError } = require('../lib/args');
const { resolveMode } = require('../lib/mode-dispatch');
const { resolveCommand, buildHelp } = require('../lib/cli-map');

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

const refused = (fn, pattern) => assert.throws(fn, (err) => {
  assert.ok(err instanceof ArgError, err && err.message);
  assert.match(err.message, pattern);
  return true;
});

for (const { name, parser } of PARSERS) {
  const parse = (argv) => parseWatcherArgs(argv, { parser });

  test(`[${name}] --drop alone is a mode with nothing else set`, () => {
    const a = parse(['--drop']);
    assert.equal(a.drop, true);
    assert.equal(a.done, false);
    assert.equal(a.clear, false);
    assert.equal(a.on, null);
    assert.equal(a.person, null);
    assert.equal(resolveMode(a).mode, 'drop');
  });

  test(`[${name}] --done, --clear, --on and --person parse with --drop`, () => {
    const a = parse(['--drop', '--done', '--on', '2026-09-01', '--person', 'Jane Sample']);
    assert.equal(a.done, true);
    assert.equal(a.on, '2026-09-01');
    assert.equal(a.person, 'Jane Sample');
    assert.equal(parse(['--drop', '--clear']).clear, true);
  });

  test(`[${name}] the modifiers mean nothing without --drop`, () => {
    refused(() => parse(['--done']), /--done only applies together with --drop/);
    refused(() => parse(['--clear']), /--clear only applies together with --drop/);
    refused(() => parse(['--person', 'Jane Sample']), /--person only applies together with --drop/);
    refused(() => parse(['--on', '2026-09-01']), /--on only applies together with/);
  });

  test(`[${name}] --on needs --done, and --done with --clear is ambiguous`, () => {
    refused(() => parse(['--drop', '--on', '2026-09-01']), /--on only applies together with --done/);
    refused(() => parse(['--drop', '--done', '--clear']), /--done and --clear cannot be combined/);
  });

  test(`[${name}] --done and --clear change the state file, so they refuse a dry run; plain --drop does not`, () => {
    refused(() => parse(['--drop', '--done', '--dry-run']), /--dry-run cannot be combined with --done/);
    refused(() => parse(['--drop', '--clear', '--preview']), /--preview cannot be combined with --clear/);
    assert.doesNotThrow(() => parse(['--drop', '--dry-run']));
  });

  test(`[${name}] --drop is a mode: it cannot be mixed with another one`, () => {
    assert.match(resolveMode(parse(['--drop', '--list'])).conflict, /mutually exclusive/i);
  });
}

test('aidr drop maps to watcher.js --drop and passes its flags through', () => {
  const plain = resolveCommand(['drop']);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.args, ['watcher.js', '--drop']);
  assert.deepEqual(resolveCommand(['drop', '--done', '--on', '2026-09-01']).args, ['watcher.js', '--drop', '--done', '--on', '2026-09-01']);
  assert.deepEqual(resolveCommand(['drop', '--clear', '--person', 'Jane Sample']).args, ['watcher.js', '--drop', '--clear', '--person', 'Jane Sample']);
});

test('aidr drop refuses --done with --dry-run before spawning anything', () => {
  const r = resolveCommand(['drop', '--done', '--dry-run']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--dry-run/);
});

test('--done on another command is refused', () => {
  const r = resolveCommand(['run', '--done']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--done.*--drop/);
});

test('help and usage mention drop', () => {
  assert.match(buildHelp(), /\bdrop\b/);
  assert.match(buildWatcherUsage(), /--drop/);
  assert.match(buildWatcherUsage(), /--on <YYYY-MM-DD>/);
});
