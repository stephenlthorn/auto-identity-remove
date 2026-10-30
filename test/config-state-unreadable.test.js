/**
 * test/config-state-unreadable.test.js
 *
 * CFG2-2: a state.json that exists but cannot be read (EACCES - typically left
 * root-owned by an earlier `sudo` run) was treated as an empty history, and the
 * first save replaced it AND its .bak. The user's whole opt-out history, gone,
 * with no quarantine copy because there were no readable bytes to copy.
 *
 * Saving over a file we could not read is now refused, with a message that says
 * how to fix the permissions. Nothing on disk changes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

const skipReason = process.platform === 'win32' || (process.getuid && process.getuid() === 0)
  ? 'needs a non-root POSIX user: chmod 000 does not block root'
  : false;

const HISTORY = {
  optOuts: {
    Spokeo: { lastSuccess: new Date().toISOString(), totalRuns: 7 },
    Whitepages: { lastSuccess: new Date().toISOString(), totalRuns: 3 },
  },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-unreadable-'));
  const target = path.join(dir, 'state.json');
  return { dir, target, bak: target + '.bak' };
}

function quiet(fn) {
  const realWarn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = realWarn; }
}

function cleanup({ dir, target, bak }) {
  for (const f of [target, bak]) { try { fs.chmodSync(f, 0o600); } catch (_) { /* absent */ } }
  fs.rmSync(dir, { recursive: true, force: true });
}

test('an unreadable state.json is never replaced by a save', { skip: skipReason }, () => {
  const f = fixture();
  const bytes = JSON.stringify(HISTORY);
  fs.writeFileSync(f.target, bytes);
  fs.writeFileSync(f.bak, bytes);
  fs.chmodSync(f.target, 0o000);
  fs.chmodSync(f.bak, 0o000);
  const before = fs.readdirSync(f.dir).sort();

  cfg.setTestStatePath(f.target);
  try {
    quiet(() => cfg.resetState());
    assert.throws(
      () => cfg.recordSuccess('Radaris', 'x'),
      (err) => err.code === 'ESTATEUNREADABLE' && /cannot be read/.test(err.message) && /EACCES/.test(err.message) &&
        err.message.includes(f.target) && /chmod|chown/.test(err.message),
    );
  } finally {
    cfg.setTestStatePath(null);
  }

  assert.deepEqual(fs.readdirSync(f.dir).sort(), before, 'no file was created, replaced or quarantined');
  fs.chmodSync(f.target, 0o600);
  fs.chmodSync(f.bak, 0o600);
  assert.equal(fs.readFileSync(f.target, 'utf8'), bytes, 'state.json byte-for-byte');
  assert.equal(fs.readFileSync(f.bak, 'utf8'), bytes, 'state.json.bak byte-for-byte');
  cleanup(f);
});

test('an unreadable state.json is protected even when the .bak is readable', { skip: skipReason }, () => {
  const f = fixture();
  const bytes = JSON.stringify(HISTORY);
  fs.writeFileSync(f.target, bytes);
  fs.writeFileSync(f.bak, bytes);
  fs.chmodSync(f.target, 0o000);

  cfg.setTestStatePath(f.target);
  try {
    quiet(() => cfg.resetState());
    assert.throws(() => cfg.recordFailure('Radaris', 'error'), (err) => err.code === 'ESTATEUNREADABLE');
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.chmodSync(f.target, 0o600);
  assert.equal(fs.readFileSync(f.target, 'utf8'), bytes);
  cleanup(f);
});

test('a corrupt state.json with an unreadable .bak is not saved over either', { skip: skipReason }, () => {
  const f = fixture();
  const bytes = JSON.stringify(HISTORY);
  fs.writeFileSync(f.target, '{"optOuts":{"Spokeo":');
  fs.writeFileSync(f.bak, bytes);
  fs.chmodSync(f.bak, 0o000);

  cfg.setTestStatePath(f.target);
  try {
    quiet(() => cfg.resetState());
    assert.throws(() => cfg.recordSuccess('Radaris', 'x'), (err) => err.code === 'ESTATEUNREADABLE' && err.message.includes(f.bak));
  } finally {
    cfg.setTestStatePath(null);
  }
  fs.chmodSync(f.bak, 0o600);
  assert.equal(fs.readFileSync(f.bak, 'utf8'), bytes, 'the only copy of the history is untouched');
  cleanup(f);
});

test('a readable state.json with an unreadable .bak still saves (the .bak is only a copy)', { skip: skipReason }, () => {
  const f = fixture();
  fs.writeFileSync(f.target, JSON.stringify(HISTORY));
  fs.writeFileSync(f.bak, JSON.stringify(HISTORY));
  fs.chmodSync(f.bak, 0o000);

  cfg.setTestStatePath(f.target);
  try {
    quiet(() => cfg.resetState());
    cfg.recordSuccess('Radaris', 'x');
  } finally {
    cfg.setTestStatePath(null);
  }
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'));
  assert.ok(saved.optOuts.Radaris && saved.optOuts.Spokeo, 'history kept and the new entry added');
  cleanup(f);
});

test('stateProblem names an unreadable state file so a run can stop before it starts', { skip: skipReason }, () => {
  const f = fixture();
  fs.writeFileSync(f.target, JSON.stringify(HISTORY));
  assert.equal(cfg.stateProblem(f.target), null, 'a readable state is not a problem');
  fs.chmodSync(f.target, 0o000);
  const problem = cfg.stateProblem(f.target);
  assert.match(problem.message, /cannot be read/);
  assert.match(problem.message, /EACCES/);
  assert.equal(problem.path, f.target);
  cleanup(f);
});

test('a missing or empty state file is not a problem (fresh install)', () => {
  const f = fixture();
  assert.equal(cfg.stateProblem(f.target), null);
  fs.writeFileSync(f.target, '');
  assert.equal(cfg.stateProblem(f.target), null);
  cfg.setTestStatePath(f.target);
  try {
    quiet(() => cfg.resetState());
    cfg.recordSuccess('Radaris', 'x');
  } finally {
    cfg.setTestStatePath(null);
  }
  assert.ok(JSON.parse(fs.readFileSync(f.target, 'utf8')).optOuts.Radaris);
  cleanup(f);
});
