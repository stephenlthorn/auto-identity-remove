'use strict';
/**
 * test/chromium-runner.test.js
 *
 * A job that installs Playwright's Chromium must name the runner image it runs
 * on. `ubuntu-latest` moves to a new Ubuntu release on GitHub's schedule, and the
 * pinned Playwright only installs Chromium on the releases it knows. On
 * 2026-11-17 `ubuntu-latest` was Ubuntu 26.04, Playwright 1.60.0 refused it, and
 * the Node 22 leg of CI failed at "Install Chromium". The weekly broker health
 * check installs Chromium the same way and would have failed on its first run.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, parseWorkflow, runScript, jobKey } = require('./workflow-helpers');

const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const PINNED_IMAGE = /^ubuntu-\d{2}\.\d{2}$/;

const installsChromium = (job) => job.steps.some((step) => /playwright install\b/.test(runScript(step) || ''));

const chromiumJobs = fs
  .readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith('.yml'))
  .flatMap((name) =>
    Object.values(parseWorkflow(path.join(WORKFLOWS, name)).jobs)
      .filter(installsChromium)
      .map((job) => ({ where: `${name}: ${job.name}`, runsOn: jobKey(job, 'runs-on') })));

describe('jobs that install Chromium', () => {
  test('are the CI test job and the broker health check', () => {
    assert.deepEqual(chromiumJobs.map((job) => job.where).sort(), ['broker-health.yml: check', 'test.yml: test']);
  });

  for (const job of chromiumJobs) {
    test(`${job.where} names its runner image instead of following ubuntu-latest`, () => {
      assert.match(String(job.runsOn), PINNED_IMAGE);
    });
  }
});
