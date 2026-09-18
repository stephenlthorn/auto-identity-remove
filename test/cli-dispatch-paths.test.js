/**
 * test/cli-dispatch-paths.test.js
 *
 * `aidr dashboard` was dead on arrival: lib/cli-map.js returns the script as a
 * path relative to the repo root ('dashboard/server.js') while bin/aidr.js
 * spawned it with cwd set to <root>/dashboard, so node looked for
 * <root>/dashboard/dashboard/server.js and died with MODULE_NOT_FOUND. Every
 * existing test around the CLI was string-shaped - it asserted the map
 * contained 'dashboard/server.js' and stopped there - so the suite stayed green
 * for a subcommand that could never start. Reported in PR #9.
 *
 * These tests resolve the spawn target the way the dispatcher does and then
 * touch the filesystem, which is the only thing that would have caught it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, resolveCommand, resolveSpawnTarget } = require('../lib/cli-map');

const ROOT = path.resolve(__dirname, '..');

test('every subcommand resolves to a script that exists on disk', () => {
  for (const name of Object.keys(COMMANDS)) {
    const target = resolveSpawnTarget(resolveCommand([name]), ROOT);
    assert.ok(
      path.isAbsolute(target.script),
      `${name}: script should be absolute so the spawn cwd cannot double the path, got ${target.script}`
    );
    assert.ok(
      fs.existsSync(target.script),
      `${name}: resolved script does not exist: ${target.script}`
    );
    assert.ok(
      fs.existsSync(target.cwd) && fs.statSync(target.cwd).isDirectory(),
      `${name}: resolved cwd is not a directory: ${target.cwd}`
    );
  }
});

test('dashboard resolves to <root>/dashboard/server.js, not <root>/dashboard/dashboard/server.js', () => {
  const target = resolveSpawnTarget(resolveCommand(['dashboard']), ROOT);
  assert.equal(target.script, path.join(ROOT, 'dashboard', 'server.js'));
  assert.equal(target.cwd, path.join(ROOT, 'dashboard'));
});

test('a root-cwd subcommand keeps the repo root as its cwd', () => {
  const target = resolveSpawnTarget(resolveCommand(['run']), ROOT);
  assert.equal(target.script, path.join(ROOT, 'watcher.js'));
  assert.equal(target.cwd, ROOT);
});

test('passthrough args survive spawn-target resolution, and only the script is rewritten', () => {
  const target = resolveSpawnTarget(resolveCommand(['preview', '--only', 'Spokeo']), ROOT);
  assert.deepEqual(target.args, [path.join(ROOT, 'watcher.js'), '--preview', '--only', 'Spokeo']);
});
