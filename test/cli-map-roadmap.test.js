/**
 * test/cli-map-roadmap.test.js
 *
 * The roadmap's commands: `aidr captchas`, `aidr purge`, and the two-word
 * commands `aidr schedule <status|install|uninstall>` and `aidr config check`.
 * A two-word command has a verb to resolve, and an unknown verb must stop before
 * anything is spawned with an error that names the verbs that do exist.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveCommand, COMMANDS, buildHelp } = require('../lib/cli-map');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

const args = (...argv) => resolveCommand(argv).args;

test('captchas maps to watcher.js --captchas', () => {
  const r = resolveCommand(['captchas']);
  assert.equal(r.ok, true);
  assert.equal(r.file, 'watcher.js');
  assert.deepEqual(r.args, ['watcher.js', '--captchas']);
});

test('captchas passes --solve-captchas and --dry-run through, and refuses a second selector', () => {
  assert.deepEqual(args('captchas', '--dry-run'), ['watcher.js', '--captchas', '--dry-run']);
  const r = resolveCommand(['captchas', '--only', 'Spokeo']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--captchas cannot be combined with --only/);
});

test('purge maps to watcher.js --purge and takes its modifiers', () => {
  assert.deepEqual(args('purge'), ['watcher.js', '--purge']);
  assert.deepEqual(args('purge', '--older-than', '90d', '--dry-run'), ['watcher.js', '--purge', '--older-than', '90d', '--dry-run']);
  assert.deepEqual(args('purge', '--yes', '--force'), ['watcher.js', '--purge', '--yes', '--force']);
});

test('a purge modifier on another command is refused', () => {
  const r = resolveCommand(['run', '--older-than', '30d']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--older-than.*--purge/);
});

test('config check maps to watcher.js --config-check', () => {
  const r = resolveCommand(['config', 'check']);
  assert.equal(r.ok, true);
  assert.equal(r.command, 'config');
  assert.deepEqual(r.args, ['watcher.js', '--config-check']);
});

test('config with no verb or an unknown verb stops before spawning, naming what exists', () => {
  const bare = resolveCommand(['config']);
  assert.equal(bare.ok, false);
  assert.equal(bare.target, 'help');
  assert.match(bare.error, /config needs a subcommand/);
  assert.match(bare.error, /check/);

  const unknown = resolveCommand(['config', 'edit']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown config subcommand: edit/);
  assert.match(unknown.error, /check/);
});

test('config check refuses a flag the watcher would not know', () => {
  const r = resolveCommand(['config', 'check', '--chek']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--chek/);
});

test('schedule status, install and uninstall map to their watcher modes', () => {
  assert.deepEqual(args('schedule', 'status'), ['watcher.js', '--schedule-status']);
  assert.deepEqual(args('schedule', 'install'), ['watcher.js', '--install-scheduler']);
  assert.deepEqual(args('schedule', 'uninstall'), ['watcher.js', '--uninstall-scheduler']);
});

test('schedule with no verb shows the status, and a flag first does not count as a verb', () => {
  assert.deepEqual(args('schedule'), ['watcher.js', '--schedule-status']);
  assert.deepEqual(args('schedule', '--json'), ['watcher.js', '--schedule-status', '--json']);
});

test('schedule status --json passes the flag through; --json on another verb is refused', () => {
  assert.deepEqual(args('schedule', 'status', '--json'), ['watcher.js', '--schedule-status', '--json']);
  const r = resolveCommand(['schedule', 'install', '--json']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--json.*--schedule-status/);
});

test('an unknown schedule verb stops before spawning and lists the real ones', () => {
  const r = resolveCommand(['schedule', 'remove']);
  assert.equal(r.ok, false);
  assert.equal(r.target, 'help');
  assert.match(r.error, /unknown schedule subcommand: remove/);
  for (const verb of ['status', 'install', 'uninstall']) assert.match(r.error, new RegExp(verb));
});

test('--help anywhere is still help, even after an unknown verb', () => {
  assert.equal(resolveCommand(['schedule', 'remove', '--help']).target, 'help');
  assert.equal(resolveCommand(['schedule', 'remove', '--help']).ok, true);
  assert.equal(resolveCommand(['config', '-h']).ok, true);
});

test('the help text lists the new commands with their verbs', () => {
  const help = buildHelp();
  assert.match(help, /\bcaptchas\b/);
  assert.match(help, /\bpurge\b/);
  assert.match(help, /schedule\s+\[?status/);
  assert.match(help, /config check\b/);
});

test('every command has a description and appears in the README command table', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    assert.ok(spec.desc && spec.desc.length > 0, `${name} needs a description`);
    assert.ok(readme.includes(`\`aidr ${name}`), `README.md must document \`aidr ${name}\``);
  }
  for (const line of ['aidr schedule status', 'aidr schedule install', 'aidr schedule uninstall', 'aidr config check', 'aidr captchas', 'aidr purge']) {
    assert.ok(readme.includes(`\`${line}`), `README.md must document \`${line}\``);
  }
});
