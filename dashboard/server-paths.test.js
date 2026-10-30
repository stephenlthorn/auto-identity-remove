/**
 * dashboard/server-paths.test.js
 *
 * R0: the dashboard read config, state, logs and the SERP history from fixed places
 * under the repo root, and spawned runs with only the config and state variables.
 * With AIDR_HOME (or AIDR_LOG_DIR / AIDR_DATA_DIR) set, the watcher moved its files
 * and the dashboard kept showing the empty ones, so a Docker install's dashboard
 * showed no logs and no history at all.
 *
 * R7: browser.proxy credentials are secrets like every other key in the config.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('./server');
const { startHarness, fakeChild } = require('./support/harness');
const { maskConfig, applyConfigEdit, MASK, SECRET_PATHS } = require('./config-edit');

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-dash-paths-')));
}

const app = (options) => createApp({ warn: () => {}, authFile: path.join(os.tmpdir(), 'aidr-dash-paths-auth.json'), passphrase: '', ...options });

test('with nothing set, every path is where it always was', () => {
  const root = makeRoot();
  try {
    const { paths } = app({ root, env: {} });
    assert.equal(paths.config, path.join(root, 'config.json'));
    assert.equal(paths.enc, path.join(root, 'config.json.enc'));
    assert.equal(paths.state, path.join(root, 'state.json'));
    assert.equal(paths.logs, path.join(root, 'logs'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AIDR_HOME moves config, state and logs', () => {
  const root = makeRoot();
  const home = path.join(root, 'aidr-home');
  try {
    const { paths } = app({ root, env: { AIDR_HOME: home } });
    assert.equal(paths.config, path.join(home, 'config.json'));
    assert.equal(paths.enc, path.join(home, 'config.json.enc'));
    assert.equal(paths.state, path.join(home, 'state.json'));
    assert.equal(paths.logs, path.join(home, 'logs'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a specific variable still wins over AIDR_HOME', () => {
  const root = makeRoot();
  const home = path.join(root, 'aidr-home');
  try {
    const { paths } = app({ root, env: { AIDR_HOME: home, AIDR_CONFIG_PATH: path.join(root, 'c.json'), AIDR_STATE_PATH: path.join(root, 's.json'), AIDR_LOG_DIR: path.join(root, 'l') } });
    assert.equal(paths.config, path.join(root, 'c.json'));
    assert.equal(paths.enc, path.join(root, 'c.json.enc'), 'the encrypted file sits beside the config it was moved with');
    assert.equal(paths.state, path.join(root, 's.json'));
    assert.equal(paths.logs, path.join(root, 'l'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an explicit option beats the environment (tests, and any caller that knows better)', () => {
  const root = makeRoot();
  try {
    const { paths } = app({ root, env: { AIDR_HOME: '/nowhere' }, configPath: path.join(root, 'x.json'), logsDir: path.join(root, 'xl') });
    assert.equal(paths.config, path.join(root, 'x.json'));
    assert.equal(paths.logs, path.join(root, 'xl'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the SERP history is read from AIDR_DATA_DIR, else AIDR_HOME/data, where the scan writes it', () => {
  const root = makeRoot();
  const home = path.join(root, 'aidr-home');
  try {
    assert.equal(app({ root, env: { AIDR_HOME: home } }).paths.serp, path.join(home, 'data', 'serp-history.json'));
    assert.equal(app({ root, env: { AIDR_HOME: home, AIDR_DATA_DIR: path.join(root, 'd') } }).paths.serp, path.join(root, 'd', 'serp-history.json'));
    assert.equal(app({ root, env: {} }).paths.serp, path.join(root, 'data', 'serp-history.json'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a spawned run is told the log directory the dashboard reads', async () => {
  const calls = [];
  const h = await startHarness({ options: { spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); } } });
  try {
    const r = await h.request({ method: 'POST', pathname: '/api/run', body: { mode: 'preview' } });
    assert.equal(r.status, 200);
    assert.equal(calls[0].opts.env.AIDR_LOG_DIR, h.paths.logs, 'the run writes where the dashboard looks');
    assert.equal(calls[0].opts.env.AIDR_STATE_PATH, h.paths.state);
  } finally { await h.close(); }
});

test('AIDR_HOME reaches the spawned run through the environment it inherits', async () => {
  const calls = [];
  const h = await startHarness({ env: { AIDR_HOME: '/srv/aidr-home' }, options: { spawn: (cmd, args, opts) => { calls.push(opts); return fakeChild(); } } });
  try {
    await h.request({ method: 'POST', pathname: '/api/run', body: { mode: 'preview' } });
    assert.equal(calls[0].env.AIDR_HOME, '/srv/aidr-home');
  } finally { await h.close(); }
});

// ---- browser.proxy credentials are secrets ----------------------------------------

test('browser.proxy.password and username are masked in the config the browser receives', () => {
  const masked = maskConfig({ browser: { userAgent: 'UA', proxy: { server: 'http://proxy.example.test:8080', username: 'proxy-user-5521', password: 'proxy-pass-7731' } } });
  assert.equal(masked.browser.proxy.password, MASK);
  assert.equal(masked.browser.proxy.username, MASK);
  assert.equal(masked.browser.proxy.server, 'http://proxy.example.test:8080', 'the server is not a secret');
  assert.equal(masked.browser.userAgent, 'UA');
  assert.ok(!JSON.stringify(masked).includes('proxy-pass-7731'));
  assert.ok(!JSON.stringify(masked).includes('proxy-user-5521'));
});

test('saving the masked config back keeps the real proxy credentials', () => {
  const existing = { browser: { proxy: { server: 'http://proxy.example.test:8080', username: 'proxy-user-5521', password: 'proxy-pass-7731' } } };
  const edited = applyConfigEdit(existing, maskConfig(existing));
  assert.equal(edited.browser.proxy.password, 'proxy-pass-7731');
  assert.equal(edited.browser.proxy.username, 'proxy-user-5521');
});

test('SECRET_PATHS lists both proxy credentials', () => {
  const listed = SECRET_PATHS.map(p => p.join('.'));
  assert.ok(listed.includes('browser.proxy.password'));
  assert.ok(listed.includes('browser.proxy.username'));
});
