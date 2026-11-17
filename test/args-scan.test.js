/**
 * `aidr scan` (--scan) and `aidr run --found-only`.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWatcherArgs, ArgError, FLAG_SPECS } = require('../lib/args');
const { resolveMode } = require('../lib/mode-dispatch');
const { resolveCommand, COMMANDS, buildHelp } = require('../lib/cli-map');

const parse = (...argv) => parseWatcherArgs(argv, { env: {} });
const refused = (...argv) => assert.throws(() => parse(...argv), ArgError);

test('--scan is a mode, off by default, and --only and --skip apply to it', () => {
  assert.equal(parse().scan, false);
  assert.equal(parse('--scan').scan, true);
  const r = parse('--scan', '--only', 'Spokeo', '--skip', 'Radaris');
  assert.equal(r.only, 'Spokeo');
  assert.equal(r.skip, 'Radaris');
});

test('--scan reads no run log: --retry-failed is refused with it', () => {
  assert.throws(() => parse('--scan', '--retry-failed'), /--retry-failed cannot be combined with --scan/);
});

test('--scan is marked like --verify', () => {
  const spec = (flag) => FLAG_SPECS.find(s => s.flag === flag);
  assert.equal(spec('--scan').noRunLog, true);
  assert.equal(spec('--scan').kind, 'boolean');
});

test('--scan is its own mode and cannot be mixed with another one', () => {
  assert.equal(resolveMode({ scan: true }).mode, 'scan');
  assert.match(resolveMode({ scan: true, verify: true }).conflict, /--scan, --verify|--verify, --scan/);
});

test('--found-only is a plain run modifier, off by default, that narrows with --only and --skip', () => {
  assert.equal(parse().foundOnly, false);
  const r = parse('--found-only', '--only', 'Spokeo');
  assert.equal(r.foundOnly, true);
  assert.equal(r.only, 'Spokeo');
});

test('--found-only works with --retry-failed (the two narrow each other) and --dry-run', () => {
  assert.equal(parse('--found-only', '--retry-failed').retryFailed, true);
  assert.equal(parse('--found-only', '--dry-run').dryRun, true);
});

test('--found-only cannot be combined with --resume: the checkpoint belongs to a list it would change', () => {
  assert.throws(() => parse('--found-only', '--resume'), /--found-only cannot be combined with --resume/);
});

test('--found-only cannot be combined with --captchas: that run picks its own brokers', () => {
  assert.throws(() => parse('--found-only', '--captchas'), /--found-only cannot be combined with --captchas/);
});

test('--found-only is for a run: it is refused with the modes that do not submit', () => {
  for (const flag of ['--scan', '--verify', '--serp-scan', '--serp-watch', '--know', '--list', '--score', '--report', '--doctor']) {
    assert.throws(() => parse('--found-only', flag), new RegExp(`--found-only cannot be combined with ${flag}`), flag);
  }
});

test('the help text lists both flags', () => {
  const { buildWatcherUsage } = require('../lib/args');
  const usage = buildWatcherUsage();
  assert.match(usage, /--scan\s/);
  assert.match(usage, /--found-only\s/);
});

test('aidr scan maps to watcher.js --scan and takes --only and --skip', () => {
  const r = resolveCommand(['scan']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['watcher.js', '--scan']);
  assert.deepEqual(resolveCommand(['scan', '--only', 'Spokeo']).args, ['watcher.js', '--scan', '--only', 'Spokeo']);
  assert.equal(COMMANDS.scan.file, 'watcher.js');
  assert.match(buildHelp(), /\bscan\b/);
});

test('aidr run --found-only passes the flag through', () => {
  assert.deepEqual(resolveCommand(['run', '--found-only']).args, ['watcher.js', '--found-only']);
});

test('aidr scan refuses --found-only and --retry-failed with a clear message', () => {
  assert.equal(resolveCommand(['scan', '--found-only']).ok, false);
  assert.match(resolveCommand(['scan', '--retry-failed']).error, /--scan/);
});
