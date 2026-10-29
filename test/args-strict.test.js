/**
 * test/args-strict.test.js
 *
 * CORE-6: watcher.js read its flags with ad-hoc `process.argv.includes(...)`, so
 * a typo like `--dryrun` was silently ignored and started a REAL submission run
 * that sends the user's name, address and phone to ~540 sites.
 *
 * lib/args.js is the strict replacement: it knows every flag watcher.js reads,
 * and an unknown flag, a missing value or a stray positional is an error that
 * names the closest known flag. Every behavioural case runs against both the
 * util.parseArgs path and the hand-written fallback (Node 18.0-18.2 has no
 * util.parseArgs), so the two can never drift apart.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const {
  parseWatcherArgs,
  parseWatcherArgsOrExit,
  buildWatcherUsage,
  suggestFlag,
  ArgError,
  KNOWN_FLAGS,
  FLAG_SPECS,
} = require('../lib/args');
const { resolveMode } = require('../lib/mode-dispatch');
const { COMMANDS } = require('../lib/cli-map');

const ROOT = path.resolve(__dirname, '..');

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

function parse(argv, parser) {
  return parseWatcherArgs(argv, { parser });
}

function assertArgError(fn, pattern) {
  assert.throws(fn, err => {
    assert.ok(err instanceof ArgError, `expected ArgError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.code, 'AIDR_ARGS');
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

for (const { name, parser } of PARSERS) {
  test(`[${name}] no arguments leaves every switch off`, () => {
    const a = parse([], parser);
    for (const spec of FLAG_SPECS.filter(s => s.kind === 'boolean')) {
      assert.equal(a[spec.key], false, `${spec.key} should default to false`);
    }
    assert.equal(a.dryRun, false);
    assert.equal(a.only, null);
    assert.equal(a.skip, null);
    assert.equal(a.allow, null);
    assert.equal(a.unallow, null);
    assert.equal(a.freezeDone, null);
    assert.equal(a.freezeClear, null);
    assert.equal(a.pollute, 0);
    assert.equal(a.confirmEmailsDir, './inbox/confirms');
    assert.equal(a.freezeMode, false);
  });

  test(`[${name}] every boolean flag watcher.js knows is accepted on its own`, () => {
    for (const spec of FLAG_SPECS.filter(s => s.kind === 'boolean')) {
      const a = parse([spec.flag], parser);
      assert.equal(a[spec.key], true, `${spec.flag} should set ${spec.key}`);
    }
  });

  test(`[${name}] --dry-run and --preview both mean dry run, --preview also means preview`, () => {
    assert.equal(parse(['--dry-run'], parser).dryRun, true);
    assert.equal(parse(['--dry-run'], parser).preview, false);
    const p = parse(['--preview'], parser);
    assert.equal(p.preview, true);
    assert.equal(p.dryRun, true, '--preview implies --dry-run');
  });

  test(`[${name}] value flags take the next argument or an =value`, () => {
    assert.equal(parse(['--only', 'Spokeo,Radaris'], parser).only, 'Spokeo,Radaris');
    assert.equal(parse(['--only=Spokeo'], parser).only, 'Spokeo');
    assert.equal(parse(['--skip', 'Whitepages'], parser).skip, 'Whitepages');
    assert.equal(parse(['--allow', 'Spokeo'], parser).allow, 'Spokeo');
    assert.equal(parse(['--unallow', 'Spokeo'], parser).unallow, 'Spokeo');
    assert.equal(parse(['--freeze-done', 'equifax'], parser).freezeDone, 'equifax');
    assert.equal(parse(['--freeze-clear', 'equifax'], parser).freezeClear, 'equifax');
  });

  test(`[${name}] --freeze-done and --freeze-clear both switch freeze mode on`, () => {
    assert.equal(parse(['--freeze'], parser).freezeMode, true);
    assert.equal(parse(['--freeze-done', 'equifax'], parser).freezeMode, true);
    assert.equal(parse(['--freeze-clear', 'equifax'], parser).freezeMode, true);
  });

  test(`[${name}] --pollute takes a whole number`, () => {
    assert.equal(parse(['--pollute', '5'], parser).pollute, 5);
    assert.equal(parse(['--pollute', '0'], parser).pollute, 0);
    assertArgError(() => parse(['--pollute', 'many'], parser), /--pollute.*whole number/);
    assertArgError(() => parse(['--pollute', '2.5'], parser), /--pollute.*whole number/);
  });

  test(`[${name}] filters and modes combine`, () => {
    const a = parse(['--dry-run', '--only', 'Spokeo', '--no-capsolver', '--resume'], parser);
    assert.equal(a.dryRun, true);
    assert.equal(a.only, 'Spokeo');
    assert.equal(a.noCapsolver, true);
    assert.equal(a.resume, true);
  });

  test(`[${name}] an unknown flag is an error that suggests the closest known flag`, () => {
    assertArgError(() => parse(['--dryrun'], parser), /unknown option "--dryrun".*did you mean "--dry-run"/);
    assertArgError(() => parse(['--onyl', 'Spokeo'], parser), /did you mean "--only"/);
    assertArgError(() => parse(['--retry-fail'], parser), /did you mean "--retry-failed"/);
  });

  test(`[${name}] an unknown flag with no near match gets no suggestion`, () => {
    assert.throws(() => parse(['--completely-unrelated-flag'], parser), err => {
      assert.ok(err instanceof ArgError);
      assert.match(err.message, /unknown option "--completely-unrelated-flag"/);
      assert.doesNotMatch(err.message, /did you mean/);
      return true;
    });
  });

  test(`[${name}] an unknown flag after valid ones is still an error`, () => {
    assertArgError(() => parse(['--only', 'Spokeo', '--dryrun'], parser), /--dryrun/);
  });

  test(`[${name}] unknown short flags are rejected`, () => {
    assertArgError(() => parse(['-x'], parser), /unknown option "-x"/);
    assertArgError(() => parse(['-dry-run'], parser), /unknown option/);
  });

  test(`[${name}] a value flag with no value is an error`, () => {
    assertArgError(() => parse(['--only'], parser), /--only.*value/);
    assertArgError(() => parse(['--skip'], parser), /--skip.*value/);
    assertArgError(() => parse(['--only='], parser), /--only.*value/);
    assertArgError(() => parse(['--freeze-done'], parser), /--freeze-done.*value/);
    assertArgError(() => parse(['--pollute'], parser), /--pollute.*value/);
    assertArgError(() => parse(['--allow'], parser), /--allow.*value/);
  });

  test(`[${name}] a value flag will not swallow the next flag as its value`, () => {
    assertArgError(() => parse(['--only', '--skip', 'X'], parser), /--only.*value/);
    assertArgError(() => parse(['--only', '--dry-run'], parser), /--only.*value/);
  });

  test(`[${name}] a switch given a value is an error`, () => {
    assertArgError(() => parse(['--dry-run=false'], parser), /--dry-run/);
    assertArgError(() => parse(['--list=yes'], parser), /--list/);
  });

  test(`[${name}] a value flag given twice is ambiguous and rejected`, () => {
    assertArgError(() => parse(['--only', 'A', '--only', 'B'], parser), /--only.*once/);
    assert.equal(parse(['--dry-run', '--dry-run'], parser).dryRun, true, 'repeating a switch is harmless');
  });

  test(`[${name}] --help and -h are recognised anywhere`, () => {
    assert.equal(parse(['--help'], parser).help, true);
    assert.equal(parse(['-h'], parser).help, true);
    assert.equal(parse(['--only', 'Spokeo', '--help'], parser).help, true);
    assert.equal(parse(['--dry-run', '-h'], parser).help, true);
  });

  test(`[${name}] "doctor" is accepted as the first positional only`, () => {
    assert.equal(parse(['doctor'], parser).doctor, true);
    assertArgError(() => parse(['--dry-run', 'doctor'], parser), /unexpected argument "doctor"/);
  });

  test(`[${name}] a stray positional is an error, not silently ignored`, () => {
    assertArgError(() => parse(['Spokeo'], parser), /unexpected argument "Spokeo"/);
    assertArgError(() => parse(['--list', 'extra'], parser), /unexpected argument "extra"/);
    assertArgError(() => parse(['--', 'extra'], parser), /unexpected argument "extra"/);
  });

  test(`[${name}] --confirm-emails takes an optional directory`, () => {
    assert.equal(parse(['--confirm-emails'], parser).confirmEmailsDir, './inbox/confirms');
    assert.equal(parse(['--confirm-emails', './mail'], parser).confirmEmailsDir, './mail');
    const flagNext = parse(['--confirm-emails', '--dry-run'], parser);
    assert.equal(flagNext.confirmEmails, true);
    assert.equal(flagNext.confirmEmailsDir, './inbox/confirms');
    assert.equal(flagNext.dryRun, true);
    assertArgError(() => parse(['--confirm-emails', 'a', 'b'], parser), /unexpected argument/);
  });

  test(`[${name}] the result feeds resolveMode directly`, () => {
    assert.equal(resolveMode(parse(['--list'], parser)).mode, 'list');
    assert.equal(resolveMode(parse(['--know-status'], parser)).mode, 'know-status');
    assert.equal(resolveMode(parse(['--encrypt-config'], parser)).mode, 'encrypt-config');
    assert.equal(resolveMode(parse(['--dry-run'], parser)).mode, null);
    assert.match(resolveMode(parse(['--list', '--score'], parser)).conflict, /mutually exclusive/i);
  });

  test(`[${name}] every flag the aidr subcommands inject parses`, () => {
    for (const [cmd, spec] of Object.entries(COMMANDS)) {
      if (spec.file !== 'watcher.js') continue;
      assert.doesNotThrow(() => parse(spec.flags, parser), `aidr ${cmd} injects ${spec.flags.join(' ')}`);
    }
  });
}

// ─── Drift guards: args.js must know every flag the code base really uses ─────

test('args.js knows every flag watcher.js reads from process.argv', () => {
  const source = fs.readFileSync(path.join(ROOT, 'watcher.js'), 'utf8');
  const used = new Set(
    [...source.matchAll(/process\.argv\.(?:includes|indexOf)\('(--[a-z][a-z-]*)'\)/g)].map(m => m[1]),
  );

  assert.ok(used.size >= 25, `expected to find the watcher flags, found ${used.size}`);
  const missing = [...used].filter(flag => !KNOWN_FLAGS.has(flag));
  assert.deepEqual(missing, [], 'watcher.js reads flags that lib/args.js would reject');
});

test('args.js knows every flag the dashboard passes to watcher.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.js'), 'utf8');
  const block = source.slice(source.indexOf('const MODE_ARGS'), source.indexOf('function startRun'));
  const flags = block.match(/'--[a-z][a-z-]*'/g).map(s => s.slice(1, -1));
  assert.ok(flags.length >= 8);
  for (const flag of [...flags, '--only', '--skip']) {
    assert.ok(KNOWN_FLAGS.has(flag), `dashboard passes ${flag}, which lib/args.js would reject`);
  }
});

test('args.js knows the flags watcher.js reads through helper parsers', () => {
  for (const flag of ['--allow', '--unallow', '--pollute', '--confirm-emails', '--freeze-done', '--freeze-clear']) {
    assert.ok(KNOWN_FLAGS.has(flag), `${flag} missing`);
  }
});

// ─── suggestFlag / usage / exit wrapper ───────────────────────────────────────

test('suggestFlag finds the nearest flag and returns null when nothing is close', () => {
  assert.equal(suggestFlag('--dryrun', KNOWN_FLAGS), '--dry-run');
  assert.equal(suggestFlag('--dry', KNOWN_FLAGS), '--dry-run');
  assert.equal(suggestFlag('--ONLY', KNOWN_FLAGS), '--only');
  assert.equal(suggestFlag('--verbose-logging-please', KNOWN_FLAGS), null);
});

test('buildWatcherUsage lists every flag', () => {
  const usage = buildWatcherUsage();
  for (const flag of KNOWN_FLAGS) assert.ok(usage.includes(flag), `usage should mention ${flag}`);
});

function fakeIo() {
  const io = { out: '', err: '', exitCode: undefined };
  io.stdout = { write: s => { io.out += s; } };
  io.stderr = { write: s => { io.err += s; } };
  io.exit = code => { io.exitCode = code; };
  return io;
}

test('parseWatcherArgsOrExit exits 2 with a readable message on a bad flag', () => {
  const io = fakeIo();
  const result = parseWatcherArgsOrExit(['--dryrun'], io);
  assert.equal(io.exitCode, 2);
  assert.match(io.err, /--dryrun/);
  assert.match(io.err, /did you mean "--dry-run"/);
  assert.equal(result, null);
});

test('parseWatcherArgsOrExit prints usage and exits 0 for --help', () => {
  const io = fakeIo();
  parseWatcherArgsOrExit(['--only', 'X', '--help'], io);
  assert.equal(io.exitCode, 0);
  assert.match(io.out, /--dry-run/);
  assert.equal(io.err, '');
});

test('parseWatcherArgsOrExit returns the parsed flags and does not exit on good input', () => {
  const io = fakeIo();
  const a = parseWatcherArgsOrExit(['--dry-run', '--only', 'Spokeo'], io);
  assert.equal(io.exitCode, undefined);
  assert.equal(a.dryRun, true);
  assert.equal(a.only, 'Spokeo');
});
