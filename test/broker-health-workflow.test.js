'use strict';
/**
 * test/broker-health-workflow.test.js
 *
 * Pins the properties of .github/workflows/broker-health.yml that must not
 * change by accident. The workflow is parsed (test/helpers/mini-yaml.js) and every
 * property is asserted per job and per step, because one regex over the whole
 * file passes when a property is removed from one place and left in another
 * (an `if:` dropped from the commit step but kept on the issue step, say).
 *
 * The shape that matters: TWO jobs.
 *   check    read-only token, no persisted git credentials, runs `npm ci`,
 *            Chromium and the ~46 third-party pages, uploads the result.
 *   publish  the only job that holds a write token. It installs nothing from npm,
 *            starts no browser and loads no third-party page.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('./helpers/mini-yaml');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, '.github', 'workflows', 'broker-health.yml');
const source = fs.readFileSync(FILE, 'utf8');
const wf = parse(source);
const REPO_GUARD = "github.repository == 'stephenlthorn/auto-identity-remove'";

const steps = (job) => job.steps;
const runOf = (step) => String(step.run || '');
const allRuns = (job) => steps(job).map(runOf).join('\n');
const find = (job, predicate, what) => {
  const hit = steps(job).filter(predicate);
  assert.equal(hit.length, 1, `exactly one step: ${what}`);
  return hit[0];
};
const usesOf = (name) => (step) => typeof step.uses === 'string' && step.uses.startsWith(`${name}@`);
const permissionsOf = (job) => Object.entries(job.permissions || {}).map(([k, v]) => `${k}: ${v}`).sort();

describe('the file as a whole', () => {
  test('runs on a weekly schedule, not on the hour, and on manual dispatch', () => {
    assert.ok('workflow_dispatch' in wf.on, 'manual dispatch');
    const schedule = wf.on.schedule;
    assert.equal(schedule.length, 1, 'exactly one schedule');
    const [minute, hour, dom, month, dow] = schedule[0].cron.split(/\s+/);
    assert.match(minute, /^\d+$/);
    assert.notEqual(minute, '0', 'the top of the hour is when every scheduled job starts');
    assert.match(hour, /^\d+$/);
    assert.equal(`${dom} ${month}`, '* *');
    assert.match(dow, /^[0-6]$/, 'one day a week');
  });

  test('has exactly the two jobs, check and publish', () => {
    assert.deepEqual(Object.keys(wf.jobs).sort(), ['check', 'publish']);
  });

  test('the workflow-wide token is read-only, so no job gets write by default', () => {
    assert.deepEqual(Object.entries(wf.permissions).map(([k, v]) => `${k}: ${v}`), ['contents: read']);
  });

  test('does not run two checks at once, and nothing runs forever', () => {
    assert.ok(wf.concurrency && wf.concurrency.group, 'a concurrency group');
    assert.equal(String(wf.concurrency['cancel-in-progress']), 'false');
    for (const [name, job] of Object.entries(wf.jobs)) assert.match(String(job['timeout-minutes']), /^\d+$/, `${name} has a timeout`);
  });

  test('uses no secret but the built-in token, and the token only in publish', () => {
    const secrets = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert.ok(secrets.every((s) => s === 'GITHUB_TOKEN'), `secrets used: ${secrets.join(', ')}`);
    assert.doesNotMatch(source, /CAPSOLVER|PASSPHRASE|AIDR_CONFIG/i);
    const checkText = JSON.stringify(wf.jobs.check);
    assert.doesNotMatch(checkText, /secrets\.|GH_TOKEN|GITHUB_TOKEN/, 'the check job never sees a token');
  });

  test('stays a plain browser: no stealth, no CAPTCHA solving, no proxy', () => {
    const code = source.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /stealth|capsolver|solve-?captcha|proxy/i);
  });

  test('no step uses --force or git add of everything', () => {
    const runs = Object.values(wf.jobs).map(allRuns).join('\n');
    assert.doesNotMatch(runs, /--force|git add (-A|\.)/);
  });
});

describe('job check: untrusted work, read-only', () => {
  const job = wf.jobs.check;

  test('only runs in the real repository (a fork must not run the weekly job)', () => {
    assert.equal(job.if, REPO_GUARD);
  });

  test('holds contents: read and nothing else', () => {
    assert.deepEqual(permissionsOf(job), ['contents: read']);
  });

  test('checkout does not persist the token into .git/config', () => {
    const checkout = find(job, usesOf('actions/checkout'), 'checkout');
    assert.equal(String(checkout.with['persist-credentials']), 'false');
    assert.equal(steps(job).indexOf(checkout), 0, 'checkout is the first step');
  });

  test('steps in order: Node 22, npm ci, Chromium with deps, the check, the upload', () => {
    const list = steps(job);
    const index = (predicate, what) => {
      const i = list.findIndex(predicate);
      assert.notEqual(i, -1, `missing: ${what}`);
      return i;
    };
    const node = index(usesOf('actions/setup-node'), 'setup-node');
    assert.equal(String(list[node].with['node-version']), '22');
    const ci = index((s) => /^npm ci\b/m.test(runOf(s)), 'npm ci');
    const browser = index((s) => /playwright install[^\n]*--with-deps[^\n]*chromium/.test(runOf(s)), 'playwright install');
    const check = index((s) => /node scripts\/broker-health\.js --runner ci/.test(runOf(s)), 'the health check');
    const upload = index(usesOf('actions/upload-artifact'), 'upload-artifact');
    assert.ok(node < ci && ci < browser && browser < check && check < upload, 'out of order');
  });

  test('uploads data/broker-health.json, and fails if the file is missing', () => {
    const upload = find(job, usesOf('actions/upload-artifact'), 'upload');
    assert.equal(upload.with.name, 'broker-health');
    assert.equal(upload.with.path, 'data/broker-health.json');
    assert.equal(upload.with['if-no-files-found'], 'error');
  });

  test('never commits, pushes, or talks to GitHub issues', () => {
    assert.doesNotMatch(allRuns(job), /git (commit|push|add|config)|\bgh\b|broker-health-issues|generate-status/);
  });

  test('no step in it declares its own permissions or env token', () => {
    for (const step of steps(job)) {
      assert.equal(step.permissions, undefined);
      assert.doesNotMatch(JSON.stringify(step.env || {}), /TOKEN|secrets/i);
    }
  });
});

describe('job publish: holds the write token, loads nothing from the internet', () => {
  const job = wf.jobs.publish;

  test('only in the real repository, and only on main', () => {
    assert.match(job.if, new RegExp(REPO_GUARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  });

  test('needs check, so it never runs without a finished check', () => {
    assert.equal(job.needs, 'check');
  });

  test('holds exactly contents: write and issues: write', () => {
    assert.deepEqual(permissionsOf(job), ['contents: write', 'issues: write']);
  });

  test('no npm ci, no Playwright, no browser, no third-party page', () => {
    const runs = allRuns(job);
    assert.doesNotMatch(runs, /npm (ci|install|exec)|\bnpx\b|playwright|chromium|scripts\/broker-health\.js/i);
    for (const step of steps(job)) {
      assert.doesNotMatch(JSON.stringify(step.with || {}), /cache|playwright/i, 'no package cache restored under the write token');
    }
  });

  test('checkout keeps the token (it must push) and is the first step', () => {
    const checkout = find(job, usesOf('actions/checkout'), 'checkout');
    assert.equal(steps(job).indexOf(checkout), 0);
    assert.notEqual(String((checkout.with || {})['persist-credentials']), 'false');
  });

  test('steps in order: Node 22, download the artifact, regenerate STATUS.md, commit, sync issues', () => {
    const list = steps(job);
    const index = (predicate, what) => {
      const i = list.findIndex(predicate);
      assert.notEqual(i, -1, `missing: ${what}`);
      return i;
    };
    const node = index(usesOf('actions/setup-node'), 'setup-node');
    assert.equal(String(list[node].with['node-version']), '22');
    const download = index(usesOf('actions/download-artifact'), 'download-artifact');
    const generate = index((s) => /^node scripts\/generate-status\.js$/m.test(runOf(s)), 'generate-status');
    const commit = index((s) => /commit-health\.sh/.test(runOf(s)), 'the commit step');
    const issues = index((s) => /^node scripts\/ci\/broker-health-issues\.js$/m.test(runOf(s)), 'the issue sync');
    assert.ok(node < download && download < generate && generate < commit && commit < issues, 'out of order');
  });

  test('downloads the artifact the check job uploaded, into data/', () => {
    const download = find(job, usesOf('actions/download-artifact'), 'download');
    const upload = find(wf.jobs.check, usesOf('actions/upload-artifact'), 'upload');
    assert.equal(download.with.name, upload.with.name);
    assert.equal(download.with.path, 'data');
  });

  test('the commit step runs the commit script, as one plain command', () => {
    const commit = find(job, (s) => /commit-health\.sh/.test(runOf(s)), 'commit');
    assert.equal(runOf(commit).trim(), 'bash scripts/ci/commit-health.sh');
    assert.equal(commit.if, undefined, 'main and the repository are the job condition; nothing here can be dropped separately');
  });

  test('the issue sync gets the built-in token as GH_TOKEN and the repository as GH_REPO, and runs even with nothing to commit', () => {
    const sync = find(job, (s) => /broker-health-issues\.js/.test(runOf(s)), 'issue sync');
    assert.equal(sync.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
    assert.equal(sync.env.GH_REPO, '${{ github.repository }}');
    assert.equal(sync.if, '${{ !cancelled() }}', 'a failed commit must not skip the issue sync, and a cancel must');
  });

  test('only the issue sync step holds a token in its environment', () => {
    for (const step of steps(job)) {
      if (/broker-health-issues\.js/.test(runOf(step))) continue;
      assert.doesNotMatch(JSON.stringify(step.env || {}), /TOKEN|secrets/i);
    }
  });
});

describe('the publish job needs nothing from npm', () => {
  // `publish` runs without `npm ci`. Any package a script in it required would be
  // a "Cannot find module" on the first Monday. Run the real scripts with every
  // non-built-in, non-relative require refused.
  const guard = path.join(__dirname, 'helpers', 'no-npm-requires.js');

  test('generate-status.js and the issue planner load and run with no node_modules lookup', () => {
    const probe = `
      require(${JSON.stringify(path.join(ROOT, 'scripts', 'ci', 'broker-health-issues.js'))});
      const status = require(${JSON.stringify(path.join(ROOT, 'scripts', 'generate-status.js'))});
      const { explicitBrokers } = require(${JSON.stringify(path.join(ROOT, 'lib', 'broker-health.js'))});
      const list = explicitBrokers(require(${JSON.stringify(path.join(ROOT, 'brokers.js'))}));
      const text = status.renderStatus({ brokers: list, health: null });
      if (!text.includes('# Broker Status')) process.exit(3);
    `;
    const out = spawnSync(process.execPath, ['-r', guard, '-e', probe], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  });

  test('the guard really refuses a package (so the test above can fail)', () => {
    const out = spawnSync(process.execPath, ['-r', guard, '-e', "require('axios')"], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /not allowed in the publish job/);
  });
});
