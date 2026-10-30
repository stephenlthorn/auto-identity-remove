/**
 * test/watcher-cli.test.js
 *
 * watcher.js as a black box: the command-line contract and the modes that exit
 * before any browser work. Every child runs in a sandbox (temp config, state and
 * repo copy; fake `playwright`; stubbed notifiers), so none of these can start a
 * browser, send an email, or touch the developer's config.json / state.json.
 *
 * What they prove, per wave-1 report:
 *   d-cli     --help exits 0 and unknown flags exit 2 BEFORE anything runs; modes
 *             cannot be combined; a held lock is respected
 *   e1-config an unedited config.example.json is refused; --allow/--unallow and
 *             --list work on an encrypted config; a bad passphrase file is
 *             reported, not read as "no passphrase"
 *   c2-legal  --score reads the persisted breach count
 *   CFG-13    --list reads each person's own state entries
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSandbox, runWatcher, runnableConfig, REPO } = require('./helpers/watcher-sandbox');

const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

/** Nothing ran: no browser, no state, no lock, no run log, no notification. */
function assertNothingRan(sandbox) {
  assert.deepEqual(sandbox.fakeEvents(), [], 'the browser must not have been touched');
  assert.equal(fs.existsSync(sandbox.lock), false, 'no lock may be left behind');
  assert.deepEqual(sandbox.runLogs(), []);
  assert.deepEqual(sandbox.notificationCalls(), []);
}

// ── --help and strict flags ───────────────────────────────────────────────────

test('--help prints the usage and exits 0 before anything runs', async () => {
  await inSandbox({ config: null, state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--help']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Usage: node watcher\.js/);
    for (const flag of ['--dry-run', '--only', '--retry-failed', '--allow', '--encrypt-config']) {
      assert.ok(r.stdout.includes(flag), `usage should mention ${flag}`);
    }
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(sandbox.state), false, 'no state file may be created');
    assertNothingRan(sandbox);
  });
});

test('-h is --help', async () => {
  await inSandbox({ config: null, state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['-h']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage:/);
  });
});

test('a misspelt flag exits 2 naming the right one, and nothing runs', async () => {
  // `--dryrun` used to be ignored: a REAL run that submits to ~540 sites.
  await inSandbox({ state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--dryrun']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown option "--dryrun"/);
    assert.match(r.stderr, /did you mean "--dry-run"/);
    assert.match(r.stderr, /Nothing was run/);
    assert.equal(r.stdout, '', 'not a line of the run banner may print');
    assert.equal(fs.existsSync(sandbox.state), false);
    assertNothingRan(sandbox);
  });
});

test('a flag that needs a value, given none or another flag, exits 2', async () => {
  await inSandbox({ state: null }, async (sandbox) => {
    for (const args of [['--only'], ['--only', '--skip', 'Spokeo'], ['--pollute', 'many'], ['--freeze-done']]) {
      const r = await runWatcher(sandbox, args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Nothing was run/);
    }
    assertNothingRan(sandbox);
  });
});

test('a stray word is an error, not a silently ignored argument', async () => {
  await inSandbox({ state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['now']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unexpected argument "now"/);
    assertNothingRan(sandbox);
  });
});

test('modes that cannot be combined exit 2 instead of silently running one of them', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--list', '--score']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Mutually exclusive modes cannot be combined: --list, --score/);
    assert.equal(r.stdout, '', '--list must not have printed its table');

    const both = await runWatcher(sandbox, ['--allow', 'Spokeo', '--unallow', 'Spokeo']);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--allow and --unallow cannot be combined/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sandbox.config, 'utf8')).allowlist, [], 'the allowlist is untouched');
    assertNothingRan(sandbox);
  });
});

// ── the config gate ───────────────────────────────────────────────────────────

test('an unedited config.example.json is refused before any browser or state work', async () => {
  const example = JSON.parse(fs.readFileSync(path.join(REPO, 'config.example.json'), 'utf8'));
  await inSandbox({ config: example, state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /config is not runnable/);
    assert.match(r.stderr, /person\.email is still the config\.example\.json placeholder/);
    assert.match(r.stderr, /node setup\.js/);
    assert.equal(r.stdout, '', 'the run banner must not have printed');
    assert.equal(fs.existsSync(sandbox.state), false, 'no state may be written for a refused run');
    assertNothingRan(sandbox);
  });
});

