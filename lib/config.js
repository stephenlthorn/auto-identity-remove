/**
 * lib/config.js
 *
 * Config + opt-out state management.
 *
 * `state` is a single shared mutable object for the lifetime of the process,
 * exactly as in the original monolith. `recordSuccess` writes state.json via
 * `saveState()`. The `--dry-run` guard for the *run log* lives in watcher.js
 * (matching original behavior); `recordSuccess`/`saveState` here behave
 * identically to the original (state.json is still written by recordSuccess —
 * preserving verbatim behavior, including the original notFound dry-run path).
 */

const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH  = path.join(__dirname, '..', 'state.json');

const RECHECK_DAYS = 90; // how often to re-submit to a broker

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// state.json tracks opt-out history so completed opt-outs aren't re-submitted
// every single run (brokers re-add data every ~90 days, so we re-check then).
let state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { optOuts: {} };

function loadState() {
  return state;
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function lastOptOutDaysAgo(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry?.lastSuccess) return Infinity;
  return (Date.now() - new Date(entry.lastSuccess).getTime()) / (1000 * 60 * 60 * 24);
}

function recordSuccess(brokerName, detail = '') {
  state.optOuts[brokerName] = {
    lastSuccess: new Date().toISOString(),
    totalRuns: ((state.optOuts[brokerName]?.totalRuns) || 0) + 1,
    detail,
  };
  saveState();
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  RECHECK_DAYS,
  loadConfig,
  loadState,
  saveState,
  lastOptOutDaysAgo,
  recordSuccess,
};
