#!/usr/bin/env node
'use strict';
/**
 * scripts/broker-health.js
 *
 * Checks every explicit broker's opt-out page, one page at a time, and writes
 * data/broker-health.json. The weekly CI job (.github/workflows/broker-health.yml)
 * runs it; so can you:
 *
 *   node scripts/broker-health.js [--runner ci|local]
 *
 * This is deliberately a PLAIN headless Chromium: no stealth script, no CAPTCHA
 * solving, no proxy, nothing that tries to get around a bot check. A site that
 * blocks a data-centre address is reported as `blocked`, which is the true
 * answer for this runner. Each broker gets one page load and no retry.
 *
 * Set AIDR_CHROME_PATH to use a browser you already have instead of Playwright's.
 */

const fs = require('node:fs');
const path = require('node:path');
const { checkAllBrokers, explicitBrokers, buildHealthFile } = require('../lib/broker-health');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'broker-health.json');
const PAUSE_BETWEEN_BROKERS_MS = 750;

function parseArgs(argv, env) {
  const args = { runner: env.CI ? 'ci' : 'local' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runner') args.runner = argv[++i];
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (!['ci', 'local'].includes(args.runner)) throw new Error('--runner must be "ci" or "local"');
  return args;
}

function readPrevious(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Write beside the target and rename, so a killed run never leaves half a file.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function defaultLaunch(options) {
  return require('playwright').chromium.launch(options);
}

/**
 * @param {object} [deps]  injectable for tests
 * @returns {Promise<number>} the process exit code
 */
async function run(deps = {}) {
  const env = deps.env || process.env;
  const io = deps.io || console;
  const file = deps.file || DEFAULT_FILE;
  const now = deps.now || Date.now;

  let args;
  try { args = parseArgs(deps.argv || process.argv.slice(2), env); } catch (err) {
    io.error(`broker-health: ${err.message}`);
    return 2;
  }

  const list = deps.brokers || explicitBrokers(require('../brokers'));
  const previous = readPrevious(file);
  const launchOptions = { headless: true };
  if (env.AIDR_CHROME_PATH) launchOptions.executablePath = env.AIDR_CHROME_PATH;

  let browser;
  try {
    browser = await (deps.launch || defaultLaunch)(launchOptions);
  } catch (err) {
    io.error(`broker-health: could not start a browser: ${err.message}`);
    return 1;
  }

  let checked;
  try {
    const context = await browser.newContext();
    checked = await checkAllBrokers({
      brokers: list,
      newPage: () => context.newPage(),
      now,
      pauseMs: deps.pauseMs !== undefined ? deps.pauseMs : PAUSE_BETWEEN_BROKERS_MS,
      onResult: (entry) => io.log(`${entry.status.padEnd(8)} ${entry.name} - ${entry.detail}`),
    });
  } finally {
    await browser.close().catch(() => {});
  }

  // Every page dead or erroring means this runner has no network, not that
  // fifty brokers vanished. Writing that down would be a week of false data.
  const reached = checked.filter((e) => ['ok', 'drifted', 'blocked'].includes(e.status)).length;
  if (checked.some((e) => e.status !== 'n/a') && reached === 0) {
    io.error('broker-health: not one page could be reached, so this runner looks offline. Nothing was written.');
    return 1;
  }

  const document = buildHealthFile({
    checked, previous, runner: args.runner, checkedAt: new Date(now()).toISOString(), known: list.map((b) => b.name),
  });
  writeAtomic(file, `${JSON.stringify(document, null, 2)}\n`);
  const s = document.summary;
  io.log(`\n${s.ok} ok, ${s.drifted} drifted, ${s.blocked} blocked, ${s.dead} dead, ${s.error} error, ${s.na} n/a (${s.total} checked)`);
  return 0;
}

module.exports = { run, parseArgs };

if (require.main === module) {
  run().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