test('--know is gated the same way: it sends real email', async () => {
  const example = JSON.parse(fs.readFileSync(path.join(REPO, 'config.example.json'), 'utf8'));
  await inSandbox({ config: example }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /config is not runnable/);
    assert.doesNotMatch(r.stdout, /Right-to-know/);
    assertNothingRan(sandbox);
  });
});

test('with no config at all a run says so and exits 1', async () => {
  await inSandbox({ config: null, state: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /config\.json not found/);
    assertNothingRan(sandbox);
  });
});

test('a run refuses to start while another live instance holds the lock', async () => {
  await inSandbox({}, async (sandbox) => {
    // This test process is alive, so its pid in the lock is a live holder.
    fs.writeFileSync(sandbox.lock, JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      ts: Date.now(),
    }));
    const r = await runWatcher(sandbox, ['--only', 'zzz-none']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`Another instance is running, pid=${process.pid}`));
    assert.deepEqual(sandbox.fakeEvents(), [], 'the browser must not launch without the lock');
    assert.deepEqual(sandbox.runLogs(), []);
  });
});

// ── --list reads each person's own entries ───────────────────────────────────

function rowsFor(output, header) {
  const from = output.indexOf(header);
  const rest = output.slice(from + header.length);
  const next = rest.search(/\n[A-Z][a-z]+ [A-Z][a-z]+\n/);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^(Spokeo|WhitePages)\s+(success|pending|never run)\b/);
    if (m) rows[m[1]] = m[2];
  }
  return rows;
}

test('--list shows one table per person, reading persons[0]\'s pre-upgrade bare key and persons[1]\'s own', async () => {
  const state = {
    optOuts: {
      Spokeo: { lastSuccess: daysAgo(3), lastAttempt: daysAgo(3) },
      'WhitePages|Alan Turing': { lastSuccess: daysAgo(2), lastAttempt: daysAgo(2) },
    },
  };
  await inSandbox({ state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--list']);
    assert.equal(r.code, 0, r.stderr);

    const ada = rowsFor(r.stdout, 'Ada Lovelace\n');
    const alan = rowsFor(r.stdout, 'Alan Turing\n');
    assert.deepEqual(ada, { Spokeo: 'success', WhitePages: 'never run' });
    assert.deepEqual(alan, { Spokeo: 'never run', WhitePages: 'success' }, 'the bare Spokeo entry is Ada\'s, not Alan\'s');
    assertNothingRan(sandbox);
  });
});

test('--list works with no config at all (single-person bare keys)', async () => {
  await inSandbox({ config: null, state: { optOuts: { Spokeo: { lastSuccess: daysAgo(1) } } } }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--list']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Spokeo\s+success/);
  });
});

// ── --allow / --unallow ──────────────────────────────────────────────────────

test('--allow and --unallow edit the allowlist and keep the config private', async () => {
  await inSandbox({}, async (sandbox) => {
    const added = await runWatcher(sandbox, ['--allow', 'Spokeo']);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /Added to allowlist: Spokeo/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sandbox.config, 'utf8')).allowlist, ['Spokeo']);
    assert.equal(fs.statSync(sandbox.config).mode & 0o077, 0, 'config.json must stay owner-only');
    assert.deepEqual(fs.readdirSync(sandbox.home).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');

    const removed = await runWatcher(sandbox, ['--unallow', 'Spokeo']);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /Removed from allowlist: Spokeo/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sandbox.config, 'utf8')).allowlist, []);
    assertNothingRan(sandbox);
  });
});

test('--allow with no config says why it cannot, and exits 1', async () => {
  await inSandbox({ config: null }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--allow', 'Spokeo']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not update the allowlist/);
  });
});

// ── encrypted config ─────────────────────────────────────────────────────────

