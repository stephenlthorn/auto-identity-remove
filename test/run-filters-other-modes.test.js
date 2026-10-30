/**
 * test/run-filters-other-modes.test.js
 *
 * CLI2-8: --only / --skip became one include test for the opt-out run (CORE-4), but
 * five other places that act on the broker list never got it. `--only X --pollute 1`
 * sent bogus records to every acceptsBogus broker, `--know --only X` mailed a
 * right-to-know request to every email broker, and --verify, --serp-scan and
 * --serp-watch went through the whole list. A filter that is silently ignored is
 * worse than none: it looks as if it narrowed the work.
 *
 * Every one of them now honours --only and --skip. --retry-failed means "what the
 * last run log recorded as failed", which none of --know, --verify, --serp-scan or
 * --serp-watch reads, so it is refused with them instead of being ignored.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { parseWatcherArgs, ArgError } = require('../lib/args');
const { createSandbox, runWatcher } = require('./helpers/watcher-sandbox');

const PRELOAD = path.join(__dirname, 'helpers', 'cli2-preload.js');
const BOGUS_BROKERS = ['ThatsThem', 'SearchPeopleFree', 'PeopleSearchNow', 'InfoTracer'];
const EMAIL_BROKERS = ['Spokeo (email)', 'Hiya', 'Eyecon', 'Pipl'];

async function inSandbox(fn) {
  const sandbox = createSandbox();
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

function spying(sandbox) {
  const log = path.join(sandbox.dir, 'cli2.log');
  return {
    env: { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${PRELOAD}`, AIDR_TEST_LOG: log, AIDR_TEST_SPY: '1' },
    events: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  };
}

const noiseLines = (stdout) => stdout.split('\n').filter(l => /noise (error|success|skipped|dry)|🎭/.test(l));
const mentions = (text, names) => names.filter(name => text.includes(`[${name}]`));

// ── --pollute ────────────────────────────────────────────────────────────────

test('--only X --pollute sends noise to X alone', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'ThatsThem', '--pollute', '1', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Noise mode - submitting 1 bogus record\(s\) to 1 broker\(s\)/);
    assert.deepEqual(mentions(noiseLines(r.stdout).join('\n'), BOGUS_BROKERS), ['ThatsThem'], 'no other broker got a bogus record');
  });
});

test('--skip X --pollute leaves X out of the noise', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--skip', 'ThatsThem', '--pollute', '1', '--dry-run'], { timeoutMs: 120000 });
    assert.match(r.stdout, /Noise mode - submitting 1 bogus record\(s\) to 3 broker\(s\)/);
    assert.deepEqual(mentions(noiseLines(r.stdout).join('\n'), BOGUS_BROKERS).sort(), ['InfoTracer', 'PeopleSearchNow', 'SearchPeopleFree']);
  });
});

test('--only with no acceptsBogus broker in it says the filter left nothing, and sends no noise', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--only', 'Radaris', '--pollute', '1', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--pollute: no brokers tagged acceptsBogus: true that match the filter - nothing to do/);
    assert.deepEqual(noiseLines(r.stdout), []);
  });
});

test('--pollute with no filter still goes to every acceptsBogus broker', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--pollute', '1', '--dry-run'], { timeoutMs: 120000 });
    assert.match(r.stdout, /Noise mode - submitting 1 bogus record\(s\) to 4 broker\(s\)/);
    assert.deepEqual(mentions(noiseLines(r.stdout).join('\n'), BOGUS_BROKERS).sort(), [...BOGUS_BROKERS].sort());
  });
});

// ── --know ───────────────────────────────────────────────────────────────────

test('--know --only Hiya mails one broker, not every email broker', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know', '--only', 'Hiya', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 email broker\(s\) x 2 person\(s\)/);
    assert.deepEqual(mentions(r.stdout, EMAIL_BROKERS), ['Hiya']);
  });
});

test('--know --skip Hiya mails the other email brokers only', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know', '--skip', 'Hiya', '--dry-run']);
    assert.match(r.stdout, /3 email broker\(s\) x 2 person\(s\)/);
    assert.deepEqual(mentions(r.stdout, EMAIL_BROKERS).sort(), ['Eyecon', 'Pipl', 'Spokeo (email)']);
  });
});

test('--know with no filter is unchanged: every email broker', async () => {
  await inSandbox(async (sandbox) => {
    const r = await runWatcher(sandbox, ['--know', '--dry-run']);
    assert.match(r.stdout, /4 email broker\(s\) x 2 person\(s\)/);
  });
});

// ── --verify ─────────────────────────────────────────────────────────────────

test('--verify --only X checks X for each person, not every broker', async () => {
  await inSandbox(async (sandbox) => {
    const all = await runWatcher(sandbox, ['--verify']);
    const allSkipped = Number(all.stdout.match(/skipped\s+: (\d+)/)[1]);
    const one = await runWatcher(sandbox, ['--verify', '--only', 'Radaris']);
    assert.equal(one.code, 0, one.stderr);
    assert.equal(Number(one.stdout.match(/skipped\s+: (\d+)/)[1]), 2, 'one broker x two persons');
    assert.ok(allSkipped > 2, 'and the unfiltered verify really covers more');
  });
});

test('--verify --skip X leaves X out', async () => {
  await inSandbox(async (sandbox) => {
    const all = await runWatcher(sandbox, ['--verify']);
    const skip = await runWatcher(sandbox, ['--verify', '--skip', 'Radaris']);
    const count = (r) => Number(r.stdout.match(/skipped\s+: (\d+)/)[1]);
    assert.equal(count(skip), count(all) - 2);
  });
});

// ── --serp-scan / --serp-watch ───────────────────────────────────────────────

test('--serp-scan --only X looks for X alone, and --serp-watch too', async () => {
  await inSandbox(async (sandbox) => {
    const spy = spying(sandbox);
    await runWatcher(sandbox, ['--serp-scan', '--only', 'Radaris,Intelius', '--dry-run'], { env: spy.env });
    await runWatcher(sandbox, ['--serp-watch', '--skip', 'Radaris', '--dry-run'], { env: spy.env });
    const seen = spy.events().filter(e => e.event === 'serp-brokers');
    const scan = seen.find(e => e.via === 'scan');
    const watch = seen.find(e => e.via === 'watch');
    assert.deepEqual(scan.names.sort(), ['Intelius', 'Radaris']);
    assert.ok(watch.names.length > 10 && !watch.names.includes('Radaris'), '--skip removed Radaris from the watch');
  });
});

// ── --retry-failed has no log to read in these modes ─────────────────────────

const PARSERS = [{ name: 'hand-written', parser: 'manual' }];
if (typeof util.parseArgs === 'function') PARSERS.unshift({ name: 'util.parseArgs', parser: 'util' });

for (const { name, parser } of PARSERS) {
  test(`[${name}] --retry-failed is refused with --know, --verify, --serp-scan and --serp-watch`, () => {
    for (const mode of ['--know', '--verify', '--serp-scan', '--serp-watch']) {
      assert.throws(() => parseWatcherArgs([mode, '--retry-failed'], { parser }), (err) => {
        assert.ok(err instanceof ArgError);
        assert.match(err.message, new RegExp(`--retry-failed.*${mode}|${mode}.*--retry-failed`));
        return true;
      }, mode);
    }
  });

  test(`[${name}] --only and --skip parse with those modes`, () => {
    for (const mode of ['--know', '--verify', '--serp-scan', '--serp-watch']) {
      assert.doesNotThrow(() => parseWatcherArgs([mode, '--only', 'A', '--skip', 'B'], { parser }), mode);
    }
    assert.doesNotThrow(() => parseWatcherArgs(['--retry-failed'], { parser }), 'a run still takes it');
  });
}
