/**
 * `aidr scan` and `aidr run --found-only`, end to end through the real watcher.js in the
 * sandbox (fake browser that refuses to navigate, no network, stubbed notifiers).
 *
 * The fake browser makes every search page fail to load, which is exactly the
 * "could not tell" case: it lets these tests prove a failed search is never recorded as
 * "not listed", and that a scan never reaches an opt-out page. The pure decision
 * (found / not_found / unknown / stale) is covered in scan-record.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createSandbox, runWatcher, runnableConfig } = require('./helpers/watcher-sandbox');
const brokers = require('../brokers');
const { personFingerprint, searchHash } = require('../lib/identity');

const day = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();

const ADA = { firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', city: 'Austin', state: 'TX', zip: '78701', country: 'US', email: 'ada@lovelace-test.example', phone: '5125550101', phoneFormatted: '(512) 555-0101' };
const oneAda = (extra = {}) => runnableConfig({ persons: [ADA], ...extra });

const withoutQuery = (url) => String(url).replace(/[?#].*$/, '');
const adaBroker = (name) => brokers.forPerson(ADA).find(b => b.name === name);
// A scan is trusted only for the search it was made with, so fixtures carry that search's hash (S1).
const shOf = (name) => searchHash(adaBroker(name).searchUrl);

async function inSandbox(options, fn) {
  const sandbox = createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

const gotos = (sandbox) => sandbox.fakeEvents().filter(e => e.event === 'goto').map(e => e.url);

// ── aidr scan ────────────────────────────────────────────────────────────────

test('scan: a search page that cannot load is recorded as "could not tell", never "not found"', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--scan']);
    assert.equal(r.code, 2, 'nothing could be told, so it does not look like a clean scan');
    assert.match(r.stdout, /could not tell : 6/);
    assert.match(r.stdout, /not found      : 0/);
    assert.match(r.stdout, /Could not tell \(not the same as not listed\)/);
    assert.match(r.stdout, /cannot search  : \d+ broker/);

    const scans = sandbox.readState().scans;
    assert.deepEqual(Object.values(scans).map(s => s.outcome), Array(6).fill('unknown'));
    assert.ok(Object.keys(scans).includes('Spokeo'), 'single person: keyed by the bare broker name, like the opt-outs');
    for (const s of Object.values(scans)) assert.ok(s.reason && s.at, 'every result says why and when');
  });
});

test('scan: submits nothing, sends nothing, and only ever opens search pages', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    await runWatcher(sandbox, ['--scan']);
    const searchPages = new Set(brokers.forPerson(ADA).filter(b => b.searchUrl).map(b => withoutQuery(b.searchUrl)));
    const opened = gotos(sandbox);
    assert.ok(opened.length > 0);
    for (const url of opened) assert.ok(searchPages.has(url), `${url} is not a search page`);
    assert.deepEqual(sandbox.readState().optOuts, {}, 'the opt-out history is untouched');
    assert.deepEqual(sandbox.runLogs(), [], 'a scan writes no run log');
    assert.equal(sandbox.fakeEvents().filter(e => e.event === 'fetch').length, 0, 'no relay, no network of its own');
    assert.equal(fs.existsSync(sandbox.lock), false, 'the lock is released');
  });
});

test('scan: --only narrows it, and each person is scanned under their own key', async () => {
  await inSandbox({}, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--scan', '--only', 'Spokeo']);
    assert.equal(r.code, 2);
    assert.deepEqual(Object.keys(sandbox.readState().scans).sort(), ['Spokeo|Ada Lovelace', 'Spokeo|Alan Turing']);
    assert.equal(gotos(sandbox).length, 2);
  });
});

test('scan: --dry-run saves nothing', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    const before = fs.readFileSync(sandbox.state, 'utf8');
    const r = await runWatcher(sandbox, ['--scan', '--dry-run', '--only', 'Spokeo']);
    assert.match(r.stdout, /Dry run: results not saved/);
    assert.equal(fs.readFileSync(sandbox.state, 'utf8'), before);
  });
});

// ── searches that can load ───────────────────────────────────────────────────
// The fake browser cannot load a page, so a preload answers the SEARCH step: it replaces
// findListingUrl with one that returns a listing URL for the brokers named in
// AIDR_TEST_LISTED and "no listing" for every other. Everything after that is the real
// watcher: the scan, the state file, the run, the verify summary.

function withSearchAnswers(sandbox, listed) {
  const preload = `${sandbox.dir}/search-answers.js`;
  fs.writeFileSync(preload, `
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      const loaded = load.apply(this, arguments);
      if (/(^|\\/)forms$/.test(request) && loaded && loaded.findListingUrl && !loaded.__answers) {
        loaded.__answers = true;
        const listed = new Set((process.env.AIDR_TEST_LISTED || '').split(',').filter(Boolean));
        loaded.findListingUrl = async (page, broker) => (listed.has(broker.name) ? 'https://listing.example/Ada-Lovelace/Austin-TX/' + broker.name + '-p123456789' : null);
      }
      return loaded;
    };
  `);
  return { env: { NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --require ${preload}`, AIDR_TEST_LISTED: listed.join(',') } };
}

test('scan then run --found-only: found is submitted, not found is skipped, and the scan itself submits nothing', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    const answers = withSearchAnswers(sandbox, ['Spokeo']);

    const scan = await runWatcher(sandbox, ['--scan'], answers);
    assert.equal(scan.code, 0, scan.stderr);
    assert.match(scan.stdout, /found          : 1/);
    assert.match(scan.stdout, /not found      : 1/, 'only USPhonebook has a search step validated live');
    assert.match(scan.stdout, /not validated  : 4/);
    // The sandbox's stdout is a pipe, not a terminal: the listing address holds the person's name,
    // so only its host is printed (S11) and the full address is kept in the state file.
    assert.match(scan.stdout, /Where you were found:\n\s+- Spokeo: listing\.example\n/);
    assert.match(scan.stdout, /full listing URLs are in .*state\.json/);
    assert.doesNotMatch(scan.stdout, /Ada-Lovelace|Austin-TX|p123456789/, 'no part of a listing path reaches stdout');
    assert.match(scan.stdout, /Where you were not found:\n\s+USPhonebook\n/);
    assert.match(scan.stdout, /search is not validated:\n\s+.*Nuwber/);
    assert.deepEqual(gotos(sandbox), [], 'a scan opens no opt-out page (the search was answered by the preload)');
    const scans = sandbox.readState().scans;
    assert.equal(scans.Spokeo.outcome, 'found');
    assert.equal(scans.Spokeo.listingUrl, 'https://listing.example/Ada-Lovelace/Austin-TX/Spokeo-p123456789');
    assert.equal(scans.USPhonebook.outcome, 'not_found');

    const run = await runWatcher(sandbox, ['--found-only', '--only', 'Spokeo,USPhonebook'], answers);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\[USPhonebook\] skipped - not listed \(scan of \d{4}-\d{2}-\d{2}\)/);
    const opened = gotos(sandbox);
    assert.ok(opened.some(u => u.includes('spokeo.com')), 'the found broker was submitted to');
    assert.ok(!opened.some(u => u.includes('usphonebook.com')), 'the not_found broker was left alone');
  });
});

test('verify: an empty search is "never seen" with no sighting and "verified_clear" with one (a scan, or a search-form submission)', async () => {
  // Spokeo is a search-form broker: its run searched before it submitted, so its lastSuccess is a
  // sighting even with no scan record (state from before 2.2). USPhonebook submits without looking and
  // has no scan: never seen. Nuwber has a scan that saw a listing.
  const state = { optOuts: {
    Spokeo: { lastSuccess: daysAgo(10), lastAttempt: daysAgo(10) },
    USPhonebook: { lastSuccess: daysAgo(10), lastAttempt: daysAgo(10) },
    Nuwber: { lastSuccess: daysAgo(10), lastAttempt: daysAgo(10) },
  }, scans: { Nuwber: { at: daysAgo(20), outcome: 'found', lastFoundAt: daysAgo(20), listingUrl: 'https://listing.example/Nuwber', sh: shOf('Nuwber') } } };
  await inSandbox({ config: oneAda(), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--verify'], withSearchAnswers(sandbox, []));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /verified_clear : 2/);
    assert.match(r.stdout, /never_seen     : 1/);
    assert.match(r.stdout, /Never seen \(nothing there now[^\n]*\n\s+- USPhonebook/);
    const after = sandbox.readState().optOuts;
    assert.ok(after.Spokeo.verifiedDeletedAt, 'a search-form submission was itself a sighting');
    assert.ok(after.Nuwber.verifiedDeletedAt, 'seen by a scan, gone now: a removal');
    assert.ok(after.USPhonebook.verifiedAbsentAt, 'never seen: recorded apart');
    assert.equal(after.USPhonebook.verifiedDeletedAt, undefined);
  });
});

// ── aidr run --found-only ────────────────────────────────────────────────────

test('found-only: refuses to start when no scan has ever been recorded, and opens no browser', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Run `aidr scan` first/);
    assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'launch'), []);
    assert.equal(fs.existsSync(sandbox.lock), false);
  });
});

test('found-only: a sighting made by an ordinary run is not a scan, so it still refuses', async () => {
  const state = { optOuts: {}, scans: { Spokeo: { at: daysAgo(1), outcome: 'found', source: 'run', listingUrl: 'https://www.spokeo.com/x' } } };
  await inSandbox({ config: oneAda(), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only']);
    assert.equal(r.code, 1);
  });
});

test('found-only: with only stale or could-not-tell results it refuses, and opens no browser (S2)', async () => {
  // Scanned on day 0, run on day 31 with the default config used to be a full run whose only
  // line was "Filter applied - N broker(s) will run".
  const state = { optOuts: {}, scans: {
    Spokeo: { at: daysAgo(31), outcome: 'found', listingUrl: 'https://www.spokeo.com/x', fp: personFingerprint(ADA), sh: shOf('Spokeo') },
    USPhonebook: { at: daysAgo(1), outcome: 'unknown', reason: 'search failed: bot wall', fp: personFingerprint(ADA), sh: shOf('USPhonebook') },
  } };
  await inSandbox({ config: oneAda(), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no usable scan result/);
    assert.match(r.stderr, /Run `aidr scan` first/);
    assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'launch'), []);
  });
});

test('found-only: says per person what the scan gave it to go by, and when one person has nothing usable (S2)', async () => {
  const ALAN = runnableConfig().persons[1];
  const state = { optOuts: {}, scans: {
    'USPhonebook|Ada Lovelace': { at: daysAgo(2), outcome: 'not_found', fp: personFingerprint(ADA), sh: shOf('USPhonebook') },
  } };
  await inSandbox({ config: runnableConfig({ persons: [ADA, ALAN] }), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only', '--only', 'USPhonebook']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--found-only for Ada Lovelace: 0 listed \(submitted\), 1 not listed \(skipped\)\./);
    assert.match(r.stdout, /--found-only for Alan Turing: 0 listed \(submitted\), 0 not listed \(skipped\)\./);
    assert.match(r.stdout, /Alan Turing has no usable scan result[^\n]*run `aidr scan` again/);
    assert.doesNotMatch(r.stdout, /Ada Lovelace has no usable scan result/);
  });
});

test('found-only: found is submitted, not_found is skipped with its reason, an unscanned broker follows scan.unknown', async () => {
  const state = { optOuts: {}, scans: {
    Spokeo: { at: daysAgo(2), outcome: 'found', listingUrl: 'https://www.spokeo.com/Ada-Lovelace', fp: personFingerprint(ADA), sh: shOf('Spokeo') },
    USPhonebook: { at: '2026-11-10T08:00:00.000Z', outcome: 'not_found', fp: personFingerprint(ADA), sh: shOf('USPhonebook') },
  } };
  // not_found is only fresh relative to now: pin the scan inside the default 30 days.
  state.scans.USPhonebook.at = daysAgo(3);

  await inSandbox({ config: oneAda({ scan: { unknown: 'skip' } }), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only', '--only', 'Spokeo,USPhonebook,Nuwber']);
    assert.equal(r.code, 0, r.stderr);

    const opened = gotos(sandbox);
    assert.ok(opened.some(u => u.includes('spokeo.com')), 'the found broker was attempted');
    assert.ok(!opened.some(u => u.includes('usphonebook.com')), 'the not_found broker was not touched');
    assert.ok(!opened.some(u => u.includes('nuwber.com')), 'the unscanned broker was skipped (scan.unknown is skip)');

    const [logName] = sandbox.runLogs();
    const log = JSON.parse(fs.readFileSync(`${sandbox.logs}/${logName}`, 'utf8'));
    const skipped = Object.fromEntries(log.skipped.map(s => [s.broker, s.detail]));
    assert.match(skipped.USPhonebook, /not listed \(scan of \d{4}-\d{2}-\d{2}\)/);
    assert.match(skipped.Nuwber, /never scanned/);
    assert.equal(log.partial, true, 'a filtered run is partial');
    assert.equal(log.filter.foundOnly, true);
  });
});

test('found-only: with scan.unknown "submit" (the default) an unscanned broker still runs', async () => {
  const state = { optOuts: {}, scans: { USPhonebook: { at: daysAgo(2), outcome: 'not_found', fp: personFingerprint(ADA), sh: shOf('USPhonebook') } } };
  await inSandbox({ config: oneAda(), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only', '--only', 'USPhonebook,Nuwber']);
    assert.equal(r.code, 0, r.stderr);
    const opened = gotos(sandbox);
    assert.ok(!opened.some(u => u.includes('usphonebook.com')));
    assert.ok(opened.some(u => u.includes('nuwber.com')));
  });
});

test('found-only with scan.unknown "skip": the email and generic passes are skipped, in one line', async () => {
  const state = { optOuts: {}, scans: { Spokeo: { at: daysAgo(2), outcome: 'found', listingUrl: 'https://www.spokeo.com/x', fp: personFingerprint(ADA), sh: shOf('Spokeo') } } };
  await inSandbox({ config: oneAda({ scan: { unknown: 'skip' } }), state }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--found-only']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n').filter(l => /cannot be searched, so scan\.unknown/.test(l));
    assert.equal(lines.length, 1, 'said once, not once per pass');
    assert.equal(sandbox.fakeEvents().filter(e => e.event === 'dns').length, 0, 'the generic pass looked nothing up');
  });
});

test('found-only with scan.unknown "submit": the generic pass runs, and says nothing about leaving it out', async () => {
  const state = { optOuts: {}, scans: { Spokeo: { at: daysAgo(2), outcome: 'found', listingUrl: 'https://www.spokeo.com/x', fp: personFingerprint(ADA), sh: shOf('Spokeo') } } };
  await inSandbox({ config: oneAda(), state }, async (sandbox) => {
    // No --only: --only Spokeo would exclude the generic pass anyway and prove nothing.
    const r = await runWatcher(sandbox, ['--found-only'], { timeoutMs: 120000 });
    // Every broker errors against the fake browser, which makes the exit code 1 by design.
    assert.equal(r.timedOut, false);
    assert.doesNotMatch(r.stderr, /Fatal/);
    assert.doesNotMatch(r.stdout, /cannot be searched, so scan\.unknown/);
    assert.ok(sandbox.fakeEvents().filter(e => e.event === 'dns').length > 0, 'the generic pass looked hosts up');
  });
});

test('found-only is refused with --resume, and refused with --captchas, each on its own', async () => {
  await inSandbox({ config: oneAda() }, async (sandbox) => {
    for (const flag of ['--resume', '--captchas']) {
      const r = await runWatcher(sandbox, ['--found-only', flag]);
      assert.notEqual(r.code, 0, flag);
      assert.match(r.stderr, new RegExp(`--found-only cannot be combined with ${flag}`), flag);
      assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'launch'), [], `${flag}: nothing started`);
    }
  });
});

test('a bad scan section in the config is refused before anything runs', async () => {
  await inSandbox({ config: oneAda({ scan: { unknown: 'skp' } }) }, async (sandbox) => {
    const r = await runWatcher(sandbox, ['--scan']);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /scan\.unknown must be "submit" or "skip"/);
    assert.deepEqual(sandbox.fakeEvents().filter(e => e.event === 'launch'), []);
  });
});
