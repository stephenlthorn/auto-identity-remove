/**
 * test/reverify.test.js
 *
 * Covers the quarantine / re-verification repair path (lib/reverify.js +
 * its consumers):
 *
 *   - flagForReverification flags ambiguous AUTOMATED entries and stamps
 *     needsReverify{since,reason}
 *   - it NEVER touches verified entries (verify-loop fields) or entries with
 *     manual provenance markers
 *   - names-restricted flagging matches composite "Broker|Person" keys by
 *     broker name and reports names with no matching entry
 *   - shouldSkip() never skips a flagged entry, even inside the 90-day window
 *   - recordSuccess() clears the flag
 *   - runVerify() re-searches a flagged entry immediately (bypassing the
 *     7-day and no-lastSuccess gates) and clears the flag on the outcome
 *   - the --reverify CLI flags entries on disk and honors --dry-run
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { flagForReverification, isVerifiedEntry, hasAutomatedRecord, brokerOfKey } = require('../lib/reverify');
const cfg = require('../lib/config');

// ── pure helpers ──────────────────────────────────────────────────────────────

test('isVerifiedEntry: verify-loop outcomes count as verified', () => {
  assert.equal(isVerifiedEntry({ verifiedDeletedAt: '2026-09-01T00:00:00Z' }), true);
  assert.equal(isVerifiedEntry({ verifiedStillListedAt: '2026-09-01T00:00:00Z' }), true);
  assert.equal(isVerifiedEntry({ verifyHistory: [{ at: 'x', outcome: 'verified_clear' }] }), true);
});

test('isVerifiedEntry: manual provenance markers count as verified', () => {
  assert.equal(isVerifiedEntry({ manual: true }), true);
  assert.equal(isVerifiedEntry({ manuallyVerified: true }), true);
  assert.equal(isVerifiedEntry({ verifiedBy: 'manual' }), true);
  assert.equal(isVerifiedEntry({ recordedBy: 'user' }), true);
  assert.equal(isVerifiedEntry({ source: 'Manual' }), true);
});

test('isVerifiedEntry: plain automated entries are not verified', () => {
  assert.equal(isVerifiedEntry({ lastSuccess: '2026-09-16T22:01:11Z' }), false);
  assert.equal(isVerifiedEntry({ lastAttempt: '2026-09-16T22:01:11Z', history: ['error'] }), false);
  assert.equal(isVerifiedEntry(null), false);
  assert.equal(isVerifiedEntry({}), false);
});

test('hasAutomatedRecord: entries the runner wrote are automated', () => {
  assert.equal(hasAutomatedRecord({ lastSuccess: 'x' }), true);
  assert.equal(hasAutomatedRecord({ lastAttempt: 'x' }), true);
  assert.equal(hasAutomatedRecord({ lastDetail: 'Not listed - nothing to remove' }), true);
  assert.equal(hasAutomatedRecord({ history: ['notFound'] }), true);
  assert.equal(hasAutomatedRecord({ pendingConfirm: { since: 'x' } }), true);
  assert.equal(hasAutomatedRecord({}), false);
  assert.equal(hasAutomatedRecord(null), false);
});

test('brokerOfKey: splits composite keys on the first pipe', () => {
  assert.equal(brokerOfKey('Spokeo'), 'Spokeo');
  assert.equal(brokerOfKey('Spokeo|Martin Kessler (work)'), 'Spokeo');
});

// ── flagForReverification ────────────────────────────────────────────────────

test('flags every ambiguous automated entry when no names are given', () => {
  const state = {
    optOuts: {
      'FastPeopleSearch': { lastAttempt: '2026-09-16T22:01:11Z', lastDetail: 'Not listed - nothing to remove' },
      'Spokeo':           { lastSuccess: '2026-09-16T22:01:33Z' },
    },
  };
  const res = flagForReverification(state, { now: '2026-09-18T00:00:00Z' });
  assert.deepEqual(res.flagged.sort(), ['FastPeopleSearch', 'Spokeo']);
  assert.equal(state.optOuts['FastPeopleSearch'].needsReverify.since, '2026-09-18T00:00:00Z');
  assert.ok(state.optOuts['Spokeo'].needsReverify.reason.length > 0);
});

test('NEVER flags verified or manually recorded entries', () => {
  const state = {
    optOuts: {
      'Ambiguous':  { lastAttempt: '2026-09-16T00:00:00Z' },
      'Verified':   { lastSuccess: '2026-09-16T00:00:00Z', verifiedDeletedAt: '2026-09-17T00:00:00Z' },
      'VerifyHist': { lastSuccess: '2026-09-16T00:00:00Z', verifyHistory: [{ at: 'x', outcome: 'still_listed' }] },
      'Manual':     { lastSuccess: '2026-09-16T00:00:00Z', verifiedBy: 'manual' },
      'StillListed':{ lastSuccess: '2026-09-16T00:00:00Z', verifiedStillListedAt: '2026-09-17T00:00:00Z' },
    },
  };
  const res = flagForReverification(state, {});
  assert.deepEqual(res.flagged, ['Ambiguous']);
  assert.deepEqual(res.verified.sort(), ['Manual', 'StillListed', 'Verified', 'VerifyHist'].sort());
  for (const k of ['Verified', 'VerifyHist', 'Manual', 'StillListed']) {
    assert.equal(state.optOuts[k].needsReverify, undefined, `${k} must not be flagged`);
  }
});

test('names restrict flagging and match composite keys by broker name', () => {
  const state = {
    optOuts: {
      'Spokeo|Martin Kessler (personal)': { lastAttempt: '2026-09-16T00:00:00Z' },
      'Spokeo|Anna Kessler':              { lastAttempt: '2026-09-16T00:00:00Z' },
      'Pipl|Martin Kessler (personal)':   { lastAttempt: '2026-09-16T00:00:00Z' },
    },
  };
  const res = flagForReverification(state, { names: ['spokeo'] });
  assert.deepEqual(res.flagged.sort(), ['Spokeo|Anna Kessler', 'Spokeo|Martin Kessler (personal)'].sort());
  assert.equal(state.optOuts['Pipl|Martin Kessler (personal)'].needsReverify, undefined);
});

test('names with no matching state entry are reported missing', () => {
  const state = { optOuts: { 'Spokeo': { lastAttempt: 'x' } } };
  const res = flagForReverification(state, { names: ['Spokeo', 'FastPeopleSearch'] });
  assert.deepEqual(res.missing, ['fastpeoplesearch']);
});

test('already-flagged entries are reported, not re-stamped', () => {
  const state = {
    optOuts: {
      'Spokeo': { lastAttempt: 'x', needsReverify: { since: '2026-09-16T00:00:00Z', reason: 'old' } },
    },
  };
  const res = flagForReverification(state, { now: '2026-09-18T00:00:00Z' });
  assert.deepEqual(res.flagged, []);
  assert.deepEqual(res.alreadyFlagged, ['Spokeo']);
  assert.equal(state.optOuts['Spokeo'].needsReverify.since, '2026-09-16T00:00:00Z', 'original stamp preserved');
});

test('verified entries named explicitly are reported as protected, not flagged', () => {
  const state = {
    optOuts: {
      'Spokeo': { lastSuccess: 'x', verifiedDeletedAt: '2026-09-17T00:00:00Z' },
    },
  };
  const res = flagForReverification(state, { names: ['Spokeo'] });
  assert.deepEqual(res.flagged, []);
  assert.deepEqual(res.verified, ['Spokeo']);
  assert.equal(state.optOuts['Spokeo'].needsReverify, undefined);
});

// ── consumer: shouldSkip ─────────────────────────────────────────────────────

function withTmpState(fn, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-reverify-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(seed || { optOuts: {} }, null, 2));
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();
  try {
    fn({ dir, stateFile });
  } finally {
    cfg.setTestStatePath(null);
    cfg.resetState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('shouldSkip: a flagged entry is never skipped, even inside the 90-day window', () => {
  const recent = new Date(Date.now() - 5 * 86400000).toISOString();
  withTmpState(() => {
    const state = cfg.loadState();
    state.optOuts['Spokeo'] = {
      lastSuccess: recent,
      needsReverify: { since: new Date().toISOString(), reason: 'ambiguous' },
    };
    state.optOuts['Pipl'] = { lastSuccess: recent };

    assert.equal(cfg.shouldSkip('Spokeo'), null, 'flagged entry must be re-attempted');
    assert.ok(cfg.shouldSkip('Pipl'), 'unflagged recent entry still skips normally');
  });
});

test('recordSuccess: a fresh success clears the quarantine flag', () => {
  withTmpState(({ stateFile }) => {
    const state = cfg.loadState();
    state.optOuts['Spokeo'] = {
      lastAttempt: '2026-09-16T00:00:00Z',
      needsReverify: { since: '2026-09-16T00:00:00Z', reason: 'ambiguous' },
    };
    cfg.recordSuccess('Spokeo');
    assert.equal(state.optOuts['Spokeo'].needsReverify, undefined, 'flag cleared by fresh success');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(onDisk.optOuts['Spokeo'].needsReverify, undefined, 'cleared flag persisted');
  });
});

test('recordFailure: a failure does NOT clear the flag (still unresolved)', () => {
  withTmpState(() => {
    const state = cfg.loadState();
    state.optOuts['Spokeo'] = {
      needsReverify: { since: '2026-09-16T00:00:00Z', reason: 'ambiguous' },
    };
    cfg.recordFailure('Spokeo', 'error');
    assert.ok(state.optOuts['Spokeo'].needsReverify, 'flag survives a fresh failure');
  });
});

// ── consumer: runVerify ──────────────────────────────────────────────────────

const { runVerify } = require('../lib/verify-loop');

const SEARCH_BROKER = {
  name: 'FastPeopleSearch',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  listingPattern: /listing/,
};
const VERIFY_PERSON = { firstName: 'Test', lastName: 'User' };

function fakeContext() {
  return { newPage: async () => ({ close: async () => {} }) };
}

test('runVerify: a flagged entry is re-searched immediately (7-day gate bypassed)', async () => {
  const recent = new Date(Date.now() - 2 * 86400000).toISOString(); // 2d ago - normally gated
  const state = {
    optOuts: {
      'FastPeopleSearch': {
        lastSuccess: recent,
        needsReverify: { since: new Date().toISOString(), reason: 'ambiguous' },
      },
    },
  };
  const result = await runVerify(fakeContext(), [SEARCH_BROKER], [VERIFY_PERSON], {
    state,
    findUrl: async () => null, // listing absent
  });
  assert.equal(result.verified_clear.length, 1, 'flagged entry must be searched, not skipped');
  assert.equal(state.optOuts['FastPeopleSearch'].needsReverify, undefined, 'flag cleared by verification');
  assert.ok(state.optOuts['FastPeopleSearch'].verifiedDeletedAt);
});

test('runVerify: an unflagged recent entry is still gated (flag is what unlocks it)', async () => {
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const state = { optOuts: { 'FastPeopleSearch': { lastSuccess: recent } } };
  const result = await runVerify(fakeContext(), [SEARCH_BROKER], [VERIFY_PERSON], {
    state,
    findUrl: async () => null,
  });
  assert.equal(result.verified_clear.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('runVerify: a flagged entry with no lastSuccess is searched (not skipped)', async () => {
  const state = {
    optOuts: {
      'FastPeopleSearch': {
        lastAttempt: '2026-09-16T00:00:00Z',
        needsReverify: { since: '2026-09-16T00:00:00Z', reason: 'ambiguous' },
      },
    },
  };
  let searched = false;
  const result = await runVerify(fakeContext(), [SEARCH_BROKER], [VERIFY_PERSON], {
    state,
    findUrl: async () => { searched = true; return 'https://example.com/listing/1'; },
  });
  assert.equal(searched, true, 'flagged entry must be searched even without lastSuccess');
  assert.equal(result.still_listed.length, 1);
  assert.equal(state.optOuts['FastPeopleSearch'].needsReverify, undefined);
});

// ── CLI: --reverify ──────────────────────────────────────────────────────────

const REPO = path.join(__dirname, '..');

function buildTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-watcher-'));
  fs.copyFileSync(path.join(REPO, 'watcher.js'), path.join(dir, 'watcher.js'));
  fs.cpSync(path.join(REPO, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'brokers.js'), path.join(dir, 'brokers.js'));
  return dir;
}

function runWatcher(dir, args) {
  return execFileSync('node', ['watcher.js', ...args], {
    cwd: dir,
    env: { ...process.env, HEADLESS: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('--reverify flags ambiguous entries on disk and protects verified ones', () => {
  const dir = buildTempRepo();
  try {
    const state = {
      optOuts: {
        'FastPeopleSearch': { lastAttempt: '2026-09-16T22:01:11Z', lastDetail: 'Not listed - nothing to remove' },
        'Manual':           { lastSuccess: '2026-09-16T00:00:00Z', verifiedBy: 'manual' },
      },
    };
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state));

    const out = runWatcher(dir, ['--reverify']);
    assert.match(out, /Flagged for re-verification/);
    assert.match(out, /FastPeopleSearch/);
    assert.match(out, /Manual/, 'protected entry should be listed as untouched');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(onDisk.optOuts['FastPeopleSearch'].needsReverify, 'flag persisted to state.json');
    assert.equal(onDisk.optOuts['Manual'].needsReverify, undefined, 'manual entry untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--reverify <names> scopes the repair and reports missing names', () => {
  const dir = buildTempRepo();
  try {
    const state = {
      optOuts: {
        'Spokeo': { lastAttempt: '2026-09-16T22:01:33Z' },
        'Pipl':   { lastAttempt: '2026-09-16T22:01:33Z' },
      },
    };
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state));

    const out = runWatcher(dir, ['--reverify', 'Spokeo,FastPeopleSearch']);
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(onDisk.optOuts['Spokeo'].needsReverify, 'named broker flagged');
    assert.equal(onDisk.optOuts['Pipl'].needsReverify, undefined, 'unnamed broker untouched');
    assert.match(out, /No state entry found for: fastpeoplesearch/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--reverify --dry-run reports but writes nothing', () => {
  const dir = buildTempRepo();
  try {
    const state = { optOuts: { 'Spokeo': { lastAttempt: '2026-09-16T00:00:00Z' } } };
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state));

    const out = runWatcher(dir, ['--reverify', '--dry-run']);
    assert.match(out, /dry run/i);
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.optOuts['Spokeo'].needsReverify, undefined, 'dry-run must not persist flags');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
