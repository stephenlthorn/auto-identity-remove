/**
 * test/config-state-quarantine.test.js
 *
 * CFG-6: a corrupt state.json with no valid .bak silently became an empty state
 * and the next save overwrote the corrupt file (and the .bak) - the user's whole
 * opt-out history gone, with no warning and nothing left to recover from. The
 * unreadable file is now copied to state.json.corrupt-<timestamp> (0600) and a
 * loud warning is printed. Nothing is silently discarded.
 *
 * Also: the EBUSY/EXDEV in-place fallback gives up crash safety, and says so once.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cfg = require('../lib/config');

const ROOT = path.join(__dirname, '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-quarantine-'));
}

function quarantined(dir) {
  return fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
}

function captureWarnings(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.warn = real; }
  return lines;
}

const TRUNCATED = '{"optOuts":{"Spokeo":{"lastSuccess":"2026-10-01T00:00:0';
const GOOD = { optOuts: { Spokeo: { lastSuccess: '2026-10-01T00:00:00.000Z' } } };

test('resetState quarantines a corrupt state.json that has no valid .bak, and warns', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  cfg.setTestStatePath(target);
  try {
    const warnings = captureWarnings(() => cfg.resetState());

    assert.deepEqual(cfg.loadState().optOuts, {}, 'the in-memory state starts empty');
    const q = quarantined(dir);
    assert.equal(q.length, 1, 'the corrupt file is kept, not discarded');
    assert.equal(fs.readFileSync(path.join(dir, q[0]), 'utf8'), TRUNCATED, 'byte-for-byte');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, q[0])).mode & 0o077, 0, 'quarantine copy is private (0600)');
    }
    assert.ok(warnings.some(w => /corrupt/i.test(w) && w.includes(q[0])), `warned loudly, got: ${warnings.join(' | ')}`);
    assert.ok(warnings.some(w => /re-?submit|empty|history/i.test(w)), 'the warning says what the consequence is');
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState after a corrupt load leaves the quarantined copy intact', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  cfg.setTestStatePath(target);
  try {
    captureWarnings(() => cfg.resetState());
    cfg.recordSuccess('Whitepages', 'ok');
  } finally {
    cfg.setTestStatePath(null);
  }
  const q = quarantined(dir);
  assert.equal(q.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, q[0]), 'utf8'), TRUNCATED);
  assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).optOuts.Whitepages, 'a fresh valid state is written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState quarantines a corrupt file even when nothing reloaded it first', () => {
  // The file went bad after this process loaded (or was never loaded, as with
  // setTestStatePath): the save must not be the thing that destroys it.
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  cfg.setTestStatePath(target);
  try {
    captureWarnings(() => cfg.recordSuccess('Whitepages', 'ok'));
  } finally {
    cfg.setTestStatePath(null);
  }
  const q = quarantined(dir);
  assert.equal(q.length, 1, 'a .corrupt-* file exists after the save');
  assert.equal(fs.readFileSync(path.join(dir, q[0]), 'utf8'), TRUNCATED);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repeated loads and saves of the same corrupt bytes do not pile up quarantine copies', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  cfg.setTestStatePath(target);
  try {
    captureWarnings(() => { cfg.resetState(); cfg.resetState(); });
  } finally {
    cfg.setTestStatePath(null);
  }
  assert.equal(quarantined(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt primary with a valid .bak recovers from the .bak, still keeps the corrupt copy, and warns', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  fs.writeFileSync(target + '.bak', JSON.stringify(GOOD));
  cfg.setTestStatePath(target);
  try {
    const warnings = captureWarnings(() => cfg.resetState());
    assert.deepEqual(cfg.loadState().optOuts, GOOD.optOuts, 'history comes back from the .bak');
    assert.equal(quarantined(dir).length, 1, 'the bad primary may hold newer data: keep it');
    assert.ok(warnings.some(w => /\.bak/.test(w)), 'says it recovered from the backup');
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a healthy state.json produces no quarantine file and no warning', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, JSON.stringify(GOOD));
  cfg.setTestStatePath(target);
  try {
    const warnings = captureWarnings(() => { cfg.resetState(); cfg.saveState(); });
    assert.deepEqual(warnings, []);
    assert.deepEqual(quarantined(dir), []);
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty or missing state.json is a fresh install, not corruption', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  cfg.setTestStatePath(target);
  try {
    let warnings = captureWarnings(() => cfg.resetState());
    assert.deepEqual(warnings, []);
    fs.writeFileSync(target, '');
    warnings = captureWarnings(() => cfg.resetState());
    assert.deepEqual(warnings, []);
    assert.deepEqual(quarantined(dir), []);
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt state.json at require time is quarantined too (the eager init path)', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, TRUNCATED);
  execFileSync(process.execPath, ['-e', `require('./lib/config')`], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, AIDR_STATE_PATH: target },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(quarantined(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the in-place fallback warns once that a single-file mount loses crash safety', () => {
  const dir = tmpdir();
  const results = [];
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; };
  cfg._resetInPlaceWarning();
  let warnings;
  try {
    warnings = captureWarnings(() => {
      for (let i = 0; i < 3; i++) {
        const target = path.join(dir, `state-${i}.json`);
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, 'x');
        cfg._renameOrRewrite(tmp, target, 'x');
        results.push(fs.readFileSync(target, 'utf8'));
      }
    });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(results, ['x', 'x', 'x'], 'still persists');
  const relevant = warnings.filter(w => /crash/i.test(w));
  assert.equal(relevant.length, 1, `warned exactly once, got ${warnings.length}: ${warnings.join(' | ')}`);
  assert.match(relevant[0], /directory/i, 'points at the fix: mount a directory');
  fs.rmSync(dir, { recursive: true, force: true });
});
