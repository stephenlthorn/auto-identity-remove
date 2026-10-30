/**
 * test/args-roadmap.test.js
 *
 * The roadmap (R0-R8) added commands and flags to the CLI surface:
 *   aidr captchas, aidr schedule status|install|uninstall, aidr config check,
 *   aidr purge, --solve-captchas, --json, --older-than, --yes, --force.
 *
 * lib/args.js stays strict about them: a modifier that means nothing without its
 * mode is an error (a stray `--older-than 30d` on `aidr run` must not be
 * ignored while a REAL run starts), and --captchas refuses the other ways of
 * choosing which brokers run, because two selectors silently fighting each other
 * is how a filter ends up matching nothing. Every case runs against both the
 * util.parseArgs path and the hand-written fallback.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');

const { parseWatcherArgs, buildWatcherUsage, ArgError, FLAG_SPECS } = require('../lib/args');
const { resolveMode } = require('../lib/mode-dispatch');

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

const parse = (argv, parser, extra = {}) => parseWatcherArgs(argv, { parser, ...extra });

function assertArgError(fn, pattern) {
  assert.throws(fn, err => {
    assert.ok(err instanceof ArgError, `expected ArgError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.code, 'AIDR_ARGS');
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

for (const { name, parser } of PARSERS) {
  test(`[${name}] the new modes and switches parse on their own`, () => {
    assert.equal(parse(['--captchas'], parser).captchas, true);
    assert.equal(parse(['--solve-captchas'], parser).solveCaptchas, true);
    assert.equal(parse(['--schedule-status'], parser).scheduleStatus, true);
    assert.equal(parse(['--uninstall-scheduler'], parser).uninstallScheduler, true);
    assert.equal(parse(['--config-check'], parser).configCheck, true);
    assert.equal(parse(['--purge'], parser).purge, true);
  });

  test(`[${name}] everything defaults off`, () => {
    const a = parse([], parser);
    for (const key of ['captchas', 'solveCaptchas', 'scheduleStatus', 'uninstallScheduler', 'configCheck', 'purge', 'yes', 'force', 'json']) {
      assert.equal(a[key], false, `${key} should default to false`);
    }
    assert.equal(a.olderThan, null);
  });

  test(`[${name}] --purge takes --older-than, --yes, --force and --dry-run`, () => {
    const a = parse(['--purge', '--older-than', '90d', '--yes', '--force', '--dry-run'], parser);
    assert.equal(a.purge, true);
    assert.equal(a.olderThan, '90d');
    assert.equal(a.yes, true);
    assert.equal(a.force, true);
    assert.equal(a.dryRun, true);
  });

  test(`[${name}] --older-than needs a value`, () => {
    assertArgError(() => parse(['--purge', '--older-than'], parser), /--older-than.*value/);
    assertArgError(() => parse(['--purge', '--older-than', '--yes'], parser), /--older-than.*value/);
  });

  test(`[${name}] --older-than=30d works like --older-than 30d`, () => {
    assert.equal(parse(['--purge', '--older-than=30d'], parser).olderThan, '30d');
  });

  test(`[${name}] a purge modifier without --purge is an error, not silently ignored`, () => {
    assertArgError(() => parse(['--older-than', '30d'], parser), /--older-than.*--purge/);
    assertArgError(() => parse(['--yes'], parser), /--yes.*--purge/);
    assertArgError(() => parse(['--force'], parser), /--force.*--purge/);
  });

  test(`[${name}] --json only goes with --schedule-status`, () => {
    assert.equal(parse(['--schedule-status', '--json'], parser).json, true);
    assertArgError(() => parse(['--json'], parser), /--json.*--schedule-status/);
    assertArgError(() => parse(['--doctor', '--json'], parser), /--json.*--schedule-status/);
  });

  test(`[${name}] --captchas refuses every other way of choosing brokers`, () => {
    assert.equal(parse(['--captchas', '--dry-run'], parser).captchas, true);
    assertArgError(() => parse(['--captchas', '--only', 'Spokeo'], parser), /--captchas.*--only/);
    assertArgError(() => parse(['--captchas', '--skip', 'Spokeo'], parser), /--captchas.*--skip/);
    assertArgError(() => parse(['--captchas', '--retry-failed'], parser), /--captchas.*--retry-failed/);
    assertArgError(() => parse(['--captchas', '--resume'], parser), /--captchas.*--resume/);
    assertArgError(() => parse(['--captchas', '--pollute', '2'], parser), /--captchas.*--pollute/);
  });

  test(`[${name}] --solve-captchas combines with a normal run and with --captchas`, () => {
    const a = parse(['--solve-captchas', '--only', 'Spokeo'], parser);
    assert.equal(a.solveCaptchas, true);
    assert.equal(a.only, 'Spokeo');
    const b = parse(['--captchas', '--solve-captchas'], parser);
    assert.equal(b.captchas && b.solveCaptchas, true);
  });

  test(`[${name}] the confirmation inbox follows AIDR_HOME`, () => {
    const home = path.resolve('/srv/aidr-home');
    const withHome = parse(['--confirm-emails'], parser, { env: { AIDR_HOME: home } });
    assert.equal(withHome.confirmEmailsDir, path.join(home, 'inbox', 'confirms'));
    const without = parse(['--confirm-emails'], parser, { env: {} });
    assert.equal(without.confirmEmailsDir, './inbox/confirms');
  });

  test(`[${name}] an explicit directory beats AIDR_HOME`, () => {
    const a = parse(['--confirm-emails', '/tmp/mail'], parser, { env: { AIDR_HOME: '/srv/aidr-home' } });
    assert.equal(a.confirmEmailsDir, '/tmp/mail');
  });
}

test('--help describes every new flag', () => {
  const usage = buildWatcherUsage();
  for (const flag of ['--captchas', '--solve-captchas', '--schedule-status', '--uninstall-scheduler', '--config-check', '--purge', '--older-than', '--yes', '--force', '--json']) {
    assert.ok(usage.includes(flag), `--help should list ${flag}`);
  }
  for (const spec of FLAG_SPECS) assert.ok(spec.desc && spec.desc.length > 10, `${spec.flag} needs a real description`);
});

test('the new modes are mutually exclusive with every other mode', () => {
  const MODES = {
    captchas: 'captchas',
    scheduleStatus: 'schedule-status',
    uninstallScheduler: 'uninstall-scheduler',
    configCheck: 'config-check',
    purge: 'purge',
  };
  for (const [key, mode] of Object.entries(MODES)) {
    const alone = resolveMode({ [key]: true });
    assert.equal(alone.mode, mode);
    assert.equal(alone.conflict, null);
    for (const other of ['list', 'score', 'doctor', 'verify', 'know', 'installScheduler']) {
      const both = resolveMode({ [key]: true, [other]: true });
      assert.notEqual(both.conflict, null, `--${mode} with ${other} must conflict`);
    }
  }
  assert.notEqual(resolveMode({ purge: true, configCheck: true }).conflict, null);
  assert.notEqual(resolveMode({ scheduleStatus: true, uninstallScheduler: true }).conflict, null);
});
