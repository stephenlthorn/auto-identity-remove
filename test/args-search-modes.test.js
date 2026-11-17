/**
 * S9: flag leftovers. `--scan` and `--verify` search and submit nothing, so the run
 * modifiers that only mean something to an opt-out run are refused with them instead of
 * being ignored (--pollute 3 printed "NOISE MODE - 3 bogus record(s) will be submitted" in a
 * mode that submits nothing). The `--found-only` refusals must be true for every mode, and
 * --found-only with --pollute is refused: noise goes to every acceptsBogus broker whatever
 * the scan says.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWatcherArgs, ArgError } = require('../lib/args');
const { resolveCommand } = require('../lib/cli-map');

const parse = (...argv) => parseWatcherArgs(argv, { env: {} });

const MEANINGLESS = [
  ['--pollute', '3'],
  ['--resume'],
  ['--solve-captchas'],
  ['--snapshot'],
  ['--preview', '--fields'],
];

for (const mode of ['--scan', '--verify']) {
  for (const extra of MEANINGLESS) {
    const flag = extra[extra.length - 1].startsWith('--') ? extra[extra.length - 1] : extra[0];
    test(`${mode} refuses ${extra.join(' ')}: it submits nothing, so that flag would be ignored`, () => {
      assert.throws(
        () => parse(mode, ...extra),
        (err) => err instanceof ArgError
          && err.message.includes(`${flag} cannot be combined with ${mode}`)
          && /submit/.test(err.message),
      );
    });
  }

  test(`${mode} still takes --only, --skip and --dry-run`, () => {
    const r = parse(mode, '--only', 'Spokeo', '--skip', 'Nuwber', '--dry-run');
    assert.equal(r.only, 'Spokeo');
    assert.equal(r.dryRun, true);
  });
}

test('the same refusals reach `aidr scan` through the command map', () => {
  const r = resolveCommand(['scan', '--pollute', '3']);
  assert.equal(r.ok, false);
  assert.match(r.error, /--pollute cannot be combined with --scan/);
});

test('an ordinary run still takes the run modifiers', () => {
  const r = parse('--pollute', '3', '--snapshot', '--resume');
  assert.equal(r.pollute, 3);
  assert.equal(r.snapshot, true);
  assert.equal(r.resume, true);
});

test('--found-only with --pollute is refused, and says why', () => {
  assert.throws(
    () => parse('--found-only', '--pollute', '2'),
    (err) => err instanceof ArgError && /--found-only cannot be combined with --pollute/.test(err.message) && /scan/.test(err.message),
  );
});

test('the --found-only refusal never claims a mode "does not submit anything" when it does', () => {
  for (const flag of ['--know', '--confirm-emails']) {
    const err = (() => { try { parse('--found-only', flag); } catch (e) { return e; } return null; })();
    assert.ok(err instanceof ArgError, flag);
    assert.match(err.message, new RegExp(`--found-only cannot be combined with ${flag}`));
    assert.doesNotMatch(err.message, /does not submit anything/, flag);
  }
});

test('the --found-only refusal for every other mode is still a refusal, with the same true wording', () => {
  for (const flag of ['--scan', '--verify', '--serp-scan', '--list', '--score', '--report', '--doctor']) {
    assert.throws(() => parse('--found-only', flag), /--found-only cannot be combined with .*opt-out run/, flag);
  }
});
