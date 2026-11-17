'use strict';
/**
 * test/broker-health-script.test.js
 *
 * scripts/broker-health.js with an injected browser: what it writes, what it
 * refuses to write, and that it stays a plain browser.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../scripts/broker-health');

const NOW = Date.parse('2026-11-17T06:23:00Z');
const LIST = [
  { name: 'A', method: 'manual', optOutUrl: 'https://a.example/x' },
  { name: 'B', method: 'manual', optOutUrl: 'https://b.example/x' },
  { name: 'M', method: 'email', emailTo: 'x@example.com' },
];

function fakeLauncher({ failWith } = {}) {
  const log = { launch: null, contextOptions: null, gotos: [] };
  const launch = async (options) => {
    log.launch = options;
    return {
      async newContext(o) {
        log.contextOptions = o;
        return {
          async newPage() {
            return {
              async goto(url) {
                log.gotos.push(url);
                if (failWith) throw new Error(failWith);
                return { status: () => 200, headers: () => ({}) };
              },
              async evaluate() { return null; },
              async waitForTimeout() {},
              async close() {},
            };
          },
        };
      },
      async close() {},
    };
  };
  return { launch, log };
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-health-')), 'broker-health.json');
}
const quiet = { log() {}, error() {} };

describe('scripts/broker-health.js', () => {
  test('writes the health file with the runner label and a summary', async () => {
    const file = tmpFile();
    const { launch } = fakeLauncher();
    const code = await run({ argv: ['--runner', 'ci'], file, launch, brokers: LIST, now: () => NOW, io: quiet });
    assert.equal(code, 0);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.runner, 'ci');
    assert.equal(written.checkedAt, '2026-11-17T06:23:00.000Z');
    assert.deepEqual(Object.keys(written.results), ['A', 'B', 'M']);
    assert.equal(written.summary.ok, 2);
    assert.equal(written.summary.total, 2);
    assert.equal(written.results.M.status, 'n/a');
  });

  test('a result for a broker that is no longer in the list is not carried over, and the summary agrees (H6)', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
      runner: 'local',
      summary: { ok: 1, drifted: 0, blocked: 0, dead: 1, error: 0, na: 0, total: 2 },
      results: { A: { status: 'ok' }, 'Gone Broker': { status: 'dead' } },
    }));
    await run({ argv: [], file, launch: fakeLauncher().launch, brokers: LIST, now: () => NOW, io: quiet });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(written.results), ['A', 'B', 'M']);
    assert.equal(written.summary.dead, 0);
    assert.equal(written.summary.total, 2);
  });

  test('previousStatus is read from the file as it was before the run', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ runner: 'local', results: { A: { status: 'drifted' } } }));
    await run({ argv: ['--runner', 'local'], file, launch: fakeLauncher().launch, brokers: LIST, now: () => NOW, io: quiet });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.runner, 'local');
    assert.equal(written.results.A.previousStatus, 'drifted');
    assert.equal(written.results.B.previousStatus, null);
  });

  test('loads each opt-out page once and never an email broker', async () => {
    const { launch, log } = fakeLauncher();
    await run({ argv: [], file: tmpFile(), launch, brokers: LIST, now: () => NOW, io: quiet });
    assert.deepEqual(log.gotos, ['https://a.example/x', 'https://b.example/x']);
  });

  test('a plain headless browser: no user agent override, no proxy, no extra launch tricks', async () => {
    const { launch, log } = fakeLauncher();
    await run({ argv: [], file: tmpFile(), launch, brokers: LIST, now: () => NOW, io: quiet });
    assert.equal(log.launch.headless, true);
    assert.equal(log.launch.proxy, undefined);
    assert.equal(log.launch.userAgent, undefined);
    assert.equal(log.contextOptions === undefined || log.contextOptions.userAgent === undefined, true);
  });

  test('a run where nothing could be reached is refused and leaves the old file alone', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"keep":"me"}');
    const code = await run({
      argv: [], file, brokers: LIST, now: () => NOW, io: quiet,
      launch: fakeLauncher({ failWith: 'net::ERR_NAME_NOT_RESOLVED' }).launch,
    });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":"me"}');
  });

  test('a browser that will not launch is a failed run, not a crash', async () => {
    const file = tmpFile();
    const code = await run({
      argv: [], file, brokers: LIST, io: quiet,
      launch: async () => { throw new Error('no browser'); },
    });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(file), false);
  });

  test('--runner must be ci or local', async () => {
    const code = await run({ argv: ['--runner', 'cloud'], file: tmpFile(), launch: fakeLauncher().launch, brokers: LIST, io: quiet });
    assert.equal(code, 2);
  });

  // The behavioural proof that nothing is typed, clicked or submitted lives in
  // test/broker-health-check.test.js (a real browser, events recorded inside the page).
  // This is the static back-stop behind it: a source scan can only catch the obvious spellings,
  // so it lists every Playwright input method rather than three.
  const INPUT_API = /\.(fill|type|press|pressSequentially|click|dblclick|tap|check|uncheck|setChecked|selectOption|setInputFiles|dispatchEvent|dragTo|hover|focus|blur)\(|\.keyboard\b|\.mouse\b|\.touchscreen\b|requestSubmit|\.submit\(|\.click\(|insertText|execCommand/;

  test('the script does not import the stealth script or touch the CAPTCHA solver', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'broker-health.js'), 'utf8');
    assert.doesNotMatch(source, /require\([^)]*(stealth|capsolver|manual-captcha)/i);
    assert.doesNotMatch(source, /addInitScript|solveCaptcha|detectAndSolveCaptcha/);
    assert.doesNotMatch(source, INPUT_API);
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'broker-health.js'), 'utf8');
    assert.doesNotMatch(lib, /require\([^)]*stealth/i);
    assert.doesNotMatch(lib, /addInitScript|solveCaptcha|detectAndSolveCaptcha/);
    assert.doesNotMatch(lib, INPUT_API);
  });

  test('the static scan really catches each way of typing, clicking or submitting (so it can fail)', () => {
    for (const bad of [
      "page.fill('x', 'y')", "page.type('x', 'y')", "el.press('Enter')", "page.keyboard.press('a')", "page.mouse.click(1, 2)",
      "loc.selectOption('a')", "loc.check()", "form.requestSubmit()", "form.submit()", "el.dispatchEvent(e)", "loc.setInputFiles('f')",
    ]) assert.match(bad, INPUT_API, bad);
    for (const fine of ["page.goto(url)", "page.evaluate(fn)", "page.locator(s).count()", "await page.waitForTimeout(5)"]) {
      assert.doesNotMatch(fine, INPUT_API, fine);
    }
  });

  test('the page the script drives is only used to look: goto, evaluate and waits (a stub page that throws on anything else)', async () => {
    const allowed = new Set(['goto', 'evaluate', 'waitForTimeout', 'locator', 'close']);
    const seen = new Set();
    const launch = async () => ({
      async newContext() {
        return {
          async newPage() {
            return new Proxy({
              async goto() { return { status: () => 200, headers: () => ({}) }; },
              async evaluate() { return null; },
              async waitForTimeout() {},
              async close() {},
            }, {
              get(target, key) {
                if (typeof key !== 'string' || key === 'then') return undefined;
                seen.add(key);
                if (!allowed.has(key)) throw new Error(`the health check used page.${key}`);
                return target[key];
              },
            });
          },
        };
      },
      async close() {},
    });
    const code = await run({ argv: [], file: tmpFile(), launch, brokers: LIST, now: () => NOW, io: quiet });
    assert.equal(code, 0);
    assert.ok(seen.has('goto'));
  });
});
