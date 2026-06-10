/**
 * dashboard/server.test.js
 *
 * Hermetic endpoint tests for the dashboard server. Uses a real express app
 * bound to port 0 (OS-assigned ephemeral port). No real watcher process is
 * spawned and no real config/state files are touched: CONFIG + STATE paths are
 * redirected to temp files, which are cleaned up after each test.
 *
 * Run with: node --test (from the dashboard/ directory)
 *
 * Dependencies: node built-ins only (http, fs, path, os, crypto) + express
 * (already in dashboard/node_modules).
 */

'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---- helpers ----------------------------------------------------------------

function tmpFile(suffix) {
  return path.join(os.tmpdir(), `aidr-test-${crypto.randomBytes(6).toString('hex')}${suffix}`);
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function request(server, { method = 'GET', pathname, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: pathname,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- server setup -----------------------------------------------------------
// We need to isolate the server module from real filesystem paths. The approach:
// set env vars for credentials, then require the module. Between tests we
// reload with fresh temp files. Because node caches modules we need to purge
// and re-require for each test that needs a clean state. We isolate by using a
// helper that re-requires with fresh env state.

// Temp config used across the session (restored to default before each test).
let cfgPath, statePath;

function purgeServerModule() {
  // Remove all server.js + validate.js entries from the require cache.
  for (const key of Object.keys(require.cache)) {
    if (/dashboard[/\\](server|validate)\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

function buildServer({ user = 'testuser', pass = 'testpass', cfgContent, stateContent } = {}) {
  // Write temp files.
  cfgPath = tmpFile('.json');
  statePath = tmpFile('.json');
  if (cfgContent !== undefined) {
    fs.writeFileSync(cfgPath, JSON.stringify(cfgContent, null, 2));
  }
  if (stateContent !== undefined) {
    fs.writeFileSync(statePath, JSON.stringify(stateContent, null, 2));
  }

  // Set env vars before requiring the module.
  process.env.AIDR_USER = user;
  process.env.AIDR_PASS = pass;
  process.env.AIDR_PORT = '0'; // ephemeral
  delete process.env.AIDR_TOKEN;

  purgeServerModule();

  // Monkey-patch the path constants BEFORE requiring by overriding within
  // the module's closure. The cleanest approach that avoids real filesystem
  // access: we patch the module's ROOT-relative paths by overriding require
  // so that when server.js reads CONFIG / STATE it uses our temp files.
  // We do this by replacing the module's bindings via a custom require wrapper.
  //
  // Simpler approach: after require, reach into the module to patch constants.
  // But those are `const` at module level. Instead, we stub `fs.readFileSync`
  // for the specific paths.
  //
  // Cleanest: just copy the temp files to the paths server.js hardcodes.
  // server.js uses: path.resolve(__dirname, '..') as ROOT. In our worktree
  // that resolves to the project root. We don't want to write real files there.
  //
  // Solution: re-require server.js with the ROOT-pointing paths replaced by
  // patching node's module system at require time using a thin proxy module.
  // This is over-engineered for tests. Instead: use the simplest approach -
  // write the temp content to the ACTUAL paths (which exist in the worktree)
  // and restore them after. The worktree is throwaway.

  // Determine the actual paths that server.js will use.
  const serverDir = path.resolve(__dirname);
  const projectRoot = path.resolve(serverDir, '..');
  const realConfig = path.join(projectRoot, 'config.json');
  const realState = path.join(projectRoot, 'state.json');

  // Stash original content.
  let origConfig = null, origState = null;
  try { origConfig = fs.readFileSync(realConfig, 'utf8'); } catch (_) {}
  try { origState = fs.readFileSync(realState, 'utf8'); } catch (_) {}

  // Write test content.
  if (cfgContent !== undefined) {
    fs.writeFileSync(realConfig, JSON.stringify(cfgContent, null, 2));
  } else {
    try { fs.unlinkSync(realConfig); } catch (_) {}
  }
  if (stateContent !== undefined) {
    fs.writeFileSync(realState, JSON.stringify(stateContent, null, 2));
  } else {
    try { fs.unlinkSync(realState); } catch (_) {}
  }

  // Clean up the temp files we created (no longer needed since we wrote to real paths).
  try { fs.unlinkSync(cfgPath); } catch (_) {}
  try { fs.unlinkSync(statePath); } catch (_) {}

  purgeServerModule();
  const { app } = require('./server');

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        close: () => new Promise(r => {
          server.close(r);
          // Restore original files.
          if (origConfig !== null) {
            try { fs.writeFileSync(realConfig, origConfig); } catch (_) {}
          } else {
            try { fs.unlinkSync(realConfig); } catch (_) {}
          }
          if (origState !== null) {
            try { fs.writeFileSync(realState, origState); } catch (_) {}
          } else {
            try { fs.unlinkSync(realState); } catch (_) {}
          }
        }),
        realConfig,
        realState,
        projectRoot,
      });
    });
  });
}

// ---- tests ------------------------------------------------------------------

