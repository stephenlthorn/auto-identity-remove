/**
 * test/paths-wiring.test.js
 *
 * R0: every module that owns a runtime path takes it from lib/paths at load
 * time. The constants are computed when a module is first required, so each
 * case runs in a fresh node process with its own environment; nothing here
 * touches the repo-root config.json, state.json, logs/ or data/*history*.
 *
 * Two promises are checked end to end:
 *   - with no AIDR_* variable the constants are exactly the legacy locations;
 *   - with AIDR_HOME set, the paths a run WRITES (logs, snapshots, reports,
 *     history caches, the feeds cache, the confirm ledger) land inside it,
 *     while the datasets that ship with the app still load from the app.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const inside = (dir, ...rest) => path.join(dir, ...rest);

/** Run `script` in a fresh node process whose only AIDR_* variables are `env`. */
function runIn(env, script) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AIDR_')));
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: os.tmpdir(),
    env: { ...base, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const lib = name => JSON.stringify(path.join(ROOT, name));

const CONSTANTS_SCRIPT = `
  const c = require(${lib('lib/config')});
  console.log(JSON.stringify({
    config: c.CONFIG_PATH,
    configEnc: c.CONFIG_ENC_PATH,
    state: c.STATE_PATH,
    reports: require(${lib('lib/report')}).REPORT_DIR,
    snapshots: require(${lib('lib/snapshot')}).SNAPSHOT_DIR,
    serpHistory: require(${lib('lib/serp-scan')}).HISTORY_PATH,
    exposureHistory: require(${lib('lib/exposure')}).HISTORY_PATH,
    feeds: require(${lib('lib/feeds')}).FEEDS_PATH,
    ledger: require(${lib('lib/imap-confirm')}).defaultProcessedFile(),
  }));
`;

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-paths-'));

test('with no AIDR_* variable every module keeps its legacy path', () => {
  const got = runIn({}, CONSTANTS_SCRIPT);
  assert.deepEqual(got, {
    config: path.join(ROOT, 'config.json'),
    configEnc: path.join(ROOT, 'config.json.enc'),
    state: path.join(ROOT, 'state.json'),
    reports: path.join(ROOT, 'logs', 'reports'),
    snapshots: path.join(ROOT, 'logs', 'snapshots'),
    serpHistory: path.join(ROOT, 'data', 'serp-history.json'),
    exposureHistory: path.join(ROOT, 'data', 'exposure-history.json'),
    feeds: path.join(ROOT, 'data', 'feeds-brokers.json'),
    ledger: path.join(ROOT, 'confirm-processed.json'),
  });
});

test('AIDR_HOME relocates every module path into the one directory', () => {
  const home = mkTmp();
  const got = runIn({ AIDR_HOME: home }, CONSTANTS_SCRIPT);
  assert.deepEqual(got, {
    config: inside(home, 'config.json'),
    configEnc: inside(home, 'config.json.enc'),
    state: inside(home, 'state.json'),
    reports: inside(home, 'logs', 'reports'),
    snapshots: inside(home, 'logs', 'snapshots'),
    serpHistory: inside(home, 'data', 'serp-history.json'),
    exposureHistory: inside(home, 'data', 'exposure-history.json'),
    feeds: inside(home, 'data', 'feeds-brokers.json'),
    ledger: inside(home, 'confirm-processed.json'),
  });
});

test('the specific AIDR_* variables still win over AIDR_HOME in every module', () => {
  const home = mkTmp();
  const away = mkTmp();
  const got = runIn({
    AIDR_HOME: home,
    AIDR_CONFIG_PATH: inside(away, 'c.json'),
    AIDR_CONFIG_ENC_PATH: inside(away, 'c.enc'),
    AIDR_STATE_PATH: inside(away, 'sub', 's.json'),
    AIDR_LOG_DIR: inside(away, 'lg'),
    AIDR_DATA_DIR: inside(away, 'dt'),
  }, CONSTANTS_SCRIPT);
  assert.deepEqual(got, {
    config: inside(away, 'c.json'),
    configEnc: inside(away, 'c.enc'),
    state: inside(away, 'sub', 's.json'),
    reports: inside(away, 'lg', 'reports'),
    snapshots: inside(away, 'lg', 'snapshots'),
    serpHistory: inside(away, 'dt', 'serp-history.json'),
    exposureHistory: inside(away, 'dt', 'exposure-history.json'),
    feeds: inside(away, 'dt', 'feeds-brokers.json'),
    ledger: inside(away, 'sub', 'confirm-processed.json'),
  });
});

test('the confirm ledger follows the state file, so it travels with AIDR_STATE_PATH', () => {
  const home = mkTmp();
  const got = runIn({ AIDR_HOME: home, AIDR_STATE_PATH: inside(home, 'elsewhere', 'state.json') }, CONSTANTS_SCRIPT);
  assert.equal(got.ledger, inside(home, 'elsewhere', 'confirm-processed.json'));
});

test('history caches are written inside AIDR_HOME/data, creating the directory on first write', () => {
  const home = mkTmp();
  assert.equal(fs.existsSync(inside(home, 'data')), false, 'precondition: a fresh home has no data directory');
  const got = runIn({ AIDR_HOME: home }, `
    const fs = require('fs');
    const path = require('path');
    const serp = require(${lib('lib/serp-scan')});
    const expo = require(${lib('lib/exposure')});
    expo.recordBreachResult({ totalBreaches: 3 });
    expo.snapshotExposure({ score: 7, breakdown: {}, listedCount: 1, serpHits: 0, breachWeight: 0 });
    const dataDir = path.join(${JSON.stringify(home)}, 'data');
    fs.writeFileSync(path.join(dataDir, 'serp-history.json'), JSON.stringify([
      { personId: 'p', broker: 'B', engine: 'ddg', rank: 1, hostname: 'b.example', scannedAt: '2026-10-29T00:00:00.000Z' },
    ]));
    const signals = expo.loadPersistedSignals();
    console.log(JSON.stringify({
      files: fs.readdirSync(dataDir).sort(),
      serpRead: serp.readHistory().length,
      serpRows: signals.serpResults.length,
      breachCount: signals.breachCount,
    }));
  `);
  assert.deepEqual(got.files.filter(f => !f.endsWith('.bak')), ['breach-result.json', 'exposure-history.json', 'serp-history.json']);
  assert.equal(got.serpRead, 1, 'the SERP scanner must read the history from AIDR_HOME/data');
  assert.equal(got.serpRows, 1, 'the exposure score must read the SERP history from the same data directory');
  assert.equal(got.breachCount, 3);
  assert.equal(fs.existsSync(inside(ROOT, 'data', 'breach-result.json')), false, 'nothing leaked into the app directory');
});

test('the feeds cache is written to and read back from AIDR_HOME/data, shipped datasets still load from the app', () => {
  const home = mkTmp();
  const got = runIn({ AIDR_HOME: home }, `
    const fs = require('fs');
    const feeds = require(${lib('lib/feeds')});
    const runner = require(${lib('generic-runner')});
    (async () => {
      await feeds.runUpdateBrokers({
        brokers: [],
        buildFn: async () => ({
          brokers: [{ name: 'Probe Registry Broker', optOutUrl: 'https://probe-registry.example.test/optout', method: 'form', source: 'ca' }],
          stats: { ca: 1, vt: 0, total: 1 },
        }),
      });
      const loaded = runner.loadGenericBrokers(new Set());
      console.log(JSON.stringify({
        feedsFile: fs.existsSync(${JSON.stringify(inside(home, 'data', 'feeds-brokers.json'))}),
        probeLoaded: loaded.some(b => b.name === 'Probe Registry Broker'),
        shippedLoaded: loaded.filter(b => b.source === 'markup').length,
      }));
    })();
  `);
  assert.equal(got.feedsFile, true, '--update-brokers must write into AIDR_HOME/data');
  assert.equal(got.probeLoaded, true, 'the generic pass must read the cache from the same place it was written');
  assert.ok(got.shippedLoaded > 100, `the shipped Markup dataset must still load from the app directory (got ${got.shippedLoaded})`);
});

test('snapshots and reports are named inside the log directory', () => {
  const home = mkTmp();
  const got = runIn({ AIDR_HOME: home }, `
    const { snapshotPath } = require(${lib('lib/snapshot')});
    const { reportPdfPath } = require(${lib('lib/report')});
    console.log(JSON.stringify({
      snapshot: snapshotPath('Spokeo', new Date('2026-10-29T10:00:00.000Z')),
      report: reportPdfPath(new Date('2026-10-29T10:00:00.000Z')),
    }));
  `);
  assert.equal(path.dirname(got.snapshot), inside(home, 'logs', 'snapshots'));
  assert.equal(path.dirname(got.report), inside(home, 'logs', 'reports'));
});
