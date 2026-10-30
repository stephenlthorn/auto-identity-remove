/**
 * test/cli-map-help.test.js
 *
 * CORE-6: `--help` was honoured only as the FIRST argument, and unknown flags
 * were passed straight through. So `aidr run --help` and `aidr run --dryrun`
 * both started a REAL submission run. resolveCommand now treats --help / -h
 * anywhere as help, and refuses a watcher-bound command whose flags the watcher
 * would not recognise, before anything is spawned.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveCommand } = require('../lib/cli-map');

test('resolveCommand: `run --help` is help, not a real run', () => {
  const r = resolveCommand(['run', '--help']);
  assert.equal(r.ok, true);
  assert.equal(r.target, 'help');
});

test('resolveCommand: -h is help anywhere in the argument list', () => {
  assert.equal(resolveCommand(['run', '-h']).target, 'help');
  assert.equal(resolveCommand(['preview', '--only', 'Spokeo', '--help']).target, 'help');
  assert.equal(resolveCommand(['dashboard', '--help']).target, 'help');
  assert.equal(resolveCommand(['verify', '-h']).target, 'help');
});

test('resolveCommand: --help on an unknown command is still just help', () => {
  const r = resolveCommand(['nope', '--help']);
  assert.equal(r.ok, true);
  assert.equal(r.target, 'help');
});

test('resolveCommand: a misspelt flag stops before anything is spawned', () => {
  const r = resolveCommand(['run', '--dryrun']);
  assert.equal(r.ok, false);
  assert.equal(r.target, 'help');
  assert.match(r.error, /--dryrun/);
  assert.match(r.error, /did you mean "--dry-run"/);
});

test('resolveCommand: a value flag with no value stops before anything is spawned', () => {
  const r = resolveCommand(['run', '--only']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--only.*value/);
});

test('resolveCommand: a stray word after a watcher command is rejected', () => {
  const r = resolveCommand(['run', 'Spokeo']);
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected argument "Spokeo"/);
});

test('resolveCommand: valid watcher flags still pass through untouched', () => {
  const r = resolveCommand(['run', '--dry-run', '--only', 'Spokeo']);
  assert.equal(r.ok, true);
  assert.equal(r.target, 'node');
  assert.deepEqual(r.args, ['watcher.js', '--dry-run', '--only', 'Spokeo']);
});

test('resolveCommand: injected subcommand flags are validated together with the passthrough', () => {
  const r = resolveCommand(['preview', '--skip', 'Spokeo']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['watcher.js', '--preview', '--skip', 'Spokeo']);
  assert.equal(resolveCommand(['verify', '--dryrun']).ok, false);
});

test('resolveCommand: dashboard and setup keep their own argument handling', () => {
  assert.equal(resolveCommand(['dashboard', '--port', '9090']).ok, true);
  assert.equal(resolveCommand(['setup', '--anything']).ok, true);
});

test('resolveCommand: the existing version shortcuts still work', () => {
  assert.equal(resolveCommand(['--version']).target, 'version');
  assert.equal(resolveCommand(['-v']).target, 'version');
});