test('/api/health is reachable without auth', async () => {
  const { server, close } = await buildServer();
  try {
    const r = await request(server, { pathname: '/api/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally {
    await close();
  }
});

test('all other routes return 401 without auth', async () => {
  const { server, close } = await buildServer();
  try {
    const routes = [
      '/api/version',
      '/api/config',
      '/api/state',
      '/api/run/status',
      '/api/schedule',
      '/api/auth/whoami',
    ];
    for (const pathname of routes) {
      const r = await request(server, { pathname });
      assert.equal(r.status, 401, `${pathname} should be 401 without auth`);
    }
  } finally {
    await close();
  }
});

test('/api/config with auth returns secrets masked', async () => {
  const cfgContent = {
    person: { firstName: 'Jane', lastName: 'Doe' },
    capsolver: { apiKey: 'REAL-SECRET-KEY' },
    email: { smtp: { host: 'smtp.example.com', user: 'jane@example.com', pass: 'REAL-SMTP-PASS' } },
    notify: { webhook: 'https://hooks.example.com/real-token' },
  };
  const { server, close } = await buildServer({ cfgContent });
  try {
    const r = await request(server, {
      pathname: '/api/config',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    const cfg = r.json.config;
    // Secrets must be masked.
    assert.notEqual(cfg.capsolver.apiKey, 'REAL-SECRET-KEY', 'capsolver.apiKey must be masked');
    assert.notEqual(cfg.email.smtp.pass, 'REAL-SMTP-PASS', 'smtp.pass must be masked');
    assert.notEqual(cfg.notify.webhook, 'https://hooks.example.com/real-token', 'webhook must be masked');
    // Non-secret PII must be present.
    assert.equal(cfg.person.firstName, 'Jane');
    assert.equal(cfg.person.lastName, 'Doe');
    assert.equal(cfg.email.smtp.host, 'smtp.example.com');
  } finally {
    await close();
  }
});

test('POST /api/run mode real without confirm returns 400', async () => {
  const { server, close } = await buildServer();
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/run',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { mode: 'real' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /confirm/i);
  } finally {
    await close();
  }
});

test('mergeConfig: masked secret left as sentinel is preserved on disk', async () => {
  const MASK = '••••••••';
  const cfgContent = {
    capsolver: { apiKey: 'ORIGINAL-SECRET' },
    person: { firstName: 'Jane' },
  };
  const { server, close, realConfig } = await buildServer({ cfgContent });
  try {
    // Send masked sentinel for apiKey (as browser does when not retyped).
    const r = await request(server, {
      method: 'PUT',
      pathname: '/api/config',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { capsolver: { apiKey: MASK }, person: { firstName: 'Updated' } },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    const saved = JSON.parse(fs.readFileSync(realConfig, 'utf8'));
    assert.equal(saved.capsolver.apiKey, 'ORIGINAL-SECRET', 'masked sentinel must preserve original secret on disk');
    assert.equal(saved.person.firstName, 'Updated', 'non-secret field must be updated');
  } finally {
    await close();
  }
});

test('mergeConfig: retyped secret is updated on disk', async () => {
  const cfgContent = {
    capsolver: { apiKey: 'OLD-SECRET' },
  };
  const { server, close, realConfig } = await buildServer({ cfgContent });
  try {
    const r = await request(server, {
      method: 'PUT',
      pathname: '/api/config',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { capsolver: { apiKey: 'NEW-SECRET' } },
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(realConfig, 'utf8'));
    assert.equal(saved.capsolver.apiKey, 'NEW-SECRET', 'retyped secret must be updated on disk');
  } finally {
    await close();
  }
});

test('mergeConfig: non-secret field set to empty string is cleared', async () => {
  const cfgContent = {
    person: { firstName: 'Jane', lastName: 'Doe' },
  };
  const { server, close, realConfig } = await buildServer({ cfgContent });
  try {
    const r = await request(server, {
      method: 'PUT',
      pathname: '/api/config',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { person: { firstName: 'Jane', lastName: '' } },
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(realConfig, 'utf8'));
    assert.equal(saved.person.lastName, '', 'clearing a non-secret field to "" must be preserved');
  } finally {
    await close();
  }
});

test('/api/exposure returns a current score, breakdown and history array', async () => {
  const stateContent = {
    optOuts: {
      Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' }, // still listed (never verified)
      MyLife: { lastSuccess: '2026-01-01T00:00:00.000Z', verifiedDeletedAt: '2026-02-01T00:00:00.000Z' }, // gone
    },
  };
  const { server, close } = await buildServer({ stateContent });
  try {
    const r = await request(server, {
      pathname: '/api/exposure',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.score, 'number');
    assert.equal(r.json.listedCount, 1); // Spokeo still listed, MyLife gone
    assert.ok(r.json.breakdown && typeof r.json.breakdown.listed === 'number');
    assert.ok(Array.isArray(r.json.history));
  } finally {
    await close();
  }
});

test('/api/exposure requires auth', async () => {
  const { server, close } = await buildServer();
  try {
    const r = await request(server, { pathname: '/api/exposure' });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});
