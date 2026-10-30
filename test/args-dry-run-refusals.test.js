/**
 * test/args-dry-run-refusals.test.js
 *
 * CLI2-1: --dry-run and --preview were accepted and ignored by the modes that run
 * before the dry-run flag is ever read. `aidr schedule install --dry-run` wrote
 * the plist and loaded it, `--encrypt-config --dry-run` shredded the plaintext
 * config, `--allow X --dry-run` edited the allowlist, `--freeze-done k --dry-run`
 * wrote state. A flag whose whole point is "change nothing" must not be silently
 * dropped, so these modes refuse it: exit 2, before anything runs.
 *
 * Modes that DO honour a dry run (--purge, --know, --report, --complaints,
 * --confirm-emails, --score, ...) keep accepting it.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { parseWatcherArgs, ArgError } = require('../lib/args');
const { resolveCommand } = require('../lib/cli-map');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

// Each of these changes something outside the run and never reads --dry-run.
const MUTATING = [
  ['--install-scheduler'],
  ['--uninstall-scheduler'],
  ['--encrypt-config'],
  ['--decrypt-config'],
  ['--allow', 'Spokeo'],
  ['--unallow', 'Spokeo'],
  ['--freeze-done', 'equifax'],
  ['--freeze-clear', 'equifax'],
  ['--update-brokers'],
];

// These honour a dry run (or never change anything), so it stays legal with them.
const HONOURING = [
  ['--purge'],
  ['--know'],
  ['--report'],
  ['--complaints'],
  ['--confirm-emails'],
  ['--score'],
  ['--list'],
  ['--freeze'],
  ['--verify'],
  ['--only', 'Spokeo'],
  [],
];

function assertRefused(fn, flag, given) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ArgError, `expected ArgError, got ${err && err.message}`);
    assert.equal(err.code, 'AIDR_ARGS');
    assert.match(err.message, new RegExp(`${given}.*${flag}|${flag}.*${given}`), 'the message names both flags');
    assert.match(err.message, /dry run|ignored|change/i);
    return true;
  });
}

for (const { name, parser } of PARSERS) {
  test(`[${name}] a mutating mode refuses --dry-run`, () => {
    for (const mode of MUTATING) {
      assertRefused(() => parseWatcherArgs([...mode, '--dry-run'], { parser }), mode[0], '--dry-run');
      assertRefused(() => parseWatcherArgs(['--dry-run', ...mode], { parser }), mode[0], '--dry-run');
    }
  });

  test(`[${name}] a mutating mode refuses --preview, which implies a dry run`, () => {
    for (const mode of MUTATING) {
      assertRefused(() => parseWatcherArgs([...mode, '--preview'], { parser }), mode[0], '--preview');
    }
  });

  test(`[${name}] the same modes parse without it`, () => {
    for (const mode of MUTATING) {
      assert.doesNotThrow(() => parseWatcherArgs(mode, { parser }), mode.join(' '));
    }
  });

  test(`[${name}] modes that honour a dry run keep accepting it`, () => {
    for (const mode of HONOURING) {
      assert.doesNotThrow(() => parseWatcherArgs([...mode, '--dry-run'], { parser }), `${mode.join(' ')} --dry-run`);
      assert.doesNotThrow(() => parseWatcherArgs([...mode, '--preview'], { parser }), `${mode.join(' ')} --preview`);
    }
  });
}

test('parseWatcherArgs(["--install-scheduler", "--dry-run"]) throws ArgError', () => {
  assert.throws(() => parseWatcherArgs(['--install-scheduler', '--dry-run']), ArgError);
});

test('the dispatcher refuses the same combinations before spawning anything', () => {
  for (const argv of [['schedule', 'install', '--dry-run'], ['schedule', 'uninstall', '--preview'], ['update-brokers', '--dry-run']]) {
    const resolved = resolveCommand(argv);
    assert.equal(resolved.ok, false, argv.join(' '));
    assert.match(resolved.error, /dry run|--dry-run|--preview/);
  }
  assert.equal(resolveCommand(['purge', '--dry-run']).ok, true);
  assert.equal(resolveCommand(['preview']).ok, true);
});

test('watcher.js --install-scheduler --dry-run exits 2 and touches nothing', async () => {
  const sandbox = createSandbox();
  try {
    const r = await runWatcher(sandbox, ['--install-scheduler', '--dry-run']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--dry-run.*--install-scheduler|--install-scheduler.*--dry-run/);
    assert.match(r.stderr, /Nothing was run/);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'Library', 'LaunchAgents')), false, 'no plist directory');
    assert.equal(fs.existsSync(path.join(sandbox.home, '.config', 'systemd')), false, 'no unit files');
    assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'scheduler' || e.event === 'scheduler-blocked'), [], 'the OS scheduler was never asked');
  } finally {
    sandbox.cleanup();
  }
});

test('watcher.js --allow X --preview leaves the config as it was', async () => {
  const sandbox = createSandbox();
  try {
    const before = fs.readFileSync(sandbox.config, 'utf8');
    const r = await runWatcher(sandbox, ['--allow', 'Spokeo', '--preview']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(sandbox.config, 'utf8'), before, 'the allowlist was not edited');
  } finally {
    sandbox.cleanup();
  }
});
