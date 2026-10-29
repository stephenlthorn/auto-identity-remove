'use strict';
/*
 * dashboard/support/harness.js - test support: a complete dashboard server on an
 * ephemeral port, wired to a fresh temp directory.
 *
 * Every path the server reads or writes (config, config.json.enc, state, logs,
 * .auth.json) lives in that directory, so a test can never reach the real
 * repo-root files. fs-guard turns an accidental attempt into a thrown error.
 */

require('./fs-guard');

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Low-level request: no headers added except Content-Type. */
function rawRequest(server, { method = 'GET', pathname, headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (rawBody !== undefined) req.write(rawBody);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * @param {object} [o]
 * @param {object} [o.cfgContent]    plaintext config.json
 * @param {object} [o.encContent]    envelope for config.json.enc
 * @param {object} [o.stateContent]  state.json
 * @param {string} [o.passphrase]
 * @param {object} [o.options]       extra createApp() options (spawn, brokers, ...)
 * @param {object} [o.env]           extra env for the app
 * @param {string} [o.user] [o.pass]
 * @param {boolean} [o.noAuth]       start with no credentials at all
 */
async function startHarness(o = {}) {
  const user = o.user || 'testuser';
  const pass = o.pass || 'testpass';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-dash-test-'));
  const paths = {
    dir,
    config: path.join(dir, 'config.json'),
    enc: path.join(dir, 'config.json.enc'),
    state: path.join(dir, 'state.json'),
    logs: path.join(dir, 'logs'),
    auth: path.join(dir, 'auth.json'),
    serp: path.join(dir, 'serp-history.json'),
  };
  if (o.cfgContent !== undefined) fs.writeFileSync(paths.config, JSON.stringify(o.cfgContent, null, 2));
  if (o.encContent !== undefined) fs.writeFileSync(paths.enc, JSON.stringify(o.encContent, null, 2));
  if (o.stateContent !== undefined) fs.writeFileSync(paths.state, JSON.stringify(o.stateContent, null, 2));

  const env = { ...(o.noAuth ? {} : { AIDR_USER: user, AIDR_PASS: pass }), ...(o.env || {}) };
  const instance = createApp({
    configPath: paths.config,
    encPath: paths.enc,
    statePath: paths.state,
    logsDir: paths.logs,
    authFile: paths.auth,
    serpHistoryPath: paths.serp,
    env,
    passphrase: o.passphrase !== undefined ? o.passphrase : '',
    warn: () => {},
    ...(o.options || {}),
  });

  const server = http.createServer(instance.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** Authenticated request; same-origin Origin header on anything that mutates. */
  const request = (opts = {}) => {
    const method = opts.method || 'GET';
    const headers = { ...(opts.noAuth ? {} : { Authorization: basicAuth(user, pass) }) };
    if (method !== 'GET' && method !== 'HEAD' && !opts.noOrigin) headers.Origin = origin;
    return rawRequest(server, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  };

  const close = async () => {
    await instance.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { server, instance, paths, request, rawRequest: opts => rawRequest(server, opts), origin, close, user, pass };
}

/** A stand-in for the object child_process.spawn returns. */
function fakeChild({ pid = 4242 } = {}) {
  const { EventEmitter } = require('events');
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig); return true; };
  c.exit = (code = 0, signal = null) => c.emit('close', code, signal);
  return c;
}

module.exports = { startHarness, rawRequest, basicAuth, fakeChild };
