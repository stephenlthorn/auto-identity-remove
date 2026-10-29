'use strict';
/**
 * test/doctor-lock.test.js
 *
 * R4: doctor reports the run lock (state.json.lock): who holds it, for how long,
 * and whether that holder is alive. "Another instance is running" with no way to
 * see which instance, or that it died hours ago, is what sends people to delete
 * lock files blind. Reading is strictly read-only: doctor never takes over or
 * deletes a stale lock, the next run does that under its own guard.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../lib/lock');
const { checkLock } = require('../lib/doctor');

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const MIN = 60000;
const HOUR = 60 * MIN;
const HOST = 'nas-1';

const dirs = [];
function tmpLock(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-lock-'));
  dirs.push(dir);
  const file = path.join(dir, 'state.json.lock');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const holder = (overrides = {}) => ({
  pid: 4242, host: HOST, startedAt: new Date(NOW - 30 * MIN).toISOString(), ts: new Date(NOW - 12 * MIN).toISOString(), ...overrides,
});
const alive = () => true;
const dead = () => false;

function check(file, opts = {}) {
  return checkLock(file, { now: NOW, hostname: HOST, isAlive: alive, ...opts });
}

describe('checkLock', () => {
  it('says no lock is held when there is none', () => {
    const r = check(tmpLock());
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
    assert.match(r.hint, /no lock held/);
  });

  it('reports a live lock: holder pid, host and how long it has been held', () => {
    const r = check(tmpLock(holder()));
    assert.equal(r.ok, true);
    assert.ok(!r.warn);
    assert.match(r.hint, /run in progress/);
    assert.match(r.hint, /pid 4242/);
    assert.match(r.hint, /nas-1/);
    assert.match(r.hint, /12m/);
  });

  it('warns about a stale lock whose holder is gone, and says what to do', () => {
    const file = tmpLock(holder({ ts: new Date(NOW - 2 * HOUR).toISOString() }));
    const r = check(file, { isAlive: dead });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.hint, /stale/);
    assert.match(r.hint, /pid 4242/);
    assert.match(r.hint, /not running/);
    assert.match(r.hint, /2h/);
    assert.ok(r.hint.includes(file), 'the path to delete is in the message');
  });

  it('warns about a lock past the max age even when its pid still answers (a recycled pid)', () => {
    const r = check(tmpLock(holder({ ts: new Date(NOW - 7 * HOUR).toISOString() })), { isAlive: alive });
    assert.equal(r.warn, true);
    assert.match(r.hint, /older than/);
  });

  it('takes the max age from maxAgeMs', () => {
    const file = tmpLock(holder({ ts: new Date(NOW - 2 * HOUR).toISOString() }));
    assert.equal(check(file, { maxAgeMs: HOUR }).warn, true);
    assert.ok(!check(file, { maxAgeMs: 3 * HOUR }).warn);
  });

  it('takes the max age from AIDR_LOCK_MAX_AGE_HOURS, the knob the lock itself reads', () => {
    const file = tmpLock(holder({ ts: new Date(NOW - 2 * HOUR).toISOString() }));
    assert.equal(check(file, { env: { AIDR_LOCK_MAX_AGE_HOURS: '1' } }).warn, true);
  });

  it('cannot judge a pid from another host: a fresh lock there reads as live, and says so', () => {
    const r = check(tmpLock(holder({ host: 'other-container' })), { isAlive: dead });
    assert.ok(!r.warn);
    assert.match(r.hint, /other-container/);
    assert.match(r.hint, /cannot check/);
  });

  it('still calls an old lock from another host stale', () => {
    const r = check(tmpLock(holder({ host: 'other-container', ts: new Date(NOW - 9 * HOUR).toISOString() })));
    assert.equal(r.warn, true);
  });

  it('warns about a lock file that is not valid JSON once it is not freshly written', () => {
    const file = tmpLock('not json');
    const old = new Date(NOW - 3 * HOUR);
    fs.utimesSync(file, old, old);
    const r = check(file);
    assert.equal(r.warn, true);
    assert.match(r.hint, /unreadable/);
  });

  it('treats a just-written unreadable lock as a writer mid-create, not debris', () => {
    const file = tmpLock('');
    const r = checkLock(file, { now: Date.now(), hostname: HOST, isAlive: alive });
    assert.ok(!r.warn);
  });

  it('only reads: a stale lock is neither deleted nor rewritten', () => {
    const body = JSON.stringify(holder({ ts: new Date(NOW - 7 * HOUR).toISOString() }));
    const file = tmpLock(body);
    check(file, { isAlive: dead });
    assert.equal(fs.readFileSync(file, 'utf8'), body);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json.lock'], 'no takeover guard left behind');
  });

  it('uses lib/lock.js\'s own reading logic when it exports one', () => {
    const file = tmpLock(holder());
    const original = lock.inspect;
    const seen = [];
    lock.inspect = (lockPath, ctx) => {
      seen.push([lockPath, ctx]);
      return { present: true, stale: true, holder: { pid: 7, host: 'h' }, ageMs: 8 * HOUR, reason: 'because lock.js said so' };
    };
    try {
      const r = check(file);
      assert.equal(r.warn, true);
      assert.match(r.hint, /because lock\.js said so/);
      assert.equal(seen[0][0], file);
    } finally {
      if (original === undefined) delete lock.inspect; else lock.inspect = original;
    }
  });
});