test('--encrypt-config with no passphrase explains both ways to give one', async () => {
  await inSandbox({}, async (sandbox) => {
    const before = fs.readFileSync(sandbox.config, 'utf8');
    const r = await runWatcher(sandbox, ['--encrypt-config']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No passphrase/);
    assert.match(r.stderr, /AIDR_PASSPHRASE_FILE/);
    assert.equal(fs.readFileSync(sandbox.config, 'utf8'), before, 'the plaintext config is untouched');
    assert.equal(fs.existsSync(sandbox.configEnc), false);
  });
});

test('--encrypt-config reports a passphrase file others can read instead of calling it "no passphrase"', async () => {
  await inSandbox({}, async (sandbox) => {
    const file = path.join(sandbox.home, 'loose.passphrase');
    fs.writeFileSync(file, 'correct horse battery staple\n');
    fs.chmodSync(file, 0o644);

    const r = await runWatcher(sandbox, ['--encrypt-config'], { env: { AIDR_PASSPHRASE_FILE: file } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cannot use the passphrase/);
    assert.match(r.stderr, /chmod 600/);
    assert.equal(fs.existsSync(sandbox.configEnc), false, 'nothing may be encrypted with a passphrase that was refused');
    assert.ok(fs.existsSync(sandbox.config));
  });
});

test('an encrypted config is shredded, then --list and --allow keep working on it without re-creating the plaintext', async () => {
  await inSandbox({ state: { optOuts: { Spokeo: { lastSuccess: daysAgo(1) } } } }, async (sandbox) => {
    const file = path.join(sandbox.home, 'aidr.passphrase');
    fs.writeFileSync(file, 'correct horse battery staple\n', { mode: 0o600 });
    const env = { AIDR_PASSPHRASE_FILE: file };

    const enc = await runWatcher(sandbox, ['--encrypt-config'], { env });
    assert.equal(enc.code, 0, enc.stderr);
    assert.match(enc.stdout, /Plaintext config\.json shredded/);
    assert.equal(fs.existsSync(sandbox.config), false);
    assert.ok(fs.existsSync(sandbox.configEnc));
    assert.doesNotMatch(fs.readFileSync(sandbox.configEnc, 'utf8'), /Lovelace|lovelace-test/, 'no PII in the envelope');

    const list = await runWatcher(sandbox, ['--list'], { env });
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /Ada Lovelace/);

    const allow = await runWatcher(sandbox, ['--allow', 'Spokeo'], { env });
    assert.equal(allow.code, 0, allow.stderr);
    assert.equal(fs.existsSync(sandbox.config), false, '--allow must not spill a plaintext config.json');
    assert.doesNotMatch(fs.readFileSync(sandbox.configEnc, 'utf8'), /Spokeo/, 'the allowlist is inside the ciphertext');
  });
});

// ── --score ──────────────────────────────────────────────────────────────────

test('--score counts the persisted breach result, and --dry-run saves no snapshot', async () => {
  await inSandbox({}, async (sandbox) => {
    fs.writeFileSync(
      path.join(sandbox.repo, 'data', 'breach-result.json'),
      JSON.stringify({ at: new Date().toISOString(), totalBreaches: 3, inconclusive: false }),
    );
    const history = path.join(sandbox.repo, 'data', 'exposure-history.json');

    const dry = await runWatcher(sandbox, ['--score', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /breach exposure\s+: 3/, 'the hard-coded breachCount of 0 is gone');
    assert.equal(fs.existsSync(history), false, 'a dry run saves no snapshot');

    const real = await runWatcher(sandbox, ['--score']);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(JSON.parse(fs.readFileSync(history, 'utf8')).length, 1);
    assert.deepEqual(sandbox.fakeEvents(), []);
  });
});

test('--breach-check without an HIBP key says so and does not call out', async () => {
  await inSandbox({ config: runnableConfig({ hibp: { apiKey: '' } }) }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--breach-check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /haveibeenpwned\.com\/API\/Key/);
    assert.equal(fs.existsSync(path.join(sandbox.repo, 'data', 'breach-result.json')), false);
  });
});
