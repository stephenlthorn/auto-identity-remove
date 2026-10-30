/**
 * test/watcher-encrypt-notice.test.js
 *
 * `watcher.js --encrypt-config` printed the leftover-copies notice only when
 * config.json itself had to stay (res.notice on a failed shred). When config.json
 * WAS removed but a plaintext copy beside it (config.json.bak, a .tmp from a
 * killed write) could not be, lib/config.js returned { shredded: true, notice },
 * the watcher said "Plaintext config.json shredded." and the copy that still held
 * the person's name, address and phone was never mentioned (CFG2-1, CFG2-5).
 *
 * Black box: the real watcher.js in the sandbox, with a one-line preload that makes
 * removing config.json.bak fail the way a root-owned or immutable file does.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');

function withRmRefusing(sandbox, suffix) {
  const preload = path.join(sandbox.dir, 'refuse-rm.js');
  fs.writeFileSync(preload, [
    "const fs = require('fs');",
    'const real = fs.rmSync;',
    'fs.rmSync = function (p, ...rest) {',
    `  if (String(p).endsWith(${JSON.stringify(suffix)})) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }`,
    '  return real.call(this, p, ...rest);',
    '};',
    '',
  ].join('\n'));
  return { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${preload}` };
}

const PASSPHRASE = 'test-passphrase-for-sandbox-only';

test('--encrypt-config names a plaintext copy it could not delete, even though config.json was removed', async () => {
  const sandbox = createSandbox({ config: runnableConfig() });
  try {
    const bak = path.join(sandbox.home, 'config.json.bak');
    fs.writeFileSync(bak, JSON.stringify(runnableConfig()), { mode: 0o600 });

    const env = { AIDR_PASSPHRASE: PASSPHRASE, ...withRmRefusing(sandbox, 'config.json.bak') };
    const r = await runWatcher(sandbox, ['--encrypt-config'], { env });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(sandbox.configEnc), 'the encrypted config was written');
    assert.ok(!fs.existsSync(sandbox.config), 'config.json itself was shredded');
    assert.match(r.stdout, /Plaintext config\.json shredded/);
    assert.match(r.stdout, /WARNING:.*plain text.*config\.json\.bak/s, 'the surviving copy is named');
    assert.match(r.stdout, /Delete them yourself/);
  } finally {
    sandbox.cleanup();
  }
});

test('--encrypt-config prints no warning when every copy was removed', async () => {
  const sandbox = createSandbox({ config: runnableConfig() });
  try {
    fs.writeFileSync(path.join(sandbox.home, 'config.json.bak'), JSON.stringify(runnableConfig()), { mode: 0o600 });

    const r = await runWatcher(sandbox, ['--encrypt-config'], { env: { AIDR_PASSPHRASE: PASSPHRASE } });

    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(sandbox.home, 'config.json.bak')), 'the copy was deleted along with config.json');
    assert.match(r.stdout, /Plaintext config\.json shredded/);
    assert.doesNotMatch(r.stdout, /WARNING/);
  } finally {
    sandbox.cleanup();
  }
});
