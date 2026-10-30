/**
 * test/mode-dispatch-allowlist.test.js
 *
 * CLI2-11: --allow and --unallow were not in resolveMode's list of modes, so the
 * "two modes together is ambiguous" check never saw them: `--list --allow Spokeo`
 * printed the list, exited 0 and added nothing to the allowlist (the dispatch order
 * ran --list first), and the user believed the broker was now protected.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { resolveMode } = require('../lib/mode-dispatch');
const { parseWatcherArgs } = require('../lib/args');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

test('resolveMode: --allow and --unallow are modes of their own', () => {
  assert.deepEqual(resolveMode({ allow: 'Spokeo' }), { mode: 'allow', conflict: null });
  assert.deepEqual(resolveMode({ unallow: 'Spokeo' }), { mode: 'unallow', conflict: null });
});

test('resolveMode: --allow next to another mode is a conflict (it used to be silently dropped)', () => {
  const result = resolveMode({ list: true, allow: 'x' });
  assert.ok(result.conflict, 'a conflict is reported');
  assert.match(result.conflict, /--list/);
  assert.match(result.conflict, /--allow/);
  for (const other of ['score', 'pending', 'doctor', 'report', 'verify', 'serpScan', 'know', 'purge']) {
    assert.ok(resolveMode({ [other]: true, unallow: 'x' }).conflict, `--unallow with ${other}`);
  }
});

test('resolveMode: --allow with --unallow is a conflict, reported by the same check', () => {
  const result = resolveMode({ allow: 'a', unallow: 'b' });
  assert.match(result.conflict, /--allow/);
  assert.match(result.conflict, /--unallow/);
});

test('the real parsed flags: a null allow (flag absent) is not a mode', () => {
  assert.deepEqual(resolveMode(parseWatcherArgs([])), { mode: null, conflict: null });
  assert.deepEqual(resolveMode(parseWatcherArgs(['--allow', 'Spokeo'])), { mode: 'allow', conflict: null });
});

test('watcher.js --list --allow X exits 2 and adds nothing to the allowlist', async () => {
  const sandbox = createSandbox();
  try {
    const before = fs.readFileSync(sandbox.config, 'utf8');
    const r = await runWatcher(sandbox, ['--list', '--allow', 'Spokeo']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /Mutually exclusive modes/);
    assert.match(r.stderr, /--allow, --list/);
    assert.equal(fs.readFileSync(sandbox.config, 'utf8'), before);
    assert.doesNotMatch(r.stdout, /Broker\s+Status/, 'the list was not printed either');
  } finally {
    sandbox.cleanup();
  }
});

test('watcher.js --allow A --unallow B exits 2 and edits nothing', async () => {
  const sandbox = createSandbox();
  try {
    const before = fs.readFileSync(sandbox.config, 'utf8');
    const r = await runWatcher(sandbox, ['--allow', 'A', '--unallow', 'B']);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(sandbox.config, 'utf8'), before);
  } finally {
    sandbox.cleanup();
  }
});

test('watcher.js --allow X on its own still works', async () => {
  const sandbox = createSandbox();
  try {
    const r = await runWatcher(sandbox, ['--allow', 'Spokeo']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(sandbox.config, 'utf8')).allowlist, ['Spokeo']);
  } finally {
    sandbox.cleanup();
  }
});
