'use strict';
/**
 * test/broker-health-workflow.test.js
 *
 * Pins the properties of .github/workflows/broker-health.yml that must not
 * change by accident: it runs weekly, it holds exactly the two permissions the
 * job needs, it stays a plain browser, and it uses no secret but the built-in
 * token. Static checks, like test/docker-build-contract.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '.github', 'workflows', 'broker-health.yml');
const text = fs.readFileSync(FILE, 'utf8');
const lines = text.split('\n');
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

test('runs on a weekly schedule, not on the hour, and on manual dispatch', () => {
  assert.match(code, /^on:/m);
  assert.match(code, /workflow_dispatch:/);
  const crons = [...code.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.equal(crons.length, 1, 'exactly one schedule');
  const [minute, hour, dom, month, dow] = crons[0].split(/\s+/);
  assert.match(minute, /^\d+$/);
  assert.notEqual(minute, '0', 'the top of the hour is when every scheduled job starts');
  assert.match(hour, /^\d+$/);
  assert.equal(`${dom} ${month}`, '* *');
  assert.match(dow, /^[0-6]$/, 'one day a week');
});

test('permissions are exactly contents: write and issues: write', () => {
  const block = code.match(/^permissions:\n((?:[ \t]+\S.*\n)+)/m);
  assert.ok(block, 'a top-level permissions block');
  const granted = block[1].trim().split('\n').map((l) => l.trim()).sort();
  assert.deepEqual(granted, ['contents: write', 'issues: write']);
  assert.doesNotMatch(code, /^\s{4,}permissions:/m, 'no job widens them');
});

test('uses no secret but the built-in token', () => {
  const secrets = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.every((s) => s === 'GITHUB_TOKEN'), `secrets used: ${secrets.join(', ')}`);
  assert.doesNotMatch(code, /CAPSOLVER|PASSPHRASE|AIDR_CONFIG/i);
});

test('stays a plain browser: no stealth, no CAPTCHA solving, no proxy', () => {
  assert.doesNotMatch(code, /stealth|capsolver|solve-?captcha|proxy/i);
});

test('the steps run in order: checkout, Node 22, npm ci, Chromium with deps, check, generate, commit, issues', () => {
  const order = [
    /actions\/checkout@/,
    /actions\/setup-node@/,
    /node-version:\s*22/,
    /npm ci/,
    /playwright install[^\n]*--with-deps[^\n]*chromium/,
    /node scripts\/broker-health\.js/,
    /node scripts\/generate-status\.js/,
    /git commit/,
    /node scripts\/ci\/broker-health-issues\.js/,
  ];
  let at = -1;
  for (const re of order) {
    const found = code.slice(at + 1).search(re);
    assert.notEqual(found, -1, `missing, or out of order: ${re}`);
    at += 1 + found;
  }
});

test('the commit step only commits the two generated files, as the Actions bot, and only when they changed', () => {
  assert.match(code, /git add data\/broker-health\.json STATUS\.md/);
  assert.match(code, /github-actions\[bot\]/);
  assert.match(code, /git diff --cached --quiet/);
  assert.match(code, /git push origin HEAD:main/);
  assert.doesNotMatch(code, /git add (-A|\.)/);
  assert.doesNotMatch(code, /--force/);
});

test('commits and issues only happen for a run on main', () => {
  assert.match(code, /github\.ref == 'refs\/heads\/main'/);
});

test('does not run two checks at once, and cannot run forever', () => {
  assert.match(code, /concurrency:/);
  assert.match(code, /timeout-minutes:\s*\d+/);
});

test('the issue step gets the built-in token as GH_TOKEN', () => {
  assert.match(code, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});
