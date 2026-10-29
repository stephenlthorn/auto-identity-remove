'use strict';
/**
 * test/heartbeat-write-read.test.js
 *
 * R4: every run leaves a small heartbeat (last-run.json: start, end, outcome,
 * counts) so `aidr schedule status` and `aidr doctor` can say when the job last
 * ran and how it ended. A job that dies without writing an end time must read as
 * crashed, otherwise a killed monthly run looks like it is still going forever.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfgModule = require('../lib/config');
const lock = require('../lib/lock');
const {
  writeHeartbeat,
  readHeartbeat,
  defaultHeartbeatPath,
  HEARTBEAT_FILENAME,
} = require('../lib/heartbeat');

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-heartbeat-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  cfgModule.setTestStatePath(null);
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const FINISHED = {
  startedAt: '2026-10-01T09:00:01.000Z',
  finishedAt: '2026-10-01T10:12:30.000Z',
  outcome: 'ok',
  counts: { succeeded: 40, errors: 0 },
};

describe('writeHeartbeat', () => {
  it('writes the record as JSON the reader gets back', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, FINISHED);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), FINISHED);
  });

  it('writes an owner-only file (it names how many brokers hold the user)', { skip: process.platform === 'win32' }, () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, FINISHED);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('tightens a looser file left by an older copy', { skip: process.platform === 'win32' }, () => {
    const file = path.join(tmpDir(), 'last-run.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeHeartbeat(file, FINISHED);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('is atomic: no temp file is left beside it', () => {
    const dir = tmpDir();
    writeHeartbeat(path.join(dir, 'last-run.json'), FINISHED);
    assert.deepEqual(fs.readdirSync(dir), ['last-run.json']);
  });

  it('creates a missing directory without changing the mode of one that exists', { skip: process.platform === 'win32' }, () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o755);
    const nested = path.join(dir, 'a', 'b');
    writeHeartbeat(path.join(nested, 'last-run.json'), FINISHED);
    assert.ok(fs.existsSync(path.join(nested, 'last-run.json')));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755, 'the app directory must not be chmod-ed');
  });

  it('accepts a start-only record (no finishedAt, no outcome yet)', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: '2026-10-01T09:00:01.000Z' });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.startedAt, '2026-10-01T09:00:01.000Z');
    assert.equal(stored.finishedAt, null);
    assert.equal(stored.outcome, null);
  });

  it('rejects an outcome outside ok / partial / failed / crashed', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    assert.throws(() => writeHeartbeat(file, { ...FINISHED, outcome: 'great' }), /outcome/);
    assert.equal(fs.existsSync(file), false, 'nothing is written for a bad record');
  });

  it('rejects a record with no usable startedAt', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    assert.throws(() => writeHeartbeat(file, { ...FINISHED, startedAt: 'yesterday-ish' }), /startedAt/);
  });

  it('keeps only numeric counts: a heartbeat must never carry a name or an address', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, {
      ...FINISHED,
      counts: { succeeded: 3, errors: 1, person: 'Ada Lovelace', 'bad key': 4, nan: NaN, nested: { a: 1 } },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).counts, { succeeded: 3, errors: 1 });
  });
});

describe('readHeartbeat', () => {
  it('returns null when no run has left a heartbeat', () => {
    assert.equal(readHeartbeat(path.join(tmpDir(), 'last-run.json')), null);
  });

  it('returns the record of a finished run, outcome as written', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    for (const outcome of ['ok', 'partial', 'failed', 'crashed']) {
      writeHeartbeat(file, { ...FINISHED, outcome });
      const hb = readHeartbeat(file, { now: T0 });
      assert.equal(hb.outcome, outcome);
      assert.equal(hb.startedAt, FINISHED.startedAt);
      assert.equal(hb.finishedAt, FINISHED.finishedAt);
      assert.deepEqual(hb.counts, FINISHED.counts);
    }
  });

  it('reads a run that started recently and has not finished as running', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: new Date(T0).toISOString() });
    const hb = readHeartbeat(file, { now: T0 + HOUR });
    assert.equal(hb.outcome, 'running');
    assert.equal(hb.finishedAt, null);
  });

  it('reads a run that started and never finished, past the lock max age, as crashed', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: new Date(T0).toISOString() });
    const hb = readHeartbeat(file, { now: T0 + lock.DEFAULT_MAX_AGE_MS + 1000 });
    assert.equal(hb.outcome, 'crashed');
  });

  it('takes the crash age from maxAgeMs when given', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: new Date(T0).toISOString() });
    assert.equal(readHeartbeat(file, { now: T0 + 2 * HOUR, maxAgeMs: HOUR }).outcome, 'crashed');
    assert.equal(readHeartbeat(file, { now: T0 + 2 * HOUR, maxAgeMs: 3 * HOUR }).outcome, 'running');
  });

  it('takes the crash age from AIDR_LOCK_MAX_AGE_HOURS, the same knob the lock uses', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: new Date(T0).toISOString() });
    const env = { AIDR_LOCK_MAX_AGE_HOURS: '1' };
    assert.equal(readHeartbeat(file, { now: T0 + 2 * HOUR, env }).outcome, 'crashed');
  });

  it('does not rewrite the file when it reports a crash (reading is read-only)', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    writeHeartbeat(file, { startedAt: new Date(T0).toISOString() });
    const before = fs.readFileSync(file, 'utf8');
    readHeartbeat(file, { now: T0 + 48 * HOUR });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('reports a file that is not a heartbeat as unreadable rather than as "never ran"', () => {
    const dir = tmpDir();
    for (const body of ['{not json', '[]', '{"outcome":"ok"}', '{"startedAt":"nope"}']) {
      const file = path.join(dir, 'last-run.json');
      fs.writeFileSync(file, body);
      const hb = readHeartbeat(file, { now: T0 });
      assert.equal(hb.unreadable, true, body);
      assert.equal(hb.outcome, 'unknown', body);
      assert.deepEqual(hb.counts, {}, body);
    }
  });

  it('does not trust a finished record whose outcome it does not know', () => {
    const file = path.join(tmpDir(), 'last-run.json');
    fs.writeFileSync(file, JSON.stringify({ ...FINISHED, outcome: 'great' }));
    const hb = readHeartbeat(file, { now: T0 });
    assert.equal(hb.outcome, 'unknown');
    assert.equal(hb.unreadable, true);
  });
});

describe('defaultHeartbeatPath', () => {
  it('sits beside state.json', () => {
    const dir = tmpDir();
    cfgModule.setTestStatePath(path.join(dir, 'state.json'));
    assert.equal(defaultHeartbeatPath(), path.join(dir, HEARTBEAT_FILENAME));
    assert.equal(HEARTBEAT_FILENAME, 'last-run.json');
  });

  it('follows an explicit state path', () => {
    assert.equal(
      defaultHeartbeatPath({ statePath: '/data/aidr/state.json' }),
      path.join('/data/aidr', 'last-run.json')
    );
  });
});
