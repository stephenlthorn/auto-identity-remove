/**
 * test/manual-captcha-log.test.js
 *
 * R1 (issue #16): the words and the data around the wait.
 *   - captchaFailureDetail: every non-continuing outcome says WHY and HOW to retry,
 *     and starts with the opt-out URL because the watcher opens those at the end.
 *   - captchaBrokersFromLog: which brokers `aidr captchas` re-runs, from either the
 *     end-of-run summary (buckets) or the crash-safe journal (a flat entry list).
 *   - announceCaptchaWait: the terminal line, the bell and the desktop toast.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  captchaFailureDetail, captchaBrokersFromLog, announceCaptchaWait, RETRY_COMMAND,
} = require('../lib/manual-captcha');

const URL_ = 'https://example.test/optout';
// Built from code points: a literal en or em dash here would fail test/no-em-dashes.test.js on this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

// ── captchaFailureDetail ───────────────────────────────────────────────────────

test('every outcome leads with the opt-out URL and names the retry command', () => {
  for (const outcome of ['timeout', 'failed', 'skipped']) {
    const detail = captchaFailureDetail({ outcome, url: URL_, timeoutSec: 180 });
    assert.ok(detail.startsWith(URL_ + ' '), `${outcome}: ${detail}`);
    assert.ok(detail.includes(RETRY_COMMAND), `${outcome}: ${detail}`);
    assert.ok(/captcha/i.test(detail), `${outcome}: the word CAPTCHA lets aidr captchas find manual rows`);
  }
});

test('timeout reports how long the person had', () => {
  assert.match(captchaFailureDetail({ outcome: 'timeout', url: URL_, timeoutSec: 180 }), /3 min/);
  assert.match(captchaFailureDetail({ outcome: 'timeout', url: URL_, timeoutSec: 90 }), /90s/);
});

test('skipped on a headless run says plainly that a display is needed and where to go', () => {
  const detail = captchaFailureDetail({ outcome: 'skipped', url: URL_, headless: true });
  assert.match(detail, /no display/i);
  assert.match(detail, /desktop/i);
});

test('skipped with captcha.manual=false names the setting', () => {
  const detail = captchaFailureDetail({ outcome: 'skipped', url: URL_, headless: false, config: { captcha: { manual: false } } });
  assert.match(detail, /captcha\.manual/);
});

test('skipped without a terminal says so', () => {
  const detail = captchaFailureDetail({ outcome: 'skipped', url: URL_, headless: false, isTTY: false, config: {} });
  assert.match(detail, /terminal/i);
});

test('a missing URL does not leave a dangling separator', () => {
  const detail = captchaFailureDetail({ outcome: 'timeout', timeoutSec: 60 });
  assert.ok(!detail.startsWith(' -'), detail);
});

test('a failure detail carries no em or en dash', () => {
  for (const outcome of ['timeout', 'failed', 'skipped']) {
    for (const headless of [true, false]) {
      const detail = captchaFailureDetail({ outcome, url: URL_, timeoutSec: 180, headless, isTTY: false, config: { captcha: { manual: false } } });
      assert.ok(!DASHES.test(detail), detail);
    }
  }
});

// ── captchaBrokersFromLog ──────────────────────────────────────────────────────

test('summary log: every captcha_failed broker and every manual one that names a CAPTCHA', () => {
  const log = {
    captchaFailed: [{ broker: 'Alpha', status: 'captcha_failed', detail: URL_ }],
    manual: [
      { broker: 'Beta', status: 'manual', detail: `${URL_} - CAPTCHA site, solver disabled` },
      { broker: 'Gamma', status: 'manual', detail: 'Call 1-800-555-0100 to opt out' },
    ],
    errors: [{ broker: 'Delta', status: 'error', detail: 'Timeout' }],
    succeeded: [{ broker: 'Echo', status: 'success', detail: 'ok' }],
  };
  assert.deepEqual([...captchaBrokersFromLog(log)].sort(), ['Alpha', 'Beta']);
});

test('journal: a flat list of entries is filtered by status and detail the same way', () => {
  const entries = [
    { broker: 'Alpha', status: 'captcha_failed', detail: URL_ },
    { broker: 'Beta', status: 'manual', detail: 'CAPTCHA required' },
    { broker: 'Gamma', status: 'manual', detail: 'mail a letter' },
    { broker: 'Delta', status: 'success', detail: 'done' },
  ];
  assert.deepEqual([...captchaBrokersFromLog(entries)].sort(), ['Alpha', 'Beta']);
});

test('journal: a broker whose LAST word was success (retried in the same run) is not re-run', () => {
  const entries = [
    { broker: 'Alpha', status: 'captcha_failed', detail: URL_, person: 'Jane Doe' },
    { broker: 'Alpha', status: 'success', detail: 'ok', person: 'Jane Doe' },
    { broker: 'Beta', status: 'success', detail: 'ok' },
    { broker: 'Beta', status: 'captcha_failed', detail: URL_ },
  ];
  assert.deepEqual([...captchaBrokersFromLog(entries)], ['Beta']);
});

test('journal: two people are tracked separately, so one success does not hide the other failure', () => {
  const entries = [
    { broker: 'Alpha', status: 'captcha_failed', detail: URL_, person: 'Jane Doe' },
    { broker: 'Alpha', status: 'success', detail: 'ok', person: 'John Doe' },
  ];
  assert.deepEqual([...captchaBrokersFromLog(entries)], ['Alpha']);
});

test('nothing usable in, an empty set out', () => {
  assert.equal(captchaBrokersFromLog(null).size, 0);
  assert.equal(captchaBrokersFromLog(undefined).size, 0);
  assert.equal(captchaBrokersFromLog({}).size, 0);
  assert.equal(captchaBrokersFromLog([null, {}, { status: 'captcha_failed' }]).size, 0, 'an entry with no broker name is ignored');
});

test('the old name field is still read, like extractFailedBrokers does', () => {
  assert.deepEqual([...captchaBrokersFromLog({ captchaFailed: [{ name: 'Legacy' }] })], ['Legacy']);
});

// ── announceCaptchaWait ────────────────────────────────────────────────────────

function announce(info, overrides = {}) {
  const logged = [];
  const bells = [];
  const toasts = [];
  announceCaptchaWait(info, {
    log: (line) => logged.push(line),
    bell: () => bells.push('\x07'),
    notify: (title, message) => toasts.push({ title, message }),
    ...overrides,
  });
  return { logged, bells, toasts };
}

test('prints a clear line, rings the bell once and raises one desktop notification', () => {
  const { logged, bells, toasts } = announce({ broker: { name: 'CaptchaSite' }, timeoutSec: 180 });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /CaptchaSite/);
  assert.match(logged[0], /CAPTCHA/);
  assert.match(logged[0], /3 min/);
  assert.equal(bells.length, 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /CaptchaSite/);
});

test('the notification and the line carry the broker name and nothing about the person', () => {
  const { logged, toasts } = announce({ broker: { name: 'CaptchaSite', optOutUrl: 'https://example.test/jane-doe-austin' }, timeoutSec: 60 });
  for (const text of [...logged, toasts[0].title, toasts[0].message]) {
    assert.ok(!/jane|austin/i.test(text), text);
  }
});

test('a notifier that throws must not break the wait', () => {
  assert.doesNotThrow(() => announce({ broker: { name: 'X' }, timeoutSec: 60 }, { notify: () => { throw new Error('no toast'); } }));
});

test('the default bell writes BEL to a terminal and nothing to a pipe', () => {
  const realWrite = process.stdout.write;
  const realIsTTY = process.stdout.isTTY;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    process.stdout.isTTY = true;
    announceCaptchaWait({ broker: { name: 'X' }, timeoutSec: 60 }, { log: () => {}, notify: () => {} });
    const onTerminal = written.filter(c => c === '\x07').length;
    written.length = 0;
    process.stdout.isTTY = false;
    announceCaptchaWait({ broker: { name: 'X' }, timeoutSec: 60 }, { log: () => {}, notify: () => {} });
    const onPipe = written.filter(c => c === '\x07').length;
    assert.equal(onTerminal, 1);
    assert.equal(onPipe, 0);
  } finally {
    process.stdout.write = realWrite;
    process.stdout.isTTY = realIsTTY;
  }
});
